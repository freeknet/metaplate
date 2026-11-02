import { taggedSerialize } from "../core/stable-hash.js";

/**
 * Not an entry point: the runtime render cache behind `plate.cached()` in
 * `metaplate/node` and `metaplate/edge`, and `memoryRenderCache`. Web-platform
 * only (no Node built-ins), so the edge bundle can include it unchanged.
 */

/** One cached render: the encoded bytes and what a response says about them. */
export type RenderCacheEntry = {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** The strong ETag of `bytes`: their quoted lowercase hex SHA-256. */
  readonly etag: string;
  /** Milliseconds since the epoch after which the entry is a miss; absent when it never expires. */
  readonly expires?: number | undefined;
};

/**
 * Where cached renders live. `get` returns `undefined` for a miss. Both may be
 * synchronous or asynchronous, so a KV namespace, Redis, or any other store
 * adapts with a few lines. Entries are checked on the way out, so a store
 * that ignores `expires` or returns damaged bytes costs a re-render, never a
 * wrong image.
 */
export type RenderCacheStore = {
  get(key: string): RenderCacheEntry | undefined | Promise<RenderCacheEntry | undefined>;
  set(key: string, entry: RenderCacheEntry): void | Promise<void>;
};

export type MemoryRenderCacheOptions = {
  /** Total encoded bytes kept before the least recently used entries are evicted. Default 32 MiB. */
  maxBytes?: number;
  /** Entries kept before the least recently used are evicted. Default 1000. */
  maxEntries?: number;
};

/** The default store: an in-process LRU bounded by bytes and by entries. */
export type MemoryRenderCache = RenderCacheStore & {
  /** Entries currently held. */
  readonly size: number;
  /** Encoded bytes currently held. */
  readonly byteSize: number;
  delete(key: string): boolean;
  clear(): void;
};

export const MEMORY_RENDER_CACHE_DEFAULTS = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxEntries: 1000,
});

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer; received ${value}`);
  }
  return value;
}

/**
 * An in-memory LRU render store. A `Map` keeps insertion order, so a hit is
 * re-inserted to mark it most recent and eviction removes from the front. An
 * entry larger than `maxBytes` is never stored. Expired entries are dropped
 * when read.
 */
export function memoryRenderCache(options: MemoryRenderCacheOptions = {}): MemoryRenderCache {
  const maxBytes = positiveInteger(options.maxBytes, MEMORY_RENDER_CACHE_DEFAULTS.maxBytes, "maxBytes");
  const maxEntries = positiveInteger(options.maxEntries, MEMORY_RENDER_CACHE_DEFAULTS.maxEntries, "maxEntries");
  const entries = new Map<string, RenderCacheEntry>();
  let byteSize = 0;

  function remove(key: string): boolean {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    byteSize -= entry.bytes.byteLength;
    return true;
  }

  return {
    get size() {
      return entries.size;
    },
    get byteSize() {
      return byteSize;
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      remove(key);
      if (entry.expires !== undefined && entry.expires <= Date.now()) return undefined;
      entries.set(key, entry);
      byteSize += entry.bytes.byteLength;
      return entry;
    },
    set(key, entry) {
      remove(key);
      if (entry.bytes.byteLength > maxBytes) return;
      entries.set(key, entry);
      byteSize += entry.bytes.byteLength;
      for (const oldest of entries.keys()) {
        if (byteSize <= maxBytes && entries.size <= maxEntries) break;
        remove(oldest);
      }
    },
    delete: remove,
    clear() {
      entries.clear();
      byteSize = 0;
    },
  };
}

export type RenderCacheOptions = {
  /** Where renders are kept. Default: a new `memoryRenderCache({ maxBytes, maxEntries })`. */
  store?: RenderCacheStore;
  /** Seconds an entry stays fresh. Default: no expiry, since the key covers every known input. */
  ttl?: number;
  /** Configures the default memory store; not allowed with `store`. */
  maxBytes?: number;
  /** Configures the default memory store; not allowed with `store`. */
  maxEntries?: number;
  /**
   * Called when the store throws. A failed `get` is treated as a miss and a
   * failed `set` is skipped, so a store outage slows responses rather than
   * failing them.
   */
  onStoreError?: (error: unknown, operation: "get" | "set") => void;
};

/** What a plate view lends the cache. */
export type CacheablePlate<Copy> = {
  readonly contentType: string;
  render(copy: Copy): Promise<Uint8Array>;
  fingerprint(): Promise<string>;
  /** Lowercase hex SHA-256, from `node:crypto` or Web Crypto. */
  sha256(bytes: Uint8Array): string | Promise<string>;
  /** The plate's response headers for bytes of this length and ETag. */
  headers(byteLength: number, etag: string): Headers;
  /** Identifies the plate view across `cached()` calls; defaults to this object. */
  identity?: object;
};

/** Which plate view first used each fingerprint with each store. */
const owners = new WeakMap<RenderCacheStore, Map<string, object>>();

/**
 * Refuses a second plate view whose fingerprint equals another's in the same
 * store. Source text cannot see closed-over values, so plates made by one
 * factory with different themes fingerprint alike, and sharing a store would
 * serve one plate's card for the other's copy.
 */
function claim(store: RenderCacheStore, fingerprint: string, identity: object): void {
  let byFingerprint = owners.get(store);
  if (!byFingerprint) {
    byFingerprint = new Map();
    owners.set(store, byFingerprint);
  }
  const owner = byFingerprint.get(fingerprint);
  if (owner === undefined) {
    byFingerprint.set(fingerprint, identity);
  } else if (owner !== identity) {
    throw new Error(
      "Two plates with the same fingerprint share one render cache store. Their definitions differ " +
        "only in what their functions close over or import, which the fingerprint cannot see, so " +
        "they could serve each other's cards. Give each plate a distinct revision, or reuse one plate.",
    );
  }
}

/** Anything with the parts of a Fetch `Request` a conditional GET needs. */
type ConditionalRequest = { readonly method: string; readonly headers: { get(name: string): string | null } };

function isRequest(value: unknown): value is ConditionalRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { method?: unknown; headers?: { get?: unknown } };
  return typeof candidate.method === "string" && typeof candidate.headers?.get === "function";
}

/**
 * Finds the Fetch `Request` among a framework's handler arguments: the
 * argument itself (Next.js route handlers, `fetch(request)`), or its
 * `request` property (Astro, SvelteKit, React Router).
 */
export function requestFrom(arguments_: readonly unknown[]): ConditionalRequest | undefined {
  for (const argument of arguments_) {
    if (isRequest(argument)) return argument;
    const nested = (argument as { request?: unknown } | null)?.request;
    if (typeof argument === "object" && isRequest(nested)) return nested;
  }
  return undefined;
}

/**
 * Parses an `If-None-Match` list into opaque tags, weakness stripped, in one
 * linear pass (RFC 9110 section 8.8.3: `entity-tag = [ "W/" ] DQUOTE *etagc
 * DQUOTE`, where `etagc` may include a comma). A malformed member ends the
 * parse; the members before it still count.
 */
export function parseEntityTags(field: string): string[] {
  const tags: string[] = [];
  let index = 0;
  while (index < field.length) {
    const character = field[index];
    if (character === " " || character === "\t" || character === ",") {
      index += 1;
      continue;
    }
    if (field.startsWith("W/", index)) index += 2;
    if (field[index] !== '"') break;
    const end = field.indexOf('"', index + 1);
    if (end === -1) break;
    tags.push(field.slice(index, end + 1));
    index = end + 1;
  }
  return tags;
}

/**
 * RFC 9110 section 13.1.2: true when the `If-None-Match` condition is false,
 * that is, the client already holds this representation. `*` matches any
 * current representation; a list matches under the weak comparison function
 * (section 8.8.3.2), so `W/"x"` and `"x"` both match `"x"`.
 */
export function ifNoneMatchHolds(field: string | null, etag: string): boolean {
  if (field === null) return false;
  if (field.trim() === "*") return true;
  const opaque = etag.startsWith("W/") ? etag.slice(2) : etag;
  return parseEntityTags(field).includes(opaque);
}

/** Header fields a 304 omits: they describe content the response does not carry. */
const CONTENT_HEADERS = ["content-type", "content-length", "content-encoding", "content-range"];

function respond(entry: RenderCacheEntry, headers: Headers, request: ConditionalRequest | undefined): Response {
  if (request && ifNoneMatchHolds(request.headers.get("if-none-match"), entry.etag)) {
    // GET and HEAD answer 304 with the 200's ETag, Cache-Control, Vary, and
    // the rest of its fields; any other method gets 412 (RFC 9110 13.1.2).
    for (const name of CONTENT_HEADERS) headers.delete(name);
    const method = request.method.toUpperCase();
    const status = method === "GET" || method === "HEAD" ? 304 : 412;
    return new Response(null, { status, headers });
  }
  const { bytes } = entry;
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(body, { headers });
}

/**
 * Wraps a plate view so each distinct copy renders once. The key is the
 * SHA-256 of the plate's fingerprint (Metaplate version, `revision`, size,
 * fonts, component source, and options) and the stable-serialized copy, so
 * different copy can never share an entry. Concurrent misses for one key
 * share a single render.
 */
export function createRenderCache<Copy>(plate: CacheablePlate<Copy>, options: RenderCacheOptions = {}) {
  if (options.store && (options.maxBytes !== undefined || options.maxEntries !== undefined)) {
    throw new TypeError("maxBytes and maxEntries configure the default memory store; size a custom store yourself");
  }
  const ttl = options.ttl;
  if (ttl !== undefined && !(Number.isFinite(ttl) && ttl > 0)) {
    throw new TypeError(`ttl must be a positive number of seconds; received ${ttl}`);
  }
  const store = options.store ?? memoryRenderCache({
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
  });
  const inFlight = new Map<string, Promise<RenderCacheEntry>>();
  const encoder = new TextEncoder();

  async function storeCall<T>(operation: "get" | "set", call: () => T | Promise<T>): Promise<T | undefined> {
    try {
      return await call();
    } catch (error) {
      options.onStoreError?.(error, operation);
      return undefined;
    }
  }

  const identity = plate.identity ?? plate;

  /** The cache key for `copy`: lowercase hex SHA-256. */
  async function key(copy: Copy): Promise<string> {
    const fingerprint = await plate.fingerprint();
    claim(store, fingerprint, identity);
    const source = taggedSerialize(
      { cache: "metaplate-render-cache/1", plate: fingerprint, copy },
      "copy",
    );
    return plate.sha256(encoder.encode(source));
  }

  /** A stored entry is used only when it is fresh and its bytes still hash to its ETag. */
  async function usable(entry: RenderCacheEntry | undefined): Promise<RenderCacheEntry | undefined> {
    if (!entry || !(entry.bytes instanceof Uint8Array) || entry.contentType !== plate.contentType) return undefined;
    if (entry.expires !== undefined && entry.expires <= Date.now()) return undefined;
    return entry.etag === `"${await plate.sha256(entry.bytes)}"` ? entry : undefined;
  }

  async function load(cacheKey: string, copy: Copy): Promise<RenderCacheEntry> {
    const cached = await usable(await storeCall("get", () => store.get(cacheKey)));
    if (cached) return cached;
    const bytes = await plate.render(copy);
    const entry: RenderCacheEntry = Object.freeze({
      bytes,
      contentType: plate.contentType,
      etag: `"${await plate.sha256(bytes)}"`,
      ...(ttl === undefined ? {} : { expires: Date.now() + ttl * 1000 }),
    });
    await storeCall("set", () => store.set(cacheKey, entry));
    return entry;
  }

  /** The cached entry for `copy`, rendering it on a miss. */
  async function entry(copy: Copy): Promise<RenderCacheEntry> {
    const cacheKey = await key(copy);
    const pending = inFlight.get(cacheKey);
    if (pending) return pending;
    const loading = load(cacheKey, copy).finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, loading);
    return loading;
  }

  /**
   * A response for `copy` with a strong ETag. Given the request, a matching
   * `If-None-Match` is answered with 304 (GET, HEAD) or 412 (other methods).
   */
  async function response(copy: Copy, request?: ConditionalRequest): Promise<Response> {
    const cached = await entry(copy);
    return respond(cached, plate.headers(cached.bytes.byteLength, cached.etag), request);
  }

  return Object.freeze({
    store,
    key,
    entry,
    render: async (copy: Copy) => (await entry(copy)).bytes,
    response,
    handler: (copy: Copy) => (...arguments_: unknown[]) => response(copy, requestFrom(arguments_)),
    handlerFrom: <Arguments extends unknown[]>(
      resolve: (...arguments_: Arguments) => Copy | Promise<Copy>,
    ) =>
      async (...arguments_: Arguments) => response(await resolve(...arguments_), requestFrom(arguments_)),
    fetchable: (copy: Copy) => ({
      fetch: (...arguments_: unknown[]) => response(copy, requestFrom(arguments_)),
    }),
    fetchableFrom: <Arguments extends unknown[]>(
      resolve: (...arguments_: Arguments) => Copy | Promise<Copy>,
    ) => ({
      fetch: async (...arguments_: Arguments) => response(await resolve(...arguments_), requestFrom(arguments_)),
    }),
  });
}

/** A plate view wrapped by `plate.cached()`. */
export type CachedPlate<Copy> = ReturnType<typeof createRenderCache<Copy>>;
