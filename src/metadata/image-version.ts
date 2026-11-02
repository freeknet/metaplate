/**
 * Cache-busting version tokens for published image URLs. Crawlers cache an
 * image by its URL, so a changed image needs a changed URL; Metaplate adds
 * one `v` query parameter to the URLs it emits in metadata and never to the
 * path a file is written to or served from. Runtime-neutral: no Node
 * built-ins, and synchronous, so building metadata stays a plain call.
 */

/** The query parameter Metaplate appends to versioned image URLs. */
export const IMAGE_VERSION_PARAMETER = "v";

/**
 * RFC 3986 unreserved characters only, so a token never needs
 * percent-encoding and cannot introduce another parameter or a fragment.
 */
const VERSION_TOKEN = /^[A-Za-z0-9._~-]{1,64}$/;

/** Rejects a version token that could not be emitted verbatim in a query. */
export function assertVersionToken(version: unknown): asserts version is string {
  if (typeof version !== "string" || !VERSION_TOKEN.test(version)) {
    throw new Error(
      'Invalid version: expected 1 to 64 characters from A-Z, a-z, 0-9, ".", "_", "~", and "-"; ' +
        `received ${JSON.stringify(version)}`,
    );
  }
}

/**
 * Appends `?v=<version>` to an image URL Metaplate built itself. Those URLs
 * never carry a query or fragment (route, `basePath`, `imagePath`, and
 * `origin` reject them), so the token is always the only parameter.
 */
export function versionedImageUrl(url: string, version: string | undefined): string {
  if (version === undefined) return url;
  assertVersionToken(version);
  return `${url}?${IMAGE_VERSION_PARAMETER}=${version}`;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function unserializable(path: string, description: string): TypeError {
  return new TypeError(
    `Cannot derive an image version: ${path} is ${description}; copy must be plain JSON data ` +
      "(objects, arrays, strings, finite numbers, booleans, and null)",
  );
}

function serializeObject(value: object, path: string, ancestors: Set<object>): string {
  if (ancestors.has(value)) throw unserializable(path, "a circular reference");
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    return serialize((toJSON as () => unknown).call(value), path, ancestors);
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
    throw unserializable(path, `a ${typeof name === "string" && name !== "" ? name : "non-plain object"}`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item: unknown, index) => serialize(item, `${path}[${index}]`, ancestors));
      return `[${items.join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`, ancestors)}`);
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw unserializable(path, String(value));
    return JSON.stringify(value);
  }
  if (typeof value === "object") return serializeObject(value, path, ancestors);
  throw unserializable(path, `a ${typeof value}`);
}

/**
 * A stable JSON serialization: object keys are sorted by UTF-16 code unit,
 * so property order never changes the result; `undefined` members are
 * omitted and `toJSON` (such as `Date`'s) is honored, as `JSON.stringify`
 * does. Values JSON would silently drop or distort (functions, symbols,
 * bigints, non-finite numbers, cycles, and non-plain objects such as `Map`)
 * throw instead, because two different copies must never serialize, and so
 * version, identically by accident.
 */
export function stableSerialize(value: unknown, path = "copy"): string {
  return serialize(value, path, new Set());
}

const FNV_OFFSET_BASIS = 0x81_1c_9d_c5;
const FNV_PRIME = 0x01_00_01_93;

/**
 * 32-bit FNV-1a over bytes, as eight lowercase hex digits. A small,
 * documented, non-cryptographic hash: it only has to give a changed card a
 * different URL, not resist an adversary.
 */
export function fnv1a32(bytes: Uint8Array): string {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Derives a short, stable version token from a card's copy and an optional
 * design `revision`: the 32-bit FNV-1a hash of the UTF-8 bytes of
 * `stableSerialize([revision ?? null, copy])`, as eight lowercase hex
 * digits. The same copy and revision give the same token on every runtime;
 * a changed title, or a bumped revision after a design change, gives a new
 * one.
 *
 * @throws When `copy` holds a value with no stable serialization, or when
 *   `revision` is given but is not a non-empty string.
 */
export function socialImageVersion(copy: unknown, revision?: string): string {
  if (revision !== undefined && (typeof revision !== "string" || revision === "")) {
    throw new TypeError(`Invalid revision: expected a non-empty string; received ${JSON.stringify(revision)}`);
  }
  // Equal to `stableSerialize([revision ?? null, copy])`, with error paths
  // that name the copy rather than an array index.
  const serialized = `[${JSON.stringify(revision ?? null)},${stableSerialize(copy)}]`;
  return fnv1a32(new TextEncoder().encode(serialized));
}
