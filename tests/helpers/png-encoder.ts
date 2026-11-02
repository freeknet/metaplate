import { deflateSync } from "node:zlib";
import { ADAM7 } from "../../src/png-content.js";
import { pngChunk, uint32be } from "./image-fixtures.js";

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export type PngSpec = {
  width: number;
  height: number;
  colorType: 0 | 2 | 3 | 4 | 6;
  depth: 1 | 2 | 4 | 8 | 16;
  /** The samples of one pixel, at the image's bit depth. */
  pixel: (x: number, y: number) => number[];
  interlace?: boolean;
  /** Scanline filter applied to every row (0 none, 1 sub, 2 up, 3 average, 4 Paeth). */
  filter?: 0 | 1 | 2 | 3 | 4;
  palette?: number[];
  transparency?: number[];
};

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const [a, b, c] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)];
  if (a <= b && a <= c) return left;
  return b <= c ? up : upLeft;
}

function packRow(spec: PngSpec, xs: number[], y: number): number[] {
  const bytes: number[] = [];
  let bits = 0;
  let accumulator = 0;
  for (const x of xs) {
    for (const sample of spec.pixel(x, y)) {
      if (spec.depth === 16) bytes.push(sample >>> 8, sample & 0xff);
      else if (spec.depth === 8) bytes.push(sample);
      else {
        accumulator = (accumulator << spec.depth) | sample;
        bits += spec.depth;
        if (bits === 8) {
          bytes.push(accumulator);
          accumulator = 0;
          bits = 0;
        }
      }
    }
  }
  if (bits > 0) bytes.push(accumulator << (8 - bits));
  return bytes;
}

function filterRow(filter: number, row: number[], previous: number[], stride: number): number[] {
  return row.map((value, index) => {
    const left = index >= stride ? row[index - stride]! : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= stride ? previous[index - stride] ?? 0 : 0;
    const predictor = [0, left, up, (left + up) >>> 1, paeth(left, up, upLeft)][filter]!;
    return (value - predictor) & 0xff;
  });
}

/** Encodes a PNG (with zero CRCs, which no reader under test checks). */
export function encodePng(spec: PngSpec): Uint8Array {
  const filter = spec.filter ?? 0;
  const stride = Math.max(1, (CHANNELS[spec.colorType]! * spec.depth) / 8);
  const passes = spec.interlace ? ADAM7 : [[0, 0, 1, 1] as const];
  const raw: number[] = [];
  for (const [x0, y0, dx, dy] of passes) {
    const xs: number[] = [];
    for (let x = x0; x < spec.width; x += dx) xs.push(x);
    if (xs.length === 0) continue;
    let previous: number[] = [];
    for (let y = y0; y < spec.height; y += dy) {
      const row = packRow(spec, xs, y);
      raw.push(filter, ...filterRow(filter, row, previous, stride));
      previous = row;
    }
  }
  const header = [...uint32be(spec.width), ...uint32be(spec.height), spec.depth, spec.colorType, 0, 0, spec.interlace ? 1 : 0];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk("IHDR", header),
    ...(spec.palette ? pngChunk("PLTE", spec.palette) : []),
    ...(spec.transparency ? pngChunk("tRNS", spec.transparency) : []),
    ...pngChunk("IDAT", [...deflateSync(Uint8Array.from(raw))]),
    ...pngChunk("IEND", []),
  ]);
}
