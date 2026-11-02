/**
 * Not an entry point: byte helpers shared by the runtime-neutral entries
 * (`metaplate/emoji`, `metaplate/image`). Web-platform only, no `Buffer`.
 */

/** A view over the exact bytes of an `ArrayBuffer` or any `ArrayBufferView`. */
export function bytesOf(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  return input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

/** Standard base64 with `btoa`, chunked so large inputs do not overflow the call stack. */
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/**
 * Memoizes one asynchronous load. A failed load is discarded rather than
 * memoized, so a long-lived server recovers once the file, package, or
 * network source has been fixed.
 */
export function memoizeLoad<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () => {
    loaded ??= load().catch((error: unknown) => {
      loaded = undefined;
      throw error;
    });
    return loaded;
  };
}
