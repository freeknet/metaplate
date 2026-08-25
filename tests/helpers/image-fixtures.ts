import { readFileSync } from "node:fs";
import path from "node:path";

/** Real encoder output checked into tests/fixtures. */
export function fixture(name: string) {
  return readFileSync(path.join(import.meta.dirname, "..", "fixtures", name));
}

/** PNG chunk with a zero CRC for structural tests that do not verify CRC-32. */
export function pngChunk(type: string, payload: number[]): number[] {
  const data = payload.length;
  const length = [
    (data >>> 24) & 0xff,
    (data >>> 16) & 0xff,
    (data >>> 8) & 0xff,
    data & 0xff,
  ];
  return [
    ...length,
    ...type.split("").map((character) => character.charCodeAt(0)),
    ...payload,
    0,
    0,
    0,
    0,
  ];
}

export function uint32be(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

export function completePng(width: number, height: number): Uint8Array {
  const ihdr = [
    ...uint32be(width),
    ...uint32be(height),
    8,
    6,
    0,
    0,
    0,
  ];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk("IHDR", ihdr),
    ...pngChunk("IDAT", [
      0x78, 0x9c, 0x01, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01, 0x00,
      0x01,
    ]),
    ...pngChunk("IEND", []),
  ]);
}

export function uint24(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

export function webpChunk(type: string, payload: number[]): number[] {
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

export function completeWebp(chunks: number[][]): Uint8Array {
  const body = [0x57, 0x45, 0x42, 0x50, ...chunks.flat()];
  return Uint8Array.from([
    0x52,
    0x49,
    0x46,
    0x46,
    body.length & 0xff,
    (body.length >>> 8) & 0xff,
    (body.length >>> 16) & 0xff,
    (body.length >>> 24) & 0xff,
    ...body,
  ]);
}

export function vp8xChunk(width: number, height: number, flags = 0): number[] {
  return webpChunk("VP8X", [
    flags,
    0,
    0,
    0,
    ...uint24(width - 1),
    ...uint24(height - 1),
  ]);
}

export function animChunk(): number[] {
  return webpChunk("ANIM", [0, 0, 0, 0, 0, 0]);
}

export function vp8lChunk(): number[] {
  return webpChunk("VP8L", [0x2f, 0, 0, 0, 0]);
}

export function vp8KeyFrameChunk(
  firstPartitionLength: number,
  extraData: number[] = [],
): number[] {
  const tag = firstPartitionLength << 5;
  return webpChunk("VP8 ", [
    tag & 0xff,
    (tag >>> 8) & 0xff,
    (tag >>> 16) & 0xff,
    0x9d,
    0x01,
    0x2a,
    0xb0,
    0x04,
    0x76,
    0x02,
    ...extraData,
  ]);
}

export function anmfChunk(
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
    0,
    0,
    0,
    0,
    ...childChunks.flat(),
  ]);
}

/** Complete synthetic baseline JPEG used only for structural validation. */
export function completeJpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xda,
    0x00,
    0x08,
    0x01,
    0x01,
    0x00,
    0x00,
    0x3f,
    0x00,
    0x01,
    0xff,
    0xd9,
  ]);
}
