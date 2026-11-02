import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { ImageSize } from "./core.js";
import { imageContentType, verifyImage, type ImageDimensions, type ImageFormat } from "./image.js";
import { METAPLATE_VERSION } from "./version.js";

/** Fixed request identity; no caller-supplied headers are ever sent. */
export const REMOTE_USER_AGENT = `metaplate-verify/${METAPLATE_VERSION}`;

/** Defaults for every remote fetch limit. */
export const REMOTE_FETCH_DEFAULTS = Object.freeze({
  maxRedirects: 3,
  maxBytes: 16 * 1024 * 1024,
  timeoutMs: 10_000,
  connectionTimeoutMs: 10_000,
});

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
  /** Budget for each individual connection, from connect to body end. Default 10 s. */
  connectionTimeoutMs?: number;
  /**
   * Replaces `dns.lookup(hostname, { all: true })`. Every returned address is
   * still checked, and the connection is made to a checked address directly,
   * so the resolver is consulted exactly once per hop.
   */
  resolve?: RemoteResolver;
};

export type RemoteImageErrorCode =
  | "invalid-url"
  | "scheme"
  | "credentials"
  | "port"
  | "dns"
  | "address"
  | "redirect"
  | "too-many-redirects"
  | "status"
  | "byte-limit"
  | "timeout"
  | "network"
  | "content-type";

/** A refused or failed remote fetch, with a stable machine-readable code. */
export class RemoteImageError extends Error {
  readonly code: RemoteImageErrorCode;
  /** The URL being fetched when the failure happened. */
  readonly url: string;
  /** The HTTP status that was refused, for the `status` code. */
  readonly status?: number;

  constructor(code: RemoteImageErrorCode, message: string, url: string, status?: number) {
    super(message);
    this.name = "RemoteImageError";
    this.code = code;
    this.url = url;
    if (status !== undefined) this.status = status;
  }
}

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
// Address policy

type Cidr = Readonly<{ bytes: readonly number[]; bits: number; kind: string }>;

function ipv4Bytes(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return undefined;
  const bytes = parts.map(Number);
  return bytes.every((byte) => byte <= 255) ? bytes : undefined;
}

function ipv6Bytes(address: string): number[] | undefined {
  let text = address.split("%", 1)[0]!.toLowerCase();
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const tail = ipv4Bytes(text.slice(lastColon + 1));
    if (!tail) return undefined;
    const high = (tail[0]! * 0x100 + tail[1]!).toString(16);
    const low = (tail[2]! * 0x100 + tail[3]!).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function cidr(notation: string, kind: string): Cidr {
  const [address, bits] = notation.split("/") as [string, string];
  const bytes = address.includes(":") ? ipv6Bytes(address) : ipv4Bytes(address);
  if (!bytes) throw new Error(`Invalid CIDR ${notation}`);
  return Object.freeze({ bytes, bits: Number(bits), kind });
}

function contains(range: Cidr, bytes: readonly number[]): boolean {
  if (range.bytes.length !== bytes.length) return false;
  for (let bit = 0; bit < range.bits; bit += 8) {
    const width = Math.min(8, range.bits - bit);
    const mask = (0xff << (8 - width)) & 0xff;
    const index = bit / 8;
    if ((bytes[index]! & mask) !== (range.bytes[index]! & mask)) return false;
  }
  return true;
}

const IPV4_BLOCKED: readonly Cidr[] = [
  cidr("0.0.0.0/8", "unspecified"),
  cidr("10.0.0.0/8", "private"),
  cidr("100.64.0.0/10", "shared (carrier-grade NAT)"),
  cidr("127.0.0.0/8", "loopback"),
  cidr("169.254.0.0/16", "link-local"),
  cidr("172.16.0.0/12", "private"),
  cidr("192.0.0.0/24", "IETF protocol assignment"),
  cidr("192.168.0.0/16", "private"),
  cidr("198.18.0.0/15", "benchmarking"),
  cidr("224.0.0.0/4", "multicast"),
  cidr("240.0.0.0/4", "reserved or broadcast"),
];

const IPV6_BLOCKED: readonly Cidr[] = [
  cidr("::/128", "unspecified"),
  cidr("::1/128", "loopback"),
  cidr("fc00::/7", "unique-local"),
  cidr("fe80::/10", "link-local"),
  cidr("fec0::/10", "site-local"),
  cidr("ff00::/8", "multicast"),
];

/** IPv6 forms that carry an IPv4 address, and the byte offset it starts at. */
const IPV6_EMBEDDING: readonly (readonly [Cidr, number])[] = [
  [cidr("::ffff:0:0/96", "IPv4-mapped"), 12],
  [cidr("::/96", "IPv4-compatible"), 12],
  [cidr("::ffff:0:0:0/96", "IPv4-translated"), 12],
  [cidr("64:ff9b::/96", "NAT64"), 12],
  [cidr("2002::/16", "6to4"), 2],
];

/**
 * Describes why an address is not publicly routable, or returns `undefined`
 * for a public address. Unparseable input is treated as not public.
 */
export function nonPublicAddressKind(address: string): string | undefined {
  const family = isIP(address.split("%", 1)[0]!);
  if (family === 4) {
    const bytes = ipv4Bytes(address)!;
    return IPV4_BLOCKED.find((range) => contains(range, bytes))?.kind;
  }
  const bytes = family === 6 ? ipv6Bytes(address) : undefined;
  if (!bytes) return "unparseable";
  const direct = IPV6_BLOCKED.find((range) => contains(range, bytes));
  if (direct) return direct.kind;
  for (const [range, offset] of IPV6_EMBEDDING) {
    if (!contains(range, bytes)) continue;
    const embedded = bytes.slice(offset, offset + 4).join(".");
    const kind = nonPublicAddressKind(embedded);
    if (kind) return `${range.kind} ${kind}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Option and URL policy

function positiveInteger(name: string, value: number | undefined, fallback: number, minimum = 1): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer of at least ${minimum}; received ${value}`);
  }
  return value;
}

function settingsFrom(options: RemoteFetchOptions, truncate: boolean): Settings {
  for (const port of options.allowedPorts ?? []) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new TypeError(`allowedPorts entries must be integers from 1 to 65535; received ${port}`);
    }
  }
  const timeoutMs = positiveInteger("timeoutMs", options.timeoutMs, REMOTE_FETCH_DEFAULTS.timeoutMs);
  return {
    truncate,
    allowPrivate: options.allowPrivate === true,
    allowedPorts: new Set(options.allowedPorts ?? []),
    maxRedirects: positiveInteger("maxRedirects", options.maxRedirects, REMOTE_FETCH_DEFAULTS.maxRedirects, 0),
    maxBytes: positiveInteger("maxBytes", options.maxBytes, REMOTE_FETCH_DEFAULTS.maxBytes),
    timeoutMs,
    connectionTimeoutMs: Math.min(
      timeoutMs,
      positiveInteger("connectionTimeoutMs", options.connectionTimeoutMs, REMOTE_FETCH_DEFAULTS.connectionTimeoutMs),
    ),
    resolve: options.resolve ?? ((hostname) => lookup(hostname, { all: true })),
  };
}

function defaultPort(url: URL): number {
  return url.protocol === "https:" ? 443 : 80;
}

function effectivePort(url: URL): number {
  return url.port === "" ? defaultPort(url) : Number(url.port);
}

function bareHostname(url: URL): string {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

/**
 * Applies the credential, scheme, and port policy to one hop. Credentials are
 * checked first so no later message ever echoes them.
 */
function checkUrl(url: URL, settings: Settings, label: string): void {
  if (url.username !== "" || url.password !== "") {
    throw new RemoteImageError(
      "credentials",
      `${label} ${url.protocol}//${url.host} embeds credentials; URLs with user information are refused`,
      `${url.protocol}//${url.host}${url.pathname}`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RemoteImageError(
      "scheme",
      `${label} ${url.href} uses ${url.protocol}; only http: and https: are fetched`,
      url.href,
    );
  }
  const port = effectivePort(url);
  if (port !== defaultPort(url) && !settings.allowedPorts.has(port)) {
    throw new RemoteImageError(
      "port",
      `${label} ${url.href} uses port ${port}; only the scheme default is allowed unless the port is explicitly allowed`,
      url.href,
    );
  }
}

function parseUrl(input: string, base: URL | undefined, label: string): URL {
  try {
    return new URL(input, base);
  } catch {
    throw new RemoteImageError("invalid-url", `${label} ${JSON.stringify(input)} is not a valid URL`, input);
  }
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
      const chunks: Buffer[] = [];
      let received = 0;
      const body = (truncated: boolean) => ({
        kind: "body" as const,
        status,
        contentType: response.headers["content-type"],
        bytes: new Uint8Array(Buffer.concat(chunks, received)),
        truncated,
      });
      response.on("data", (chunk: Buffer) => {
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
      response.on("end", () => succeed(body(false)));
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
 * redirect, byte, and time limit is applied identically. With `truncate`, a
 * body larger than `maxBytes` is cut to its first `maxBytes` bytes (and
 * marked `truncated`) instead of failing, which is how a robots.txt parser
 * applies its parsing limit.
 */
export async function fetchRemoteResourceVia(
  input: string | URL,
  options: RemoteFetchOptions,
  dial: RemoteDialer,
  accept: string,
  truncate = false,
): Promise<RemoteImage & { truncated?: true }> {
  const settings = settingsFrom(options, truncate);
  const requested = parseUrl(String(input), undefined, "URL");
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const redirects: string[] = [];
    let current = requested;
    for (;;) {
      checkUrl(current, settings, redirects.length === 0 ? "URL" : "Redirect to");
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
