import {
  IMAGE_ASSET_DEFAULTS,
  assertImageAssetOptions,
  imageAsset,
  type ImageAsset,
  type ImageAssetOptions,
} from "./asset.js";
import {
  REMOTE_FETCH_DEFAULTS,
  REMOTE_USER_AGENT,
  RemoteImageError,
  allowedOrigins,
  bareHostname,
  cacheSizeFrom,
  checkUrl,
  ipFamily,
  memoizeByUrl,
  nonPublicAddressKind,
  originCheck,
  parseUrl,
} from "../core/remote-policy.js";

/**
 * Not an entry point: `fetchImageLoader`, the Fetch API counterpart of
 * `remoteImageLoader` from `metaplate/assets`. It needs no Node built-ins, so
 * `metaplate/image` keeps working on Cloudflare Workers, Deno, Netlify Edge,
 * and Vercel Edge.
 */

/** Defaults for `fetchImageLoader`. */
export const FETCH_IMAGE_LOADER_DEFAULTS = Object.freeze({
  /** Images kept in memory; the oldest is evicted first. */
  cacheSize: 64,
  /** Largest image fetched, enforced while streaming. */
  maxBytes: IMAGE_ASSET_DEFAULTS.maxBytes,
  /** Redirects followed, each re-checked, before failing. */
  maxRedirects: REMOTE_FETCH_DEFAULTS.maxRedirects,
  /** Budget for the whole fetch, every redirect included. */
  timeoutMs: REMOTE_FETCH_DEFAULTS.timeoutMs,
});

export type FetchImageLoaderOptions = ImageAssetOptions & {
  /**
   * The only origins images are fetched from, such as
   * `["https://cdn.example.com"]`. Required: every request and every
   * redirect hop must stay on one of them. Entries are bare origins; a path,
   * query, or credentials is rejected rather than silently ignored.
   */
  origins: readonly (string | URL)[];
  /**
   * Images memoized per loader, by URL, oldest evicted first. Defaults to 64;
   * `0` disables the cache. Failed loads are never cached.
   */
  cacheSize?: number;
  /**
   * Permits URLs whose host is a loopback, private, link-local, or other
   * non-public IP address, or a `localhost` name. Intended only for local
   * development against a server you control.
   */
  allowPrivate?: boolean;
  /** Ports allowed in addition to the scheme default (80 for http, 443 for https). */
  allowedPorts?: readonly number[];
  /** Redirects followed before failing. Every hop is re-checked. Default 3. */
  maxRedirects?: number;
  /** Budget for the whole fetch, including every redirect. Default 10 s. */
  timeoutMs?: number;
  /**
   * The `fetch` to call, such as a Cloudflare service binding's, wrapped so it
   * keeps its binding: `(url, init) => env.IMAGES.fetch(url, init)`. Defaults to
   * the runtime's global `fetch`. It must honor `redirect: "manual"` by
   * returning the 3xx response with its `Location` header, as Workers, Deno,
   * Node.js, and Bun do.
   */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
};

/** Loads one image URL as an `imageAsset`, memoized per loader. */
export type FetchImageLoader = (url: string | URL) => Promise<ImageAsset>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function wholeNumber(name: string, value: number | undefined, minimum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer of at least ${minimum}; received ${value}`);
  }
  return value;
}

function portSet(ports: readonly number[] | undefined): ReadonlySet<number> {
  for (const port of ports ?? []) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new TypeError(`allowedPorts entries must be integers from 1 to 65535; received ${port}`);
    }
  }
  return new Set(ports ?? []);
}

/**
 * Refuses a host that names a non-public address. Fetch runtimes expose no
 * DNS lookup, so only IP literals and `localhost` names can be checked; a
 * hostname is trusted to resolve as its allowlisted origin intends.
 */
function checkHost(url: URL, label: string): void {
  const host = bareHostname(url).toLowerCase();
  // `localhost.` is the same name as `localhost`, written fully qualified.
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  const kind = ipFamily(host) === 0
    ? name === "localhost" || name.endsWith(".localhost") ? "loopback name" : undefined
    : nonPublicAddressKind(host);
  if (kind) {
    throw new RemoteImageError(
      "address",
      `Refusing ${label === "URL" ? "" : "redirect to "}${url.href}: ${host} is a ${kind} address. ` +
        "Non-public addresses are only fetched with allowPrivate, for local development",
      url.href,
    );
  }
}

/** Reads a body, failing as soon as it passes `maxBytes`. */
async function readCapped(response: Response, url: URL, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new RemoteImageError(
      "byte-limit",
      `${url.href} returned more than the ${maxBytes}-byte limit (at least ${declared} bytes)`,
      url.href,
    );
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new RemoteImageError(
        "byte-limit",
        `${url.href} returned more than the ${maxBytes}-byte limit (at least ${received} bytes)`,
        url.href,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Loads remote images, such as per-page avatars or covers, for an `async`
 * plate component on any runtime with the Fetch API, Cloudflare Workers
 * included. It applies `remoteImageLoader`'s policy wherever a fetch runtime
 * allows: only `origins`, on http(s) and the scheme's default or an allowed
 * port, no credentials in URLs, every redirect followed by hand and
 * re-checked against the policy and the allowlist, a byte cap enforced while
 * the body streams, one time budget for the whole fetch, and the bytes
 * checked with `imageAsset`. Each URL is memoized in a bounded cache.
 *
 * Fetch runtimes resolve DNS out of sight, so where `remoteImageLoader` checks
 * every address a hostname resolves to, this loader can refuse only hosts
 * written as non-public IP addresses or `localhost` names. The required
 * allowlist is the boundary: list only origins whose hostnames you trust.
 * Failures reject with `RemoteImageError` (code `"origin"` for a URL or
 * redirect off the allowlist) or the `imageAsset` error, prefixed with the URL.
 */
export function fetchImageLoader(options: FetchImageLoaderOptions): FetchImageLoader {
  const allowed = allowedOrigins(options.origins, "fetchImageLoader");
  const capacity = cacheSizeFrom(options.cacheSize, FETCH_IMAGE_LOADER_DEFAULTS.cacheSize);
  const maxBytes = options.maxBytes ?? FETCH_IMAGE_LOADER_DEFAULTS.maxBytes;
  const assetOptions: ImageAssetOptions = {
    maxBytes,
    ...(options.formats === undefined ? {} : { formats: options.formats }),
  };
  assertImageAssetOptions(assetOptions);
  const maxRedirects = wholeNumber("maxRedirects", options.maxRedirects, 0, FETCH_IMAGE_LOADER_DEFAULTS.maxRedirects);
  const timeoutMs = wholeNumber("timeoutMs", options.timeoutMs, 1, FETCH_IMAGE_LOADER_DEFAULTS.timeoutMs);
  const ports = portSet(options.allowedPorts);
  const allowPrivate = options.allowPrivate === true;
  const checkOrigin = originCheck(allowed);
  const fetchImpl = options.fetch;
  if (fetchImpl !== undefined && typeof fetchImpl !== "function") {
    throw new TypeError("fetch must be a function");
  }

  async function exchange(url: URL, signal: AbortSignal): Promise<Response> {
    try {
      return await (fetchImpl ?? fetch)(url.href, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { Accept: "image/*", "User-Agent": REMOTE_USER_AGENT },
      });
    } catch (error) {
      if (signal.aborted) {
        throw new RemoteImageError("timeout", `Fetching ${url.href} exceeded the ${timeoutMs} ms total time budget`, url.href);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new RemoteImageError("network", `Request to ${url.origin} failed: ${reason}`, url.href);
    }
  }

  async function load(input: string | URL): Promise<ImageAsset> {
    const requested = parseUrl(String(input), undefined, "URL");
    const controller = new AbortController();
    let current = requested;
    const timedOut = () =>
      new RemoteImageError("timeout", `Fetching ${current.href} exceeded the ${timeoutMs} ms total time budget`, current.href);
    // The budget also settles the load itself, so an injected fetch that ignores
    // its signal, or a body stream not tied to it, cannot hang the load (and,
    // through the cache, every later load of the same URL).
    let budget: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      budget = setTimeout(() => {
        controller.abort();
        reject(timedOut());
      }, timeoutMs);
    });
    const attempt = async (): Promise<ImageAsset> => {
      for (let redirects = 0; ; redirects += 1) {
        const label = redirects === 0 ? "URL" : "Redirect to";
        checkUrl(current, ports, label);
        checkOrigin(current, label);
        if (!allowPrivate) checkHost(current, label);
        const response = await exchange(current, controller.signal);
        if (response.type === "opaqueredirect") {
          throw new RemoteImageError(
            "redirect",
            `${current.href} redirected, and this runtime's fetch hides the target, so it cannot be re-checked`,
            current.href,
          );
        }
        if (REDIRECT_STATUSES.has(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get("location");
          if (!location) {
            throw new RemoteImageError("redirect", `${current.href} responded ${response.status} without a Location header`, current.href);
          }
          if (redirects >= maxRedirects) {
            throw new RemoteImageError("too-many-redirects", `${requested.href} redirected more than ${maxRedirects} times`, current.href);
          }
          current = parseUrl(location, current, "Redirect to");
          continue;
        }
        if (response.status < 200 || response.status > 299) {
          await response.body?.cancel();
          throw new RemoteImageError(
            "status",
            `${current.href} responded ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
            current.href,
            response.status,
          );
        }
        const bytes = await readCapped(response, current, maxBytes);
        try {
          return imageAsset(bytes, assetOptions);
        } catch (error) {
          if (error instanceof Error) error.message = `${current.href}: ${error.message}`;
          throw error;
        }
      }
    };
    const running = attempt();
    // After the budget wins the race, a late failure of the attempt is expected.
    running.catch(() => {});
    try {
      return await Promise.race([running, expired]);
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof RemoteImageError)) throw timedOut();
      throw error;
    } finally {
      clearTimeout(budget);
    }
  }

  return memoizeByUrl(capacity, load);
}
