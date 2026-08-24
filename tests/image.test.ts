import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { imageDimensions, verifyImage } from "../src/image.js";

// The checked-in fixtures (card.jpg, icon.jpg, the .webp files, card.png) are
// real encoder output rather than hand-built headers, so a misreading of a
// format cannot be encoded into both parser and test. The helpers below build
// synthetic bytes only for the specific shell/truncation cases a real encoder
// would never emit.
function fixture(name: string) {
  return readFileSync(path.join(import.meta.dirname, "fixtures", name));
}

// A complete minimal PNG: signature, IHDR, one IDAT, and IEND. The zero CRC
// passes structural validation, which deliberately does not re-implement the
// CRC-32 algorithm.
function pngChunk(type: string, payload: number[]): number[] {
  const data = payload.length;
  const length = [
    (data >>> 24) & 0xff, (data >>> 16) & 0xff, (data >>> 8) & 0xff, data & 0xff,
  ];
  return [...length, ...type.split("").map((c) => c.charCodeAt(0)), ...payload, 0, 0, 0, 0];
}

function completePng(width: number, height: number): Uint8Array {
  const ihdr = [
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    8, 6, 0, 0, 0,
  ];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk("IHDR", ihdr),
    ...pngChunk("IDAT", [0x78, 0x9c, 0x01, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]),
    ...pngChunk("IEND", []),
  ]);
}

function uint24(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

function webpChunk(type: string, payload: number[]): number[] {
  return [
    ...type.split("").map((character) => character.charCodeAt(0)),
    payload.length & 0xff,
    (payload.length >>> 8) & 0xff,
    (payload.length >>> 16) & 0xff,
    (payload.length >>> 24) & 0xff,
    ...payload,
    ...(payload.length % 2 === 0 ? [] : [0]),
  ];
}

function completeWebp(chunks: number[][]): Uint8Array {
  const body = [0x57, 0x45, 0x42, 0x50, ...chunks.flat()];
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46,
    body.length & 0xff,
    (body.length >>> 8) & 0xff,
    (body.length >>> 16) & 0xff,
    (body.length >>> 24) & 0xff,
    ...body,
  ]);
}

function vp8xChunk(width: number, height: number, flags = 0): number[] {
  return webpChunk("VP8X", [flags, 0, 0, 0, ...uint24(width - 1), ...uint24(height - 1)]);
}

function animChunk(): number[] {
  return webpChunk("ANIM", [0, 0, 0, 0, 0, 0]);
}

function vp8lChunk(): number[] {
  return webpChunk("VP8L", [0x2f, 0, 0, 0, 0]);
}

function anmfChunk(
  width: number,
  height: number,
  x = 0,
  y = 0,
  childChunks = [vp8lChunk()],
): number[] {
  return webpChunk("ANMF", [
    ...uint24(x / 2),
    ...uint24(y / 2),
    ...uint24(width - 1),
    ...uint24(height - 1),
    0, 0, 0, // duration
    0, // reserved, blend, disposal
    ...childChunks.flat(),
  ]);
}

// A complete baseline JPEG shell with one component, one scan, one
// entropy-coded byte, and EOI. Its pixel data is intentionally synthetic: the
// structural reader only needs an otherwise valid path to exercise SOF rules.
function completeJpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x0b, // length 11 (Nf=1)
    0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01, // one component
    0x01, 0x11, 0x00, // component id, sampling factors, quantization table
    0xff, 0xda, // SOS
    0x00, 0x08, // length 8 (Ns=1)
    0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x01, // entropy-coded data
    0xff, 0xd9, // EOI
  ]);
}

describe("imageDimensions", () => {
  it.each([
    ["card.jpg", 1200, 630, "jpeg"],
    ["icon.jpg", 512, 512, "jpeg"],
    ["card-lossy.webp", 1200, 630, "webp"],
    ["card-lossless.webp", 1200, 630, "webp"],
    ["card-alpha.webp", 1200, 630, "webp"],
    ["card.png", 1200, 630, "png"],
  ])("reads %s as %ix%i", (name, width, height, format) => {
    expect(imageDimensions(fixture(name as string))).toEqual({ width, height, format });
  });

  it("still reads PNG", () => {
    const png = completePng(1200, 630);
    expect(imageDimensions(png)).toEqual({ width: 1200, height: 630, format: "png" });
  });

  it.each([[0, 630], [1200, 0]])(
    "rejects PNG zero dimensions through the generic reader (%ix%i)",
    (width, height) => {
      expect(() => imageDimensions(completePng(width, height))).toThrow(
        /dimensions must be between 1 and 2147483647/,
      );
    },
  );

  it("rejects a real PNG truncated after its IHDR header", () => {
    const real = fixture("card.png");
    // Signature (8) + IHDR chunk (12 + 13): cut right after the header.
    const truncated = real.subarray(0, 8 + 12 + 13);
    expect(() => imageDimensions(truncated)).toThrow(/missing IEND terminator/);
  });

  it("rejects a real PNG truncated inside its IDAT stream", () => {
    const real = fixture("card.png");
    // Cut ten bytes into the IDAT chunk: the declared length no longer fits.
    const truncated = real.subarray(0, 8 + 12 + 13 + 10);
    expect(() => imageDimensions(truncated)).toThrow(/truncated|missing IEND/);
  });

  it("rejects a PNG truncated to its IHDR header", () => {
    const truncated = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
      0x49, 0x48, 0x44, 0x52, 0, 0, 0x04, 0xb0, 0, 0, 0x02, 0x76,
    ]);
    expect(() => imageDimensions(truncated)).toThrow(/file is shorter than IHDR/);
  });

  it("rejects an unrecognized signature", () => {
    expect(() => imageDimensions(new Uint8Array(32))).toThrow(/Unrecognized image/);
  });

  it("rejects a truncated file", () => {
    expect(() => imageDimensions(Uint8Array.of(0xff, 0xd8))).toThrow(/too short/);
  });

  it("rejects a JPEG truncated before its scan data", () => {
    const bytes = fixture("card.jpg");
    // Cut immediately before the SOS segment: frame header intact, scan gone.
    const truncated = bytes.subarray(0, 248);
    expect(() => imageDimensions(truncated)).toThrow(/missing image scan/);
  });

  it("rejects a JPEG truncated inside its scan data", () => {
    const bytes = fixture("card.jpg");
    // Cut after SOS at 248+2, well before the EOI at 4764.
    const truncated = bytes.subarray(0, 500);
    expect(() => imageDimensions(truncated)).toThrow(/missing EOI/);
  });

  it.each([[0, 630], [1200, 0]])(
    "rejects a JPEG SOF with a zero dimension (%ix%i)",
    (width, height) => {
      expect(() => imageDimensions(completeJpeg(width, height))).toThrow(
        /frame dimensions must be nonzero/,
      );
    },
  );

  it("rejects a WebP truncated before its declared RIFF size", () => {
    const bytes = fixture("card-lossy.webp");
    const truncated = bytes.subarray(0, 300);
    expect(() => imageDimensions(truncated)).toThrow(/shorter than its declared RIFF size/);
  });

  it("rejects WebP whose chunk overruns the container", () => {
    const bytes = Uint8Array.from(fixture("card-lossless.webp"));
    // Bump the VP8L chunk length beyond the RIFF boundary.
    bytes[16] = 0xff;
    expect(() => imageDimensions(bytes)).toThrow(/truncated/);
  });

  it("accepts a zero-length IDAT chunk", () => {
    // A legal empty IDAT between real siblings must not fail structural checks.
    const base = completePng(1200, 630);
    const withEmptyIdat = Uint8Array.from([
      ...base.subarray(0, 8 + 12 + 13),
      ...pngChunk("IDAT", []),
      ...base.subarray(8 + 12 + 13),
    ]);
    expect(imageDimensions(withEmptyIdat)).toEqual({
      width: 1200,
      height: 630,
      format: "png",
    });
  });

  it("rejects a PNG with IDAT chunks separated by ancillary metadata", () => {
    const splitByText = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...pngChunk("IHDR", [
        0, 0, 0x04, 0xb0, 0, 0, 0x02, 0x76, 8, 6, 0, 0, 0,
      ]),
      ...pngChunk("IDAT", [0x78, 0x9c]),
      ...pngChunk("tEXt", [0x6b, 0x00]),
      ...pngChunk("IDAT", [0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
      ...pngChunk("IEND", []),
    ]);

    expect(() => imageDimensions(splitByText)).toThrow(/IDAT chunks must be consecutive/);
  });

  it("rejects a VP8X container with no image data", () => {
    // A structurally complete RIFF holding only the VP8X origin/size header
    // must not verify: it has dimensions but no usable pixels.
    const canvas = (value: number) => [
      value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff,
    ];
    const payload = [0, 0, 0, 0, ...canvas(1199), ...canvas(629)];
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x16, 0x00, 0x00, 0x00, // declared size: 30 - 8
      0x57, 0x45, 0x42, 0x50, // "WEBP"
      0x56, 0x50, 0x38, 0x58, // "VP8X"
      0x0a, 0x00, 0x00, 0x00, // chunk length 10
      ...payload,
    ]);
    expect(() => imageDimensions(webp)).toThrow(/no image or animation data/);
  });

  it("accepts a VP8X container that carries a VP8 payload", () => {
    // card-alpha.webp is VP8X (extended) with an ALPH and a VP8 lossy frame.
    expect(imageDimensions(fixture("card-alpha.webp"))).toEqual({
      width: 1200,
      height: 630,
      format: "webp",
    });
  });

  it("rejects a VP8X canvas whose area exceeds the WebP maximum", () => {
    const webp = completeWebp([vp8xChunk(65_536, 65_536), vp8lChunk()]);
    expect(() => imageDimensions(webp)).toThrow(/canvas area exceeds/);
  });

  it("accepts a VP8X canvas at the 2^32 - 1 pixel boundary", () => {
    const webp = completeWebp([vp8xChunk(65_537, 65_535), vp8lChunk()]);
    expect(imageDimensions(webp)).toEqual({ width: 65_537, height: 65_535, format: "webp" });
  });

  it("rejects an animation flag without its required ANIM chunk", () => {
    const webp = completeWebp([vp8xChunk(1200, 630, 0x02), vp8lChunk()]);
    expect(() => imageDimensions(webp)).toThrow(/animation flag requires an ANIM chunk/);
  });

  it("rejects an animation flag with ANIM but no animation frame", () => {
    const webp = completeWebp([vp8xChunk(1200, 630, 0x02), animChunk()]);
    expect(() => imageDimensions(webp)).toThrow(/no image or animation data/);
  });

  it("rejects an animation control chunk with the wrong fixed length", () => {
    const webp = completeWebp([
      vp8xChunk(1200, 630, 0x02),
      webpChunk("ANIM", [0]),
      anmfChunk(1200, 630),
    ]);
    expect(() => imageDimensions(webp)).toThrow(/ANIM chunk must be six bytes/);
  });

  it("rejects an animation frame that precedes its control chunk", () => {
    const webp = completeWebp([
      vp8xChunk(1200, 630, 0x02),
      anmfChunk(1200, 630),
      animChunk(),
    ]);
    expect(() => imageDimensions(webp)).toThrow(/ANMF frame must follow the ANIM chunk/);
  });

  it("accepts a bounded animation with ANIM followed by ANMF", () => {
    const webp = completeWebp([
      vp8xChunk(1200, 630, 0x02),
      animChunk(),
      anmfChunk(1200, 630),
    ]);
    expect(imageDimensions(webp)).toEqual({ width: 1200, height: 630, format: "webp" });
  });

  it("rejects an animated frame that extends outside the VP8X canvas", () => {
    const webp = completeWebp([
      vp8xChunk(1200, 630, 0x02),
      animChunk(),
      anmfChunk(1, 1, 1200),
    ]);
    expect(() => imageDimensions(webp)).toThrow(/extends outside the VP8X canvas/);
  });

  it("rejects nonzero RIFF padding after a top-level chunk", () => {
    const webp = completeWebp([vp8xChunk(1200, 630), vp8lChunk()]);
    webp[webp.length - 1] = 1;
    expect(() => imageDimensions(webp)).toThrow(/nonzero RIFF padding/);
  });

  it("rejects nonzero RIFF padding inside an ANMF frame", () => {
    const frame = anmfChunk(1200, 630);
    // The frame itself is even-sized; its final byte is the odd VP8L
    // sub-chunk's required padding byte.
    frame[frame.length - 1] = 1;
    const webp = completeWebp([vp8xChunk(1200, 630, 0x02), animChunk(), frame]);
    expect(() => imageDimensions(webp)).toThrow(/nonzero RIFF padding/);
  });

  it("rejects a PNG whose entire IDAT stream is empty", () => {
    // A zero-length IDAT is legal between real siblings, but an image whose
    // only IDAT is empty carries no zlib stream and must not verify.
    const emptyStream = Uint8Array.from([
      ...completePng(1200, 630).subarray(0, 8 + 12 + 13),
      ...pngChunk("IDAT", []),
      ...pngChunk("IDAT", []),
      ...pngChunk("IEND", []),
    ]);
    expect(() => imageDimensions(emptyStream)).toThrow(/no image data/);
  });

  it("accepts an empty IDAT before the real image data", () => {
    const base = completePng(1200, 630);
    const withLeadingEmptyIdat = Uint8Array.from([
      ...base.subarray(0, 8 + 12 + 13),
      ...pngChunk("IDAT", []),
      ...base.subarray(8 + 12 + 13),
    ]);
    expect(imageDimensions(withLeadingEmptyIdat)).toEqual({
      width: 1200,
      height: 630,
      format: "png",
    });
  });

  it("rejects a PNG whose IDAT stream is not a zlib datastream", () => {
    // A single IDAT byte cannot be a zlib stream: no header, no trailer.
    const base = completePng(1200, 630);
    const oneByteIdat = Uint8Array.from([
      ...base.subarray(0, 8 + 12 + 13),
      ...pngChunk("IDAT", [0x78]),
      ...pngChunk("IEND", []),
    ]);
    expect(() => imageDimensions(oneByteIdat)).toThrow(/zlib datastream/);
  });

  it("rejects a VP8X container whose only payload chunk is empty", () => {
    // A zero-length VP8 header inside a VP8X container must not count as image
    // data, or the empty-chunk attitude would reopen the VP8X-only hole.
    const canvas = (value: number) => [
      value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff,
    ];
    const vp8x = [
      0x56, 0x50, 0x38, 0x58, // "VP8X"
      0x0a, 0x00, 0x00, 0x00, // chunk length 10
      0x00, 0x00, 0x00, 0x00, // flags + reserved
      ...canvas(1199), // width - 1
      ...canvas(629), // height - 1
    ];
    // body = "WEBP" (4) + vp8x (18) + empty "VP8 " chunk (8); RIFF size = body + 4.
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x1e, 0x00, 0x00, 0x00, // declared RIFF size: 38 - 8
      0x57, 0x45, 0x42, 0x50, // "WEBP"
      ...vp8x,
      0x56, 0x50, 0x38, 0x20, // "VP8 "
      0x00, 0x00, 0x00, 0x00, // chunk length 0
    ]);
    expect(() => imageDimensions(webp)).toThrow(/no image or animation data/);
  });

  it("rejects a VP8X container with a stub VP8 frame", () => {
    // A ten-byte VP8 chunk of zeros claims the minimum frame header length but
    // carries no key-frame start code, so it must not count as image data.
    const canvas = (value: number) => [
      value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff,
    ];
    const vp8x = [
      0x56, 0x50, 0x38, 0x58, // "VP8X"
      0x0a, 0x00, 0x00, 0x00, // chunk length 10
      0x00, 0x00, 0x00, 0x00, // flags + reserved
      ...canvas(1199), // width - 1
      ...canvas(629), // height - 1
    ];
    const stubVp8 = [
      0x56, 0x50, 0x38, 0x20, // "VP8 "
      0x0a, 0x00, 0x00, 0x00, // chunk length 10
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // payload: ten zero bytes, no start code
    ];
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x28, 0x00, 0x00, 0x00, // declared RIFF size: 48 - 8
      0x57, 0x45, 0x42, 0x50, // "WEBP"
      ...vp8x,
      ...stubVp8,
    ]);
    expect(() => imageDimensions(webp)).toThrow(/malformed VP8 frame/);
  });

  it("rejects a VP8X container with a junk VP8L payload", () => {
    // A five-byte VP8L chunk meets the old minimum-length gate, but its first
    // byte is not the 0x2F lossless signature, so it is not a VP8L bitstream.
    const canvas = (value: number) => [
      value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff,
    ];
    const vp8x = [
      0x56, 0x50, 0x38, 0x58, // "VP8X"
      0x0a, 0x00, 0x00, 0x00, // chunk length 10
      0x00, 0x00, 0x00, 0x00, // flags + reserved
      ...canvas(1199), // width - 1
      ...canvas(629), // height - 1
    ];
    const junkVp8l = [
      0x56, 0x50, 0x38, 0x4c, // "VP8L"
      0x05, 0x00, 0x00, 0x00, // chunk length 5
      0x00, 0xaf, 0x44, 0x9d, 0x00, // payload: wrong signature byte, then packed dims
    ];
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x24, 0x00, 0x00, 0x00, // declared RIFF size: 44 - 8
      0x57, 0x45, 0x42, 0x50, // "WEBP"
      ...vp8x,
      ...junkVp8l,
      0x00, // pad the odd-length chunk to the declared RIFF size
    ]);
    expect(() => imageDimensions(webp)).toThrow(/malformed VP8L frame/);
  });

  it("rejects a VP8X container with a header-only ANMF frame", () => {
    // A 16-byte ANMF is only the frame header; without a nested VP8/VP8L
    // bitstream it carries no image data.
    const canvas = (value: number) => [
      value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff,
    ];
    const vp8x = [
      0x56, 0x50, 0x38, 0x58, // "VP8X"
      0x0a, 0x00, 0x00, 0x00, // chunk length 10
      0x00, 0x00, 0x00, 0x00, // flags + reserved
      ...canvas(1199), // width - 1
      ...canvas(629), // height - 1
    ];
    const headerOnlyAnmf = [
      0x41, 0x4e, 0x4d, 0x46, // "ANMF"
      0x10, 0x00, 0x00, 0x00, // chunk length 16
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16-byte frame header only
    ];
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x2e, 0x00, 0x00, 0x00, // declared RIFF size: 54 - 8
      0x57, 0x45, 0x42, 0x50, // "WEBP"
      ...vp8x,
      ...headerOnlyAnmf,
    ]);
    expect(() => imageDimensions(webp)).toThrow(/no image or animation data/);
  });

  it("accepts a VP8X container whose ANMF frame nests a VP8L bitstream", () => {
    const canvas = (value: number) => [
      value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff,
    ];
    const vp8x = [
      0x56, 0x50, 0x38, 0x58, // "VP8X"
      0x0a, 0x00, 0x00, 0x00, // chunk length 10
      0x00, 0x00, 0x00, 0x00, // flags + reserved
      ...canvas(1199), // width - 1
      ...canvas(629), // height - 1
    ];
    const nestedVp8l = [
      0x56, 0x50, 0x38, 0x4c, // "VP8L"
      0x05, 0x00, 0x00, 0x00, // chunk length 5
      0x2f, 0xaf, 0x44, 0x9d, 0x00, // 0x2F signature + 1200x630 packed dims
    ];
    // Frame payload: 16-byte header + 13-byte sub-chunk + 1 padding byte to
    // align the sub-chunk, all inside the declared ANMF length (16 + 14 = 30).
    const anmf = [
      0x41, 0x4e, 0x4d, 0x46, // "ANMF"
      0x1e, 0x00, 0x00, 0x00, // chunk length 30
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16-byte frame header
      ...nestedVp8l,
      0x00, // sub-chunk alignment padding inside the frame
    ];
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x3c, 0x00, 0x00, 0x00, // declared RIFF size: 68 - 8
      0x57, 0x45, 0x42, 0x50, // "WEBP"
      ...vp8x,
      ...anmf,
    ]);
    expect(imageDimensions(webp)).toEqual({ width: 1200, height: 630, format: "webp" });
  });

  it("rejects an ANMF frame with multiple image bitstreams", () => {
    const canvas = (value: number) => [
      value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff,
    ];
    const vp8x = [
      0x56, 0x50, 0x38, 0x58, // "VP8X"
      0x0a, 0x00, 0x00, 0x00, // chunk length 10
      0x00, 0x00, 0x00, 0x00, // flags + reserved
      ...canvas(1199), // width - 1
      ...canvas(629), // height - 1
    ];
    const vp8l = [
      0x56, 0x50, 0x38, 0x4c, // "VP8L"
      0x05, 0x00, 0x00, 0x00, // chunk length 5
      0x2f, 0xaf, 0x44, 0x9d, 0x00,
      0x00, // alignment padding
    ];
    const anmf = [
      0x41, 0x4e, 0x4d, 0x46, // "ANMF"
      0x2c, 0x00, 0x00, 0x00, // 16-byte header + two 14-byte VP8L chunks
      ...Array(16).fill(0),
      ...vp8l,
      ...vp8l,
    ];
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x4a, 0x00, 0x00, 0x00, // declared RIFF size: 82 - 8
      0x57, 0x45, 0x42, 0x50, // "WEBP"
      ...vp8x,
      ...anmf,
    ]);
    expect(() => imageDimensions(webp)).toThrow(/multiple image bitstreams/);
  });

  it("rejects an ANMF frame with duplicate ALPH chunks", () => {
    const canvas = (value: number) => [
      value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff,
    ];
    const vp8x = [
      0x56, 0x50, 0x38, 0x58, // "VP8X"
      0x0a, 0x00, 0x00, 0x00, // chunk length 10
      0x00, 0x00, 0x00, 0x00, // flags + reserved
      ...canvas(1199), // width - 1
      ...canvas(629), // height - 1
    ];
    const alph = [
      0x41, 0x4c, 0x50, 0x48, // "ALPH"
      0x01, 0x00, 0x00, 0x00, // chunk length 1
      0x00,
      0x00, // alignment padding
    ];
    const vp8l = [
      0x56, 0x50, 0x38, 0x4c, // "VP8L"
      0x05, 0x00, 0x00, 0x00, // chunk length 5
      0x2f, 0xaf, 0x44, 0x9d, 0x00,
      0x00, // alignment padding
    ];
    const anmf = [
      0x41, 0x4e, 0x4d, 0x46, // "ANMF"
      0x32, 0x00, 0x00, 0x00, // 16-byte header + two ALPH chunks + VP8L
      ...Array(16).fill(0),
      ...alph,
      ...alph,
      ...vp8l,
    ];
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x50, 0x00, 0x00, 0x00, // declared RIFF size: 88 - 8
      0x57, 0x45, 0x42, 0x50, // "WEBP"
      ...vp8x,
      ...anmf,
    ]);
    expect(() => imageDimensions(webp)).toThrow(/multiple ALPH chunks/);
  });

  it("rejects an ANMF frame whose second sub-chunk overruns the frame", () => {
    // A plausible first VP8L image must not let a malformed tail hide: the
    // whole frame is walked, so the second sub-chunk's overrun is caught.
    const canvas = (value: number) => [
      value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff,
    ];
    const vp8x = [
      0x56, 0x50, 0x38, 0x58, // "VP8X"
      0x0a, 0x00, 0x00, 0x00, // chunk length 10
      0x00, 0x00, 0x00, 0x00, // flags + reserved
      ...canvas(1199), // width - 1
      ...canvas(629), // height - 1
    ];
    const goodVp8l = [
      0x56, 0x50, 0x38, 0x4c, // "VP8L"
      0x05, 0x00, 0x00, 0x00, // chunk length 5
      0x2f, 0xaf, 0x44, 0x9d, 0x00,
    ];
    // Second sub-chunk declares 200 bytes inside a frame that has none left.
    const overrun = [
      0x56, 0x50, 0x38, 0x20, // "VP8 "
      0xc8, 0x00, 0x00, 0x00, // chunk length 200
    ];
    const anmf = [
      0x41, 0x4e, 0x4d, 0x46, // "ANMF"
      0x26, 0x00, 0x00, 0x00, // chunk length 16 + 14 + 8 = 38
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16-byte frame header
      ...goodVp8l,
      0x00, // alignment padding
      ...overrun,
    ];
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x44, 0x00, 0x00, 0x00, // declared RIFF size: 76 - 8
      0x57, 0x45, 0x42, 0x50, // "WEBP"
      ...vp8x,
      ...anmf,
    ]);
    expect(() => imageDimensions(webp)).toThrow(/truncated/);
  });

  it("rejects an ANMF frame nested inside another ANMF frame", () => {
    const canvas = (value: number) => [
      value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff,
    ];
    const vp8x = [
      0x56, 0x50, 0x38, 0x58, // "VP8X"
      0x0a, 0x00, 0x00, 0x00, // chunk length 10
      0x00, 0x00, 0x00, 0x00, // flags + reserved
      ...canvas(1199), // width - 1
      ...canvas(629), // height - 1
    ];
    const nestedAnmf = [
      0x41, 0x4e, 0x4d, 0x46, // "ANMF"
      0x10, 0x00, 0x00, 0x00, // chunk length 16: a frame header only
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ];
    const anmf = [
      0x41, 0x4e, 0x4d, 0x46, // "ANMF"
      0x28, 0x00, 0x00, 0x00, // chunk length 16 + 24 = 40
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16-byte frame header
      ...nestedAnmf,
    ];
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x46, 0x00, 0x00, 0x00, // declared RIFF size: 78 - 8
      0x57, 0x45, 0x42, 0x50, // "WEBP"
      ...vp8x,
      ...anmf,
    ]);
    expect(() => imageDimensions(webp)).toThrow(/cannot nest/);
  });

  it("rejects a top-level VP8 chunk declared shorter than its key-frame header", () => {
    // The reviewer's exact shell: a 30-byte file whose VP8 chunk declares 9
    // payload bytes, so the RIFF padding byte would become the second height
    // byte if dimensions were read before validating the declared length.
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x16, 0x00, 0x00, 0x00, // declared RIFF size: 30 - 8
      0x57, 0x45, 0x42, 0x50, // "WEBP"
      0x56, 0x50, 0x38, 0x20, // "VP8 "
      0x09, 0x00, 0x00, 0x00, // chunk length 9
      0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0xb0, 0x04, 0x76, // 9 payload bytes
      0x00, // RIFF padding byte
    ]);
    expect(() => imageDimensions(webp)).toThrow(/too short/);
  });

  it("rejects a top-level VP8L missing its signature byte", () => {
    // A lossless WebP whose first payload byte is not 0x2F is not a VP8L
    // bitstream even though it is long enough to carry dimensions.
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x16, 0x00, 0x00, 0x00, // declared RIFF size: 30 - 8
      0x57, 0x45, 0x42, 0x50, // "WEBP"
      0x56, 0x50, 0x38, 0x4c, // "VP8L"
      0x0a, 0x00, 0x00, 0x00, // chunk length 10
      0x00, 0xaf, 0x44, 0x9d, 0x00, 0, 0, 0, 0, 0, // payload: wrong signature, then dims
    ]);
    expect(() => imageDimensions(webp)).toThrow(/missing VP8L signature/);
  });

  it("rejects a JPEG whose SOS segment is bare", () => {
    // A frame header followed by a complaint `FF DA 00 00` SOS (no declared
    // length or component count) and then EOI has no scan to decode, so it
    // must fail rather than pass on a bare SOS marker.
    const withSof = [
      0xff, 0xd8, // SOI
      0xff, 0xc0, // SOF0
      0x00, 0x0b, // length 11 (Nf=1)
      0x08, 0x02, 0x76, 0x04, 0xb0, 0x01, 0x01, 0x22, 0x00, // precision/height/width/Nf/component
    ];
    const bareSos = Uint8Array.from([
      ...withSof,
      0xff, 0xda, 0x00, 0x00, // SOS marker with a zero length
      0xff, 0xd9, // EOI
    ]);
    expect(() => imageDimensions(bareSos)).toThrow(/SOS segment/);
  });

  it("rejects a JPEG whose scan contains no entropy-coded data", () => {
    // A well-formed SOS followed immediately by EOI has a valid header but an
    // empty scan: there is nothing to decode, so it must not verify.
    const withSof = [
      0xff, 0xd8, // SOI
      0xff, 0xc0, // SOF0
      0x00, 0x0b, // length 11 (Nf=1)
      0x08, 0x02, 0x76, 0x04, 0xb0, 0x01, 0x01, 0x22, 0x00, // precision/height/width/Nf/component
    ];
    const emptyScan = Uint8Array.from([
      ...withSof,
      0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, // SOS: length 8, 1 component
      0xff, 0xd9, // EOI immediately after the SOS segment
    ]);
    expect(() => imageDimensions(emptyScan)).toThrow(/no entropy-coded data/);
  });

  it("rejects a multi-scan JPEG whose first scan contains no entropy-coded data", () => {
    // A later scan's data cannot make an earlier empty scan valid. Progressive
    // JPEGs are multi-scan, so validate each scan before its next SOS marker.
    const withSof = [
      0xff, 0xd8, // SOI
      0xff, 0xc2, // SOF2 (progressive, multi-scan capable)
      0x00, 0x0b, // length 11 (Nf=1)
      0x08, 0x02, 0x76, 0x04, 0xb0, 0x01, 0x01, 0x22, 0x00, // precision/height/width/Nf/component
    ];
    const emptyFirstScan = Uint8Array.from([
      ...withSof,
      0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, // first (DC) SOS
      0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x01, 0x3f, 0x00, // later (AC) SOS
      0x01, // entropy-coded data for the later scan
      0xff, 0xd9, // EOI
    ]);
    expect(() => imageDimensions(emptyFirstScan)).toThrow(/no entropy-coded data/);
  });

  it("rejects a JPEG whose scan contains a marker but no entropy-coded data", () => {
    // A DHT marker between SOS and EOI must not count as compressed data:
    // there is still no entropy-coded byte in the scan.
    const withSof = [
      0xff, 0xd8, // SOI
      0xff, 0xc0, // SOF0
      0x00, 0x0b, // length 11 (Nf=1)
      0x08, 0x02, 0x76, 0x04, 0xb0, 0x01, 0x01, 0x22, 0x00,
    ];
    const markerOnly = Uint8Array.from([
      ...withSof,
      0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, // SOS
      0xff, 0xc4, 0x00, 0x02, // DHT segment with no table data
      0xff, 0xd9, // EOI
    ]);
    expect(() => imageDimensions(markerOnly)).toThrow(/no entropy-coded data/);
  });

  it("accepts a marker segment between entropy-coded data", () => {
    // JPEG allows marker segments between entropy-coded segments of a scan;
    // parsing them must resume the scan rather than treat them as data.
    const withSof = [
      0xff, 0xd8, // SOI
      0xff, 0xc0, // SOF0
      0x00, 0x0b, // length 11 (Nf=1)
      0x08, 0x02, 0x76, 0x04, 0xb0, 0x01, 0x01, 0x22, 0x00,
    ];
    const withMarker = Uint8Array.from([
      ...withSof,
      0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, // SOS
      0x01, 0x02, // entropy-coded bytes
      0xff, 0xc4, 0x00, 0x02, // DHT segment between entropy data
      0x03, 0x04, // more entropy-coded bytes
      0xff, 0xd9, // EOI
    ]);
    expect(imageDimensions(withMarker)).toEqual({ width: 1200, height: 630, format: "jpeg" });
  });

  it("rejects a JPEG whose SOF declares a mismatched component count", () => {
    // The frame header must declare 8 + 3*Nf bytes; length 11 with Nf=2 is a
    // header shell that claims more components than it carries.
    const badSof = Uint8Array.from([
      0xff, 0xd8, // SOI
      0xff, 0xc0, // SOF0
      0x00, 0x0b, // length 11
      0x08, 0x02, 0x76, 0x04, 0xb0, 0x02, 0x01, 0x22, 0x00, // ...but Nf=2
      0xff, 0xd9, // EOI
    ]);
    expect(() => imageDimensions(badSof)).toThrow(/malformed frame header/);
  });
});

describe("verifyImage", () => {
  it("returns the format it verified", () => {
    expect(verifyImage(fixture("card.jpg"), { width: 1200, height: 630 })).toEqual({
      width: 1200,
      height: 630,
      format: "jpeg",
    });
  });

  it("reports a mismatch against the expected size", () => {
    expect(() => verifyImage(fixture("icon.jpg"), { width: 1200, height: 630 })).toThrow(
      "Expected 1200x630, received 512x512",
    );
  });
});
