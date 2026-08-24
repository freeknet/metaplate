import { describe, expect, it } from "vitest";
import { pngDimensions, verifyPng } from "../src/png.js";

function pngChunk(type: string, payload: number[]): number[] {
  const data = payload.length;
  const length = [
    (data >>> 24) & 0xff, (data >>> 16) & 0xff, (data >>> 8) & 0xff, data & 0xff,
  ];
  return [...length, ...type.split("").map((c) => c.charCodeAt(0)), ...payload, 0, 0, 0, 0];
}

function pngHeader(width: number, height: number) {
  const ihdr = [
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    8, 6, 0, 0, 0,
  ];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk("IHDR", ihdr),
    // A complete (empty) zlib datastream: 0x78 0x9C header, an empty deflate
    // block, and the Adler-32 of the empty input.
    ...pngChunk("IDAT", [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
    ...pngChunk("IEND", []),
  ]);
}

describe("PNG verification", () => {
  it("reads IHDR dimensions", () => {
    expect(pngDimensions(pngHeader(1200, 630))).toEqual({ width: 1200, height: 630 });
  });

  it.each([[0, 630], [1200, 0]])("rejects zero IHDR dimensions (%ix%i)", (width, height) => {
    expect(() => pngDimensions(pngHeader(width, height))).toThrow(/greater than zero/);
    expect(() => verifyPng(pngHeader(width, height), { width, height })).toThrow(
      /greater than zero/,
    );
  });

  it("rejects non-PNG input", () => {
    expect(() => pngDimensions(new Uint8Array(24))).toThrow(/invalid signature/);
  });

  it("reports dimension mismatches", () => {
    expect(() => verifyPng(pngHeader(600, 315), { width: 1200, height: 630 })).toThrow(
      "Expected 1200x630, received 600x315",
    );
  });

  it("rejects a header-only truncated PNG", () => {
    const headerOnly = Uint8Array.from(pngHeader(1200, 630).subarray(0, 24));
    expect(() => pngDimensions(headerOnly)).toThrow(/missing IEND/);
  });

  it("accepts legal zero-length IDAT chunks", () => {
    // Zero-length data chunks are legal PNG; an empty IDAT beside a real one
    // must not be treated as a truncated or malformed file.
    const withEmptyIdat = Uint8Array.from([
      ...pngHeader(1200, 630).subarray(0, 8 + 12 + 13),
      ...pngChunk("IDAT", []),
      ...pngHeader(1200, 630).subarray(8 + 12 + 13),
    ]);
    expect(pngDimensions(withEmptyIdat)).toEqual({ width: 1200, height: 630 });
  });

  it("rejects IDAT chunks separated by an ancillary chunk", () => {
    // PNG permits a zlib stream to span IDAT siblings, but those siblings
    // must be contiguous. Otherwise decoders can disagree about the stream.
    const splitByText = Uint8Array.from([
      ...pngHeader(1200, 630).subarray(0, 8 + 12 + 13),
      ...pngChunk("IDAT", [0x78, 0x9c]),
      ...pngChunk("tEXt", [0x6b, 0x00]),
      ...pngChunk("IDAT", [0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
      ...pngChunk("IEND", []),
    ]);

    expect(() => pngDimensions(splitByText)).toThrow(/IDAT chunks must be consecutive/);
    expect(() => verifyPng(splitByText, { width: 1200, height: 630 })).toThrow(
      /IDAT chunks must be consecutive/,
    );
  });

  it("rejects a PNG whose entire IDAT stream is empty", () => {
    // A zero-length IDAT is legal between real siblings, but an image whose
    // only IDATs are empty carries no zlib stream and must not verify.
    const emptyStream = Uint8Array.from([
      ...pngHeader(1200, 630).subarray(0, 8 + 12 + 13),
      ...pngChunk("IDAT", []),
      ...pngChunk("IDAT", []),
      ...pngChunk("IEND", []),
    ]);
    expect(() => pngDimensions(emptyStream)).toThrow(/no image data/);
  });

  it("rejects an IDAT stream that is not a zlib datastream", () => {
    // A single byte cannot be a zlib stream: no header, no Adler-32 trailer.
    const oneByteIdat = Uint8Array.from([
      ...pngHeader(1200, 630).subarray(0, 8 + 12 + 13),
      ...pngChunk("IDAT", [0x78]),
      ...pngChunk("IEND", []),
    ]);
    expect(() => pngDimensions(oneByteIdat)).toThrow(/zlib datastream/);
  });

  it("rejects an IDAT stream truncated before its Adler-32 trailer", () => {
    // The header declares a valid FCHECK but the stream is cut before its
    // Adler-32 trailer, so it cannot be a complete datastream.
    const truncatedStream = Uint8Array.from([
      ...pngHeader(1200, 630).subarray(0, 8 + 12 + 13),
      ...pngChunk("IDAT", [0x78, 0x9c, 0x03, 0x00, 0x00]),
      ...pngChunk("IEND", []),
    ]);
    expect(() => pngDimensions(truncatedStream)).toThrow(/zlib datastream/);
  });

  it("rejects an IDAT stream whose header declares the wrong method", () => {
    // CMF 0x01 declares compression method 1, not deflate (8).
    const wrongMethod = Uint8Array.from([
      ...pngHeader(1200, 630).subarray(0, 8 + 12 + 13),
      ...pngChunk("IDAT", [0x01, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
      ...pngChunk("IEND", []),
    ]);
    expect(() => pngDimensions(wrongMethod)).toThrow(/deflate-compressed/);
  });
});
