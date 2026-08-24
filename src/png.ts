export type PngDimensions = {
  width: number;
  height: number;
};

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function uint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + 4));
}

/**
 * Validates the zlib envelope of the concatenated IDAT stream without
 * inflating it: the first two bytes must be a CMF/FLG header declaring the
 * deflate method with a correct FCHECK, and the stream must be long enough
 * to hold the four-byte Adler-32 trailer. This rejects a stub or truncated
 * IDAT stream while staying dependency-free.
 */
function validateZlibEnvelope(idatBytes: number, firstTwo: [number, number]): void {
  if (idatBytes < 8) {
    throw new Error("Not a PNG: IDAT stream is not a zlib datastream");
  }
  const cmf = firstTwo[0];
  const flg = firstTwo[1];
  if ((cmf & 0x0f) !== 8) {
    throw new Error("Not a PNG: IDAT stream is not deflate-compressed");
  }
  if (((cmf << 8) + flg) % 31 !== 0) {
    throw new Error("Not a PNG: IDAT stream has an invalid zlib header");
  }
}

/**
 * Reads and validates the PNG signature and IHDR dimensions, then walks the
 * chunk stream to confirm the file is structurally complete: IHDR comes
 * first with exactly 13 bytes of payload, at least one IDAT follows, the
 * concatenated IDAT stream forms a zlib datastream, and the file ends with
 * its zero-payload IEND terminator. A truncated or header-shell file fails
 * even when its dimension header survives.
 */
export function pngDimensions(input: ArrayBuffer | Uint8Array): PngDimensions {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 24) throw new Error("Not a PNG: file is shorter than IHDR");

  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      throw new Error("Not a PNG: invalid signature");
    }
  }

  if (chunkType(bytes, 12) !== "IHDR") {
    throw new Error("Not a PNG: first chunk is not IHDR");
  }
  if (chunkLength(bytes, 8) !== 13) {
    throw new Error("Not a PNG: IHDR must have exactly 13 bytes of payload");
  }

  const dimensions = { width: uint32(bytes, 16), height: uint32(bytes, 20) };
  if (dimensions.width === 0 || dimensions.height === 0) {
    throw new Error("Not a PNG: IHDR width and height must be greater than zero");
  }
  let offset = 8 + 12 + 13;
  let idatBytes = 0;
  // The first two bytes of the concatenated IDAT stream, captured across
  // chunk boundaries so the zlib header can be checked without copying.
  const streamHead: [number, number] = [0, 0];
  let headFilled = 0;
  let sawIdat = false;
  let idatSequenceEnded = false;

  while (offset + 12 <= bytes.byteLength) {
    const length = chunkLength(bytes, offset);
    const type = chunkType(bytes, offset + 4);

    if (type === "IDAT") {
      if (idatSequenceEnded) {
        throw new Error("Not a PNG: IDAT chunks must be consecutive");
      }
      sawIdat = true;
      idatBytes += length;
      for (let index = 0; index < length && headFilled < 2; index += 1) {
        streamHead[headFilled] = bytes[offset + 8 + index]!;
        headFilled += 1;
      }
    } else if (sawIdat) {
      idatSequenceEnded = true;
    }
    if (type === "IEND") {
      // Empty IDAT siblings are legal, but an image whose concatenated IDAT
      // stream is empty has no zlib data at all, so it must not verify.
      if (idatBytes === 0) {
        throw new Error("Not a PNG: IDAT stream contains no image data");
      }
      validateZlibEnvelope(idatBytes, streamHead);
      if (length !== 0) throw new Error("Not a PNG: IEND must have no payload");
      if (offset + 12 !== bytes.byteLength) {
        throw new Error("Not a PNG: trailing data after IEND");
      }
      return dimensions;
    }

    // Zero-length chunks are legal in PNG (an empty IDAT between siblings is
    // one); the walk advances by 12 either way, so an empty payload cannot
    // loop forever.
    if (offset + 12 + length > bytes.byteLength) {
      throw new Error(`Not a PNG: ${type} chunk is truncated`);
    }

    offset += 12 + length;
  }

  throw new Error("Not a PNG: missing IEND terminator");
}

function chunkLength(bytes: Uint8Array, offset: number): number {
  return uint32(bytes, offset);
}

/** Throws when a PNG does not have the expected dimensions. */
export function verifyPng(
  input: ArrayBuffer | Uint8Array,
  expected: PngDimensions,
): PngDimensions {
  const actual = pngDimensions(input);
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(
      `Expected ${expected.width}x${expected.height}, received ${actual.width}x${actual.height}`,
    );
  }
  return actual;
}
