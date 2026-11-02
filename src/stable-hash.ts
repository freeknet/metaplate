/**
 * Not an entry point: the deterministic serialization behind plate
 * fingerprints, `metaplate render --incremental`, and the runtime render
 * cache. Web-platform only (no Node built-ins), so the edge bundle can include
 * it unchanged.
 */

/** Lowercase hex of `bytes`. */
export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function describeType(value: object): string {
  return (value as { constructor?: { name?: string } }).constructor?.name ?? "an object";
}

function number(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

function bytesOf(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * Serializes `value` to a string that is equal for two values exactly when
 * they hold the same data, whatever order object keys were written in.
 * Every type is tagged, so `1`, `"1"`, and `[1]` never collide.
 *
 * - Plain objects are keyed by sorted own enumerable string keys; arrays,
 *   `Map`, and `Set` keep their order.
 * - Byte arrays and `ArrayBuffer`s serialize their bytes; `Date` its ISO time.
 * - Functions serialize their source text, which sees edits to the function
 *   body but not to anything it closes over or imports.
 * - Any other object with `toJSON` (such as `URL`) serializes what it returns.
 *
 * Throws a `TypeError` naming the path for a cycle, a symbol, or an object
 * with no data representation, rather than letting two different values
 * collide on one key.
 */
export function taggedSerialize(value: unknown, label = "value"): string {
  const ancestors = new Set<object>();

  function walk(current: unknown, path: string): string {
    switch (typeof current) {
      case "undefined":
        return "u";
      case "boolean":
        return current ? "t" : "f";
      case "number":
        return `d${number(current)}`;
      case "bigint":
        return `i${current}`;
      case "string":
        return `s${JSON.stringify(current)}`;
      case "function":
        return `F${JSON.stringify(Function.prototype.toString.call(current))}`;
      case "symbol":
        throw new TypeError(`Cannot serialize the symbol at ${path}`);
    }
    if (current === null) return "n";
    const object = current as object;
    if (ancestors.has(object)) throw new TypeError(`Cannot serialize the cycle at ${path}`);
    ancestors.add(object);
    try {
      return walkObject(object, path);
    } finally {
      ancestors.delete(object);
    }
  }

  function walkObject(object: object, path: string): string {
    if (Array.isArray(object)) {
      return `[${Array.from(object, (item, index) => walk(item, `${path}[${index}]`)).join(",")}]`;
    }
    if (object instanceof ArrayBuffer || ArrayBuffer.isView(object)) {
      return `b${describeType(object)}:${toHex(bytesOf(object))}`;
    }
    if (object instanceof Date) {
      return `D${Number.isNaN(object.getTime()) ? "invalid" : object.toISOString()}`;
    }
    if (object instanceof Map) {
      const entries = Array.from(object, ([key, item], index) =>
        `${walk(key, `${path}<key ${index}>`)}:${walk(item, `${path}<value ${index}>`)}`);
      return `M[${entries.join(",")}]`;
    }
    if (object instanceof Set) {
      return `S[${Array.from(object, (item, index) => walk(item, `${path}<item ${index}>`)).join(",")}]`;
    }
    if (isPlainObject(object)) {
      const record = object as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${walk(record[key], `${path}.${key}`)}`);
      return `{${entries.join(",")}}`;
    }
    const toJSON = (object as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return `J${walk((toJSON as () => unknown).call(object), path)}`;
    }
    throw new TypeError(
      `Cannot serialize ${describeType(object)} at ${path}: use plain objects, arrays, ` +
        "strings, numbers, booleans, dates, or bytes",
    );
  }

  return walk(value, label);
}
