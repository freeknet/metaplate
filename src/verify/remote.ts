import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { ImageSize } from "../core/social-image.js";
import { imageContentType, verifyImage, type ImageDimensions, type ImageFormat } from "../image.js";
import { integerOption } from "../core/internal.js";
import {
  REMOTE_FETCH_DEFAULTS,
  REMOTE_USER_AGENT,
  RemoteImageError,
  bareHostname,
  checkUrl,
  effectivePort,
  nonPublicAddressKind,
  parseUrl,
} from "../core/remote-policy.js";

export {
  REMOTE_FETCH_DEFAULTS,
  REMOTE_USER_AGENT,
  RemoteImageError,
  nonPublicAddressKind,
  type RemoteImageErrorCode,
} from "../core/remote-policy.js";

/** One resolved address, shaped like `dns.lookup({ all: true })` output. */
export type RemoteAddress = Readonly<{ address: string; family: number }>;

/** Resolves a hostname to every address it may connect to. */
export type RemoteResolver = (hostname: string) => Promise<readonly RemoteAddress[]>;

export type RemoteFetchOptions = {
  /**
   * Permits loopback, private, link-local, unique-local, and other
   * non-public addresses. Intended only for local development against a
   * server you control, such as `http://127.0.0.1:3000`.
   */
  allowPrivate?: boolean;
  /** Ports allowed in addition to the scheme default (80 for http, 443 for https). */
  allowedPorts?: readonly number[];
  /** Redirects followed before failing. Every hop is re-checked. Default 3. */
  maxRedirects?: number;
  /** Largest response body accepted, enforced while streaming. Default 16 MiB. */
  maxBytes?: number;
  /** Budget for the whole fetch, including DNS and every redirect. Default 10 s. */
  timeoutMs?: number;
  /**
   * Budget for each individual connection, from connect to body end, at most
   * `timeoutMs`. Defaults to `timeoutMs` (10 s when that is unset too).
   */
  connectionTimeoutMs?: number;
  /**
   * Replaces `dns.lookup(hostname, { all: true })`. Every returned address is
   * still checked, and the connection is made to a checked address directly,
   * so the resolver is consulted exactly once per hop.
   */
  resolve?: RemoteResolver;
};


export type RemoteImage = Readonly<{
  /** The requested URL, normalized. */
  url: string;
  /** The URL whose response supplied the bytes, after redirects. */
  finalUrl: string;
  /** Each redirect target in order; empty when none were followed. */
  redirects: readonly string[];
  /** The checked address the final connection was made to. */
  address: string;
  status: number;
  /** The final response's `Content-Type` header, verbatim. */
  contentType: string | undefined;
  bytes: Uint8Array;
  byteLength: number;
}>;

export type RemoteImageVerification = RemoteImage & Readonly<{ image: ImageDimensions }>;

/** Expected image facts for `verifyRemoteImage`, mirroring `verifyImage`. */
export type RemoteImageExpectation = ImageSize & { format?: ImageFormat };

type Settings = {
  /** Keep the first `maxBytes` bytes of a larger body instead of failing. */
  truncate: boolean;
  allowPrivate: boolean;
  allowedPorts: ReadonlySet<number>;
  maxRedirects: number;
  maxBytes: number;
  timeoutMs: number;
  connectionTimeoutMs: number;
  resolve: RemoteResolver;
};

/** Maps a checked address to the address actually dialed. Identity outside tests. */
export type RemoteDialer = (address: RemoteAddress) => RemoteAddress;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ---------------------------------------------------------------------------
// Option and URL policy

/** Per-call options for `fetchRemoteResourceVia`. */
export type RemoteResourceOptions = Readonly<{
  /** A caller policy run on every hop before any DNS lookup. */
  checkHop?: (url: URL, label: string) => void;
  /** Cut an oversized body at `maxBytes` instead of failing. */
  truncate?: boolean;
}>;

function settingsFrom(options: RemoteFetchOptions, truncate: boolean): Settings {
  for (const port of options.allowedPorts ?? []) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new TypeError(`allowedPorts entries must be integers from 1 to 65535; received ${port}`);
    }
  }
  const timeoutMs = integerOption("timeoutMs", options.timeoutMs, 1) ?? REMOTE_FETCH_DEFAULTS.timeoutMs;
  return {
    truncate,
    allowPrivate: options.allowPrivate === true,
    allowedPorts: new Set(options.allowedPorts ?? []),
    maxRedirects: integerOption("maxRedirects", options.maxRedirects, 0) ?? REMOTE_FETCH_DEFAULTS.maxRedirects,
    maxBytes: integerOption("maxBytes", options.maxBytes, 1) ?? REMOTE_FETCH_DEFAULTS.maxBytes,
    timeoutMs,
    connectionTimeoutMs: Math.min(
      timeoutMs,
      // Unset, it follows timeoutMs, so raising the total budget (the CLI's
      // --timeout) also lets one slow connection use it.
      integerOption("connectionTimeoutMs", options.connectionTimeoutMs, 1) ?? timeoutMs,
    ),
    resolve: options.resolve ?? ((hostname) => lookup(hostname, { all: true })),
  };
}

/** Validates fetch options once, where a long-lived caller is defined. */
export function assertRemoteFetchOptions(options: RemoteFetchOptions): void {
  settingsFrom(options, false);
}


// ---------------------------------------------------------------------------
// Deadline plumbing

function timeoutError(url: URL, budget: number, scope: string): RemoteImageError {
  return new RemoteImageError("timeout", `Fetching ${url.href} exceeded the ${budget} ms ${scope}`, url.href);
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal, onAbort: () => Error): Promise<T> {
  if (signal.aborted) return Promise.reject(onAbort());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(onAbort());
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Resolves once, rejects if any address is non-public, and returns the one to dial. */
async function vetAddress(url: URL, settings: Settings, signal: AbortSignal): Promise<RemoteAddress> {
  const hostname = bareHostname(url);
  const literal = isIP(hostname);
  let addresses: readonly RemoteAddress[];
  if (literal !== 0) {
    addresses = [{ address: hostname, family: literal }];
  } else {
    try {
      addresses = await untilAborted(
        settings.resolve(hostname),
        signal,
        () => timeoutError(url, settings.timeoutMs, "total time budget"),
      );
    } catch (error) {
      if (error instanceof RemoteImageError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new RemoteImageError("dns", `Could not resolve ${hostname}: ${reason}`, url.href);
    }
  }
  const first = addresses[0];
  if (!first) {
    throw new RemoteImageError("dns", `Could not resolve ${hostname}: no addresses returned`, url.href);
  }
  if (!settings.allowPrivate) {
    for (const { address } of addresses) {
      const kind = nonPublicAddressKind(address);
      if (kind) {
        throw new RemoteImageError(
          "address",
          `Refusing ${url.href}: ${hostname} resolves to ${address}, a ${kind} address. ` +
            "Non-public addresses are only fetched with allowPrivate (--allow-private), for local development",
          url.href,
        );
      }
    }
  }
  return first;
}

// ---------------------------------------------------------------------------
// One HTTP exchange

/**
 * Decoders for the content codings a server may apply even though every
 * request asks for `identity` (an object stored compressed, for example).
 * Crawlers decode them, so the checks must read the decoded bytes too.
 */
const CONTENT_DECODERS: Readonly<Record<string, () => NodeJS.ReadWriteStream>> = {
  gzip: createGunzip,
  "x-gzip": createGunzip,
  deflate: createInflate,
  br: createBrotliDecompress,
};

type Exchange =
  | { kind: "redirect"; status: number; location: string | undefined }
  | { kind: "body"; status: number; contentType: string | undefined; bytes: Uint8Array; truncated: boolean };

function exchange(
  url: URL,
  dialed: RemoteAddress,
  settings: Settings,
  signal: AbortSignal,
  accept: string,
): Promise<Exchange> {
  return new Promise<Exchange>((resolve, reject) => {
    const hostname = bareHostname(url);
    const secure = url.protocol === "https:";
    const options: RequestOptions = {
      // Dial the checked address itself so nothing resolves the name again:
      // a DNS answer that changes between the check and the connect cannot
      // move the request. Host and SNI still carry the original name.
      host: dialed.address,
      family: dialed.family,
      port: effectivePort(url),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      // A fresh agent per hop: no pooled sockets, no shared proxy state.
      agent: false,
      headers: {
        Host: url.host,
        "User-Agent": REMOTE_USER_AGENT,
        Accept: accept,
        "Accept-Encoding": "identity",
        Connection: "close",
      },
      ...(secure && isIP(hostname) === 0 ? { servername: hostname } : {}),
    };

    let settled = false;
    const cleanup = () => {
      clearTimeout(connectionTimer);
      signal.removeEventListener("abort", onAbort);
    };
    const succeed = (result: Exchange) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      request.destroy();
      reject(error);
    };
    const onAbort = () => fail(timeoutError(url, settings.timeoutMs, "total time budget"));
    const connectionTimer = setTimeout(
      () => fail(timeoutError(url, settings.connectionTimeoutMs, "connection timeout")),
      settings.connectionTimeoutMs,
    );
    signal.addEventListener("abort", onAbort, { once: true });

    const byteLimit = (received: number) =>
      new RemoteImageError(
        "byte-limit",
        `${url.href} returned more than the ${settings.maxBytes}-byte limit (at least ${received} bytes)`,
        url.href,
      );

    const onResponse = (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status)) {
        response.destroy();
        succeed({ kind: "redirect", status, location: response.headers.location });
        return;
      }
      if (status !== 200) {
        response.destroy();
        fail(new RemoteImageError(
          "status",
          `${url.href} responded ${status}${response.statusMessage ? ` ${response.statusMessage}` : ""}`,
          url.href,
          status,
        ));
        return;
      }
      const declared = Number(response.headers["content-length"]);
      if (!settings.truncate && Number.isSafeInteger(declared) && declared > settings.maxBytes) {
        fail(byteLimit(declared));
        return;
      }
      // Undo each coding in reverse order of application. The byte limit
      // then applies to the decoded body, so a small compressed response
      // cannot expand past it.
      const codings = (response.headers["content-encoding"] ?? "")
        .split(",")
        .map((coding) => coding.trim().toLowerCase())
        .filter((coding) => coding !== "" && coding !== "identity");
      let stream: Readable = response;
      for (const coding of codings.reverse()) {
        const decoder = CONTENT_DECODERS[coding];
        if (decoder === undefined) {
          response.destroy();
          fail(new RemoteImageError(
            "network",
            `${url.href} was served with Content-Encoding: ${coding}, which cannot be decoded`,
            url.href,
          ));
          return;
        }
        const decoding = decoder();
        decoding.on("error", (error: Error) => fail(new RemoteImageError(
          "network",
          `${url.href} could not be decoded as Content-Encoding: ${coding}: ${error.message}`,
          url.href,
        )));
        stream = stream.pipe(decoding) as unknown as Readable;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      const body = (truncated: boolean) => ({
        kind: "body" as const,
        status,
        contentType: response.headers["content-type"],
        bytes: new Uint8Array(Buffer.concat(chunks, received)),
        truncated,
      });
      stream.on("data", (chunk: Buffer) => {
        if (received + chunk.byteLength > settings.maxBytes) {
          if (!settings.truncate) {
            fail(byteLimit(received + chunk.byteLength));
            return;
          }
          // Keep exactly the first maxBytes bytes and stop reading.
          chunks.push(chunk.subarray(0, settings.maxBytes - received));
          received = settings.maxBytes;
          succeed(body(true));
          response.destroy();
          return;
        }
        received += chunk.byteLength;
        chunks.push(chunk);
      });
      stream.on("end", () => succeed(body(false)));
      response.on("error", (error) => fail(networkError(url, error)));
      response.on("close", () => {
        if (!response.complete) {
          fail(new RemoteImageError("network", `${url.href} closed before the body completed`, url.href));
        }
      });
    };

    const request = (secure ? httpsRequest : httpRequest)(options, onResponse);
    request.on("error", (error) => fail(networkError(url, error)));
    request.end();
    if (signal.aborted) onAbort();
  });
}

function networkError(url: URL, error: Error): RemoteImageError {
  return new RemoteImageError("network", `Request to ${url.origin} failed: ${error.message}`, url.href);
}

// ---------------------------------------------------------------------------
// Public API

/** The `Accept` header sent for image fetches. */
export const REMOTE_IMAGE_ACCEPT = "image/*";

/**
 * Fetch seam used by the public functions. `dial` maps a checked address to
 * the one actually connected to; production callers use the identity.
 */
export function fetchRemoteImageVia(
  input: string | URL,
  options: RemoteFetchOptions,
  dial: RemoteDialer,
): Promise<RemoteImage> {
  return fetchRemoteResourceVia(input, options, dial, REMOTE_IMAGE_ACCEPT);
}

/**
 * The one hardened fetch loop behind every remote check. Only the `Accept`
 * header varies by caller; every scheme, credential, port, address,
 * redirect, byte, and time limit is applied identically. `hop.checkHop` adds
 * a caller policy (such as an origin allowlist) to every hop, redirects
 * included, after the built-in URL checks and before any DNS lookup. With
 * `hop.truncate`, a body larger than `maxBytes` is cut to its first
 * `maxBytes` bytes (and marked `truncated`) instead of failing, which is how
 * a robots.txt parser applies its parsing limit.
 */
export async function fetchRemoteResourceVia(
  input: string | URL,
  options: RemoteFetchOptions,
  dial: RemoteDialer,
  accept: string,
  hop: RemoteResourceOptions = {},
): Promise<RemoteImage & { truncated?: true }> {
  const settings = settingsFrom(options, hop.truncate === true);
  const checkHop = hop.checkHop;
  const requested = parseUrl(String(input), undefined, "URL");
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const redirects: string[] = [];
    let current = requested;
    for (;;) {
      const label = redirects.length === 0 ? "URL" : "Redirect to";
      checkUrl(current, settings.allowedPorts, label);
      checkHop?.(current, label);
      const address = await vetAddress(current, settings, controller.signal);
      const result = await exchange(current, dial(address), settings, controller.signal, accept);
      if (result.kind === "body") {
        return Object.freeze({
          url: requested.href,
          finalUrl: current.href,
          redirects: Object.freeze(redirects),
          address: address.address,
          status: result.status,
          contentType: result.contentType,
          bytes: result.bytes,
          byteLength: result.bytes.byteLength,
          ...(result.truncated ? { truncated: true as const } : {}),
        });
      }
      if (result.location === undefined || result.location === "") {
        throw new RemoteImageError(
          "redirect",
          `${current.href} responded ${result.status} without a Location header`,
          current.href,
        );
      }
      if (redirects.length >= settings.maxRedirects) {
        throw new RemoteImageError(
          "too-many-redirects",
          `${requested.href} redirected more than ${settings.maxRedirects} times`,
          current.href,
        );
      }
      current = parseUrl(result.location, current, "Redirect to");
      redirects.push(current.href);
    }
  } finally {
    clearTimeout(budget);
  }
}

/**
 * Fetches image bytes from an http(s) URL under a hardened policy: only
 * http/https on default or explicitly allowed ports, no embedded
 * credentials, every hop's resolved addresses checked and the checked address
 * dialed directly, at most `maxRedirects` re-checked redirects, a streaming
 * byte cap, total and per-connection timeouts, and no cookies or credentials
 * sent. Failures throw `RemoteImageError` with a stable `code`.
 */
export function fetchRemoteImage(input: string | URL, options: RemoteFetchOptions = {}): Promise<RemoteImage> {
  return fetchRemoteImageVia(input, options, (address) => address);
}

/** Checks that a response's `Content-Type` names the format its bytes actually are. */
export function assertRemoteContentType(remote: RemoteImage, format: ImageFormat): void {
  const expected = imageContentType(format);
  const actual = remote.contentType?.split(";", 1)[0]!.trim().toLowerCase();
  if (actual !== expected) {
    throw new RemoteImageError(
      "content-type",
      `${remote.finalUrl} is served as ${remote.contentType ?? "(no Content-Type)"}, but its bytes are ${format} (${expected})`,
      remote.finalUrl,
    );
  }
}

/**
 * Fetches a remote image with `fetchRemoteImage`, then verifies its bytes
 * with `verifyImage` and checks the response `Content-Type` against the
 * detected format.
 */
export async function verifyRemoteImage(
  input: string | URL,
  expected: RemoteImageExpectation,
  options: RemoteFetchOptions = {},
): Promise<RemoteImageVerification> {
  const remote = await fetchRemoteImage(input, options);
  const image = verifyImage(remote.bytes, expected, expected.format);
  assertRemoteContentType(remote, image.format);
  return Object.freeze({ ...remote, image });
}
