import { METAPLATE_VERSION } from "./version.js";

/**
 * Not an entry point: the remote-fetch policy that needs no Node built-ins,
 * shared by the Node fetcher (`metaplate/assets`, `metaplate verify-url`) and
 * the Fetch API loader in `metaplate/image`, so both refuse the same URLs,
 * ports, and addresses with the same errors.
 */

/** Fixed request identity; no caller-supplied headers are ever sent. */
export const REMOTE_USER_AGENT = `metaplate-verify/${METAPLATE_VERSION}`;

/** Defaults for every remote fetch limit. */
export const REMOTE_FETCH_DEFAULTS = Object.freeze({
  maxRedirects: 3,
  maxBytes: 16 * 1024 * 1024,
  timeoutMs: 10_000,
  connectionTimeoutMs: 10_000,
});

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
  | "content-type"
  | "origin";

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

// ---------------------------------------------------------------------------
// Address policy

type Cidr = Readonly<{ bytes: readonly number[]; bits: number; kind: string }>;

/** Dotted-quad IPv4 whose octets have no leading zeros, as `node:net`'s `isIP` requires. */
const IPV4_LITERAL = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * 4 or 6 for an IP address literal, 0 otherwise, as `node:net`'s `isIP`
 * reports it, without `node:net`: dotted-quad IPv4 without leading zeros,
 * or IPv6 without a zone.
 */
export function ipFamily(address: string): 0 | 4 | 6 {
  if (IPV4_LITERAL.test(address)) return 4;
  return address.includes(":") && ipv6Bytes(address) ? 6 : 0;
}

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

// Every block the IANA special-purpose registries mark "Globally Reachable:
// False" is refused, along with multicast and the deprecated blocks the
// registries list without flags. Sources, last updated 2025-10-09:
//   https://www.iana.org/assignments/iana-ipv4-special-registry/
//   https://www.iana.org/assignments/iana-ipv6-special-registry/
// Where a refused block contains a more specific allocation the registry marks
// "Globally Reachable: True", that allocation is listed in the matching
// *_REACHABLE table and wins over the wider block.

const IPV4_BLOCKED: readonly Cidr[] = [
  cidr("0.0.0.0/8", "unspecified"),
  cidr("10.0.0.0/8", "private"),
  cidr("100.64.0.0/10", "shared (carrier-grade NAT)"),
  cidr("127.0.0.0/8", "loopback"),
  cidr("169.254.0.0/16", "link-local"),
  cidr("172.16.0.0/12", "private"),
  cidr("192.0.0.0/24", "IETF protocol assignment"),
  cidr("192.0.2.0/24", "documentation"),
  cidr("192.88.99.0/24", "deprecated 6to4 relay anycast"),
  cidr("192.168.0.0/16", "private"),
  cidr("198.18.0.0/15", "benchmarking"),
  cidr("198.51.100.0/24", "documentation"),
  cidr("203.0.113.0/24", "documentation"),
  cidr("224.0.0.0/4", "multicast"),
  cidr("240.0.0.0/4", "reserved or broadcast"),
];

/** Globally reachable allocations inside a block of `IPV4_BLOCKED`. */
const IPV4_REACHABLE: readonly Cidr[] = [
  cidr("192.0.0.9/32", "Port Control Protocol anycast"),
  cidr("192.0.0.10/32", "TURN anycast"),
];

const IPV6_BLOCKED: readonly Cidr[] = [
  cidr("::/128", "unspecified"),
  cidr("::1/128", "loopback"),
  cidr("64:ff9b:1::/48", "local-use NAT64"),
  cidr("100::/64", "discard-only"),
  cidr("100:0:0:1::/64", "dummy"),
  cidr("2001::/32", "Teredo"),
  cidr("2001::/23", "IETF protocol assignment"),
  cidr("2001:db8::/32", "documentation"),
  cidr("3fff::/20", "documentation"),
  cidr("5f00::/16", "segment routing SID"),
  cidr("fc00::/7", "unique-local"),
  cidr("fe80::/10", "link-local"),
  cidr("fec0::/10", "site-local"),
  cidr("ff00::/8", "multicast"),
];

/** Globally reachable allocations inside a block of `IPV6_BLOCKED`. */
const IPV6_REACHABLE: readonly Cidr[] = [
  cidr("2001:1::1/128", "Port Control Protocol anycast"),
  cidr("2001:1::2/128", "TURN anycast"),
  cidr("2001:1::3/128", "DNS-SD service registration anycast"),
  cidr("2001:3::/32", "AMT"),
  cidr("2001:4:112::/48", "AS112-v6"),
  cidr("2001:20::/28", "ORCHIDv2"),
  cidr("2001:30::/28", "drone remote ID entity tags"),
];

function blockedKind(bytes: readonly number[], blocked: readonly Cidr[], reachable: readonly Cidr[]): string | undefined {
  if (reachable.some((range) => contains(range, bytes))) return undefined;
  return blocked.find((range) => contains(range, bytes))?.kind;
}

/** IPv6 forms that carry an IPv4 address, and the byte offset it starts at. */
const IPV6_EMBEDDING: readonly (readonly [Cidr, number])[] = [
  [cidr("::ffff:0:0/96", "IPv4-mapped"), 12],
  [cidr("::/96", "IPv4-compatible"), 12],
  [cidr("::ffff:0:0:0/96", "IPv4-translated"), 12],
  [cidr("64:ff9b::/96", "NAT64"), 12],
  [cidr("2002::/16", "6to4"), 2],
];

/**
 * Describes why an address is not globally reachable, or returns `undefined`
 * for a public address. IPv4 addresses carried in IPv4-mapped, IPv4-compatible,
 * IPv4-translated, NAT64 (64:ff9b::/96), and 6to4 forms are checked as the
 * IPv4 address they carry. Unparseable input is treated as not public.
 */
export function nonPublicAddressKind(address: string): string | undefined {
  const family = ipFamily(address.split("%", 1)[0]!);
  if (family === 4) {
    const bytes = ipv4Bytes(address)!;
    return blockedKind(bytes, IPV4_BLOCKED, IPV4_REACHABLE);
  }
  const bytes = family === 6 ? ipv6Bytes(address) : undefined;
  if (!bytes) return "unparseable";
  const direct = blockedKind(bytes, IPV6_BLOCKED, IPV6_REACHABLE);
  if (direct) return direct;
  for (const [range, offset] of IPV6_EMBEDDING) {
    if (!contains(range, bytes)) continue;
    const embedded = bytes.slice(offset, offset + 4).join(".");
    const kind = nonPublicAddressKind(embedded);
    if (kind) return `${range.kind} ${kind}`;
  }
  return undefined;
}


export function defaultPort(url: URL): number {
  return url.protocol === "https:" ? 443 : 80;
}

export function effectivePort(url: URL): number {
  return url.port === "" ? defaultPort(url) : Number(url.port);
}

export function bareHostname(url: URL): string {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

/**
 * Applies the credential, scheme, and port policy to one hop. Credentials are
 * checked first so no later message ever echoes them.
 */
export function checkUrl(url: URL, allowedPorts: ReadonlySet<number>, label: string): void {
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
  if (port !== defaultPort(url) && !allowedPorts.has(port)) {
    throw new RemoteImageError(
      "port",
      `${label} ${url.href} uses port ${port}; only the scheme default is allowed unless the port is explicitly allowed`,
      url.href,
    );
  }
}

export function parseUrl(input: string, base: URL | undefined, label: string): URL {
  try {
    return new URL(input, base);
  } catch {
    throw new RemoteImageError("invalid-url", `${label} ${JSON.stringify(input)} is not a valid URL`, input);
  }
}

// ---------------------------------------------------------------------------
// Image loader policy

/**
 * Parses a remote image loader's required `origins` allowlist into bare
 * origins. A path, query, fragment, or credentials in an entry is rejected
 * rather than silently ignored.
 */
export function allowedOrigins(origins: readonly (string | URL)[] | undefined, loader: string): ReadonlySet<string> {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new TypeError(
      `${loader} needs an origins allowlist, such as origins: ["https://cdn.example.com"]`,
    );
  }
  const allowed = new Set<string>();
  for (const entry of origins as readonly (string | URL)[]) {
    let url: URL;
    try {
      url = new URL(String(entry));
    } catch {
      throw new TypeError(`origins entry ${JSON.stringify(String(entry))} is not a URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError(`origins entry ${url.href} must use http: or https:`);
    }
    if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      throw new TypeError(
        `origins entries must be bare origins such as https://cdn.example.com; received ${JSON.stringify(String(entry))}`,
      );
    }
    allowed.add(url.origin);
  }
  return allowed;
}

/** A hop check that refuses any URL off the allowlist, redirects included. */
export function originCheck(allowed: ReadonlySet<string>): (url: URL, label: string) => void {
  return (url, label) => {
    if (!allowed.has(url.origin)) {
      throw new RemoteImageError(
        "origin",
        `${label} ${url.href} is not on an allowed origin (${[...allowed].join(", ")})`,
        url.href,
      );
    }
  };
}

/** Validates a loader's `cacheSize`, or returns `fallback` when it is unset. */
export function cacheSizeFrom(cacheSize: number | undefined, fallback: number): number {
  if (cacheSize === undefined) return fallback;
  if (!Number.isSafeInteger(cacheSize) || cacheSize < 0) {
    throw new TypeError(`cacheSize must be a non-negative integer; received ${cacheSize}`);
  }
  return cacheSize;
}

/**
 * Memoizes `load` by normalized URL in a bounded cache, oldest evicted first.
 * Concurrent loads of one URL share a promise, and a failed load is dropped so
 * the next call retries. `capacity` 0 disables the cache.
 */
export function memoizeByUrl<T>(capacity: number, load: (input: string | URL) => Promise<T>): (input: string | URL) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (input) => {
    let key: string;
    try {
      key = new URL(String(input)).href;
    } catch {
      // The fetcher reports the unparseable URL with its stable error code.
      return load(input);
    }
    if (capacity === 0) return load(key);
    const cached = cache.get(key);
    if (cached) return cached;
    const loaded = load(key);
    loaded.catch(() => {
      if (cache.get(key) === loaded) cache.delete(key);
    });
    if (cache.size >= capacity) cache.delete(cache.keys().next().value!);
    cache.set(key, loaded);
    return loaded;
  };
}
