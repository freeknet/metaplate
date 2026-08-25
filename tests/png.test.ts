import { describe, expect, it } from "vitest";
import { pngDimensions, verifyPng } from "../src/png.js";
import { pngChunk, uint32be } from "./helpers/image-fixtures.js";

type PngHeaderOptions = {
  bitDepth?: number;
  colorType?: number;
  compressionMethod?: number;
  filterMethod?: number;
  interlaceMethod?: number;
  chunks?: number[][];
};

function pngHeader(width: number, height: number, options: PngHeaderOptions = {}) {
  const {
    bitDepth = 8,
    colorType = 6,
    compressionMethod = 0,
    filterMethod = 0,
    interlaceMethod = 0,
    chunks = [pngChunk("IDAT", [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])],
  } = options;
  const ihdr = [
    ...uint32be(width),
    ...uint32be(height),
    bitDepth, colorType, compressionMethod, filterMethod, interlaceMethod,
  ];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk("IHDR", ihdr),
    // A complete (empty) zlib datastream: 0x78 0x9C header, an empty deflate
    // block, and the Adler-32 of the empty input.
    ...chunks.flat(),
    ...pngChunk("IEND", []),
  ]);
}

describe("PNG verification", () => {
  it("reads IHDR dimensions", () => {
    expect(pngDimensions(pngHeader(1200, 630))).toEqual({ width: 1200, height: 630 });
  });

  it.each([[0, 630], [1200, 0]])("rejects zero IHDR dimensions (%ix%i)", (width, height) => {
    expect(() => pngDimensions(pngHeader(width, height))).toThrow(/dimensions must be between/);
    expect(() => verifyPng(pngHeader(width, height), { width, height })).toThrow(
      /dimensions must be between/,
    );
  });

  it.each([[0x80000000, 1], [1, 0x80000000]])(
    "rejects dimensions beyond PNG's signed 31-bit limit (%ix%i)",
    (width, height) => {
      expect(() => pngDimensions(pngHeader(width, height))).toThrow(/dimensions must be between/);
    },
  );

  it.each([
    [1, 2],
    [4, 4],
    [16, 3],
    [8, 1],
    [8, 5],
  ])("rejects invalid IHDR bit-depth/color-type pairs (%i/%i)", (bitDepth, colorType) => {
    expect(() => pngDimensions(pngHeader(1200, 630, { bitDepth, colorType }))).toThrow(
      /invalid bit depth and color type combination/,
    );
  });

  it.each([
    ["compression", { compressionMethod: 1 }, /compression method/],
    ["filter", { filterMethod: 1 }, /filter method/],
    ["interlace", { interlaceMethod: 2 }, /interlace method/],
  ] as const)("rejects an unsupported IHDR %s method", (_name, options, message) => {
    expect(() => pngDimensions(pngHeader(1200, 630, options))).toThrow(message);
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
    expect(() => pngDimensions(headerOnly)).toThrow(/shorter than IHDR/);
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

  it("rejects an IDAT stream whose zlib window size is out of range", () => {
    // CINFO 8 (the high nibble of 0x88) is outside zlib's permitted 0..7 range.
    const invalidWindow = pngHeader(1200, 630, {
      chunks: [pngChunk("IDAT", [0x88, 0x1c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])],
    });
    expect(() => pngDimensions(invalidWindow)).toThrow(/invalid zlib window size/);
  });

  it("rejects a duplicate IHDR chunk", () => {
    const duplicate = pngHeader(1200, 630, {
      chunks: [
        pngChunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
        pngChunk("IDAT", [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
      ],
    });
    expect(() => pngDimensions(duplicate)).toThrow(/IHDR must appear exactly once/);
  });

  it("rejects an unknown critical chunk", () => {
    const unknownCritical = pngHeader(1200, 630, {
      chunks: [
        pngChunk("ABCD", []),
        pngChunk("IDAT", [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
      ],
    });
    expect(() => pngDimensions(unknownCritical)).toThrow(/unknown critical chunk ABCD/);
  });

  it("requires PLTE before IDAT for indexed-color PNGs", () => {
    expect(() => pngDimensions(pngHeader(1200, 630, { colorType: 3 }))).toThrow(
      /require PLTE before IDAT/,
    );
  });

  it("rejects a PLTE chunk after IDAT", () => {
    const latePalette = pngHeader(1200, 630, {
      colorType: 3,
      chunks: [
        pngChunk("PLTE", [0, 0, 0]),
        pngChunk("IDAT", [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
        pngChunk("PLTE", [255, 255, 255]),
      ],
    });
    expect(() => pngDimensions(latePalette)).toThrow(/PLTE must not appear more than once|PLTE must precede IDAT/);
  });

  it.each([
    ["a malformed payload", 2, 3, [0, 0]],
    ["a palette that exceeds indexed bit depth", 1, 3, [0, 0, 0, 255, 255, 255, 1, 1, 1]],
    ["a grayscale palette", 8, 0, [0, 0, 0]],
  ])("rejects %s", (_name, bitDepth, colorType, palette) => {
    const invalidPalette = pngHeader(1200, 630, {
      bitDepth,
      colorType,
      chunks: [
        pngChunk("PLTE", palette),
        pngChunk("IDAT", [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
      ],
    });
    expect(() => pngDimensions(invalidPalette)).toThrow(/PLTE/);
  });

  it("rejects duplicate PLTE chunks", () => {
    const duplicatePalette = pngHeader(1200, 630, {
      colorType: 3,
      chunks: [
        pngChunk("PLTE", [0, 0, 0]),
        pngChunk("PLTE", [255, 255, 255]),
        pngChunk("IDAT", [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
      ],
    });
    expect(() => pngDimensions(duplicatePalette)).toThrow(/PLTE must not appear more than once/);
  });
});
