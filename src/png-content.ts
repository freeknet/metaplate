import { inflateSync } from "node:zlib";

/**
 * Not an entry point: the PNG pixel decoder behind `metaplate verify
 * --require-content`. It uses `node:zlib`, so only the Node CLI imports it;
 * the runtime-neutral `metaplate/png` stays header-only.
 *
 * It decodes exactly far enough to answer one question, whether every pixel
 * is the same color, for every PNG the specification allows: grayscale,
 * truecolor, indexed, and their alpha forms, at every legal bit depth, and
 * Adam7-interlaced images. https://www.w3.org/TR/png-3/
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Samples per pixel for each color type, with the bit depths it allows. */
const COLOR_TYPES: ReadonlyMap<number, { channels: number; depths: readonly number[] }> = new Map([
  [0, { channels: 1, depths: [1, 2, 4, 8, 16] }],
  [2, { channels: 3, depths: [8, 16] }],
  [3, { channels: 1, depths: [1, 2, 4, 8] }],
  [4, { channels: 2, depths: [8, 16] }],
  [6, { channels: 4, depths: [8, 16] }],
]);

/** Adam7 passes as [x start, y start, x step, y step]. */
export const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

type Header = {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  channels: number;
  interlaced: boolean;
};

type Parsed = {
  header: Header;
  palette?: Uint8Array;
  transparency?: Uint8Array;
  data: Uint8Array;
};

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000) +
    (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0))
  );
}

function fail(message: string): never {
  throw new Error(`Cannot decode PNG pixels: ${message}`);
}

function readHeader(data: Uint8Array): Header {
  if (data.length !== 13) fail("IHDR is not 13 bytes");
  const depth = data[8] ?? 0;
  const colorType = data[9] ?? 0;
  const type = COLOR_TYPES.get(colorType);
  if (!type || !type.depths.includes(depth)) {
    fail(`unsupported color type ${colorType} at bit depth ${depth}`);
  }
  const interlace = data[12];
  if (data[10] !== 0 || data[11] !== 0 || (interlace !== 0 && interlace !== 1)) {
    fail("unknown compression, filter, or interlace method");
  }
  return {
    width: readUint32(data, 0),
    height: readUint32(data, 4),
    depth,
    colorType,
    channels: type.channels,
    interlaced: interlace === 1,
  };
}

/** Walks the chunks, keeping the ones that decide the pixels' colors. */
function parseChunks(bytes: Uint8Array): Parsed {
  if (bytes.length < 8 || SIGNATURE.some((value, index) => bytes[index] !== value)) fail("not a PNG");
  let header: Header | undefined;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const data: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) fail(`${type} chunk runs past the end of the file`);
    const chunk = bytes.subarray(start, end);
    if (type === "IHDR") header = readHeader(chunk);
    else if (type === "PLTE") palette = chunk;
    else if (type === "tRNS") transparency = chunk;
    else if (type === "IDAT") data.push(chunk);
    else if (type === "IEND") break;
    offset = end + 4;
  }
  if (!header) fail("no IHDR chunk");
  if (data.length === 0) fail("no IDAT chunk");
  if (header.colorType === 3 && !palette) fail("indexed image without a PLTE chunk");
  return {
    header,
    ...(palette ? { palette } : {}),
    ...(transparency ? { transparency } : {}),
    data: Buffer.concat(data),
  };
}

type Pass = { width: number; height: number; rowBytes: number };

/** The reduced images the scanlines are stored as: one, or seven for Adam7. */
function passes(header: Header): Pass[] {
  const bits = header.channels * header.depth;
  const pass = (width: number, height: number): Pass => ({ width, height, rowBytes: Math.ceil((width * bits) / 8) });
  if (!header.interlaced) return [pass(header.width, header.height)];
  return ADAM7.map(([x, y, dx, dy]) =>
    pass(Math.max(0, Math.ceil((header.width - x) / dx)), Math.max(0, Math.ceil((header.height - y) / dy))),
  ).filter((reduced) => reduced.width > 0 && reduced.height > 0);
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** Reverses one scanline's filter in place, given the previous unfiltered row. */
function unfilter(filter: number, row: Uint8Array, previous: Uint8Array, stride: number): void {
  for (let index = 0; index < row.length; index += 1) {
    const left = index >= stride ? row[index - stride]! : 0;
    const up = previous[index]!;
    const upLeft = index >= stride ? previous[index - stride]! : 0;
    let predictor: number;
    if (filter === 0) predictor = 0;
    else if (filter === 1) predictor = left;
    else if (filter === 2) predictor = up;
    else if (filter === 3) predictor = (left + up) >>> 1;
    else if (filter === 4) predictor = paeth(left, up, upLeft);
    else fail(`unknown scanline filter ${filter}`);
    row[index] = (row[index]! + predictor) & 0xff;
  }
}

type Color = [number, number, number, number];

/** Converts one pixel to RGBA at the image's own sample precision. */
function pixelReader(parsed: Parsed): (row: Uint8Array, x: number) => Color {
  const { depth, channels, colorType } = parsed.header;
  const max = 2 ** depth - 1;
  const sample = (row: Uint8Array, index: number): number => {
    if (depth === 8) return row[index]!;
    if (depth === 16) return (row[index * 2]! << 8) | row[index * 2 + 1]!;
    const bit = index * depth;
    return (row[bit >>> 3]! >>> (8 - depth - (bit & 7))) & max;
  };
  const trns = parsed.transparency;
  const key = (index: number) => (trns ? (trns[index * 2]! << 8) | trns[index * 2 + 1]! : -1);

  if (colorType === 3) {
    const palette = parsed.palette!;
    return (row, x) => {
      const entry = sample(row, x);
      if (entry * 3 + 2 >= palette.length) fail(`palette index ${entry} is out of range`);
      return [palette[entry * 3]!, palette[entry * 3 + 1]!, palette[entry * 3 + 2]!, trns?.[entry] ?? 255];
    };
  }
  if (colorType === 0) {
    return (row, x) => {
      const gray = sample(row, x);
      return [gray, gray, gray, gray === key(0) ? 0 : max];
    };
  }
  if (colorType === 2) {
    return (row, x) => {
      const [r, g, b] = [sample(row, x * 3), sample(row, x * 3 + 1), sample(row, x * 3 + 2)];
      const keyed = r === key(0) && g === key(1) && b === key(2);
      return [r, g, b, keyed ? 0 : max];
    };
  }
  return (row, x) => {
    const base = x * channels;
    const gray = sample(row, base);
    if (colorType === 4) return [gray, gray, gray, sample(row, base + 1)];
    return [gray, sample(row, base + 1), sample(row, base + 2), sample(row, base + 3)];
  };
}

/** Fully transparent pixels count as one color, whatever their channels hold. */
function normalize(color: Color): Color {
  return color[3] === 0 ? [0, 0, 0, 0] : color;
}

/**
 * The single RGBA color (8 bits per channel) of every pixel of a PNG, or
 * `undefined` when any two pixels differ. Fully transparent pixels compare
 * equal whatever their color channels hold. Throws for bytes it cannot
 * decode, so a damaged file is never reported as having content.
 */
export function pngUniformColor(bytes: Uint8Array): Color | undefined {
  const parsed = parseChunks(bytes);
  const { header } = parsed;
  const reduced = passes(header);
  const expected = reduced.reduce((total, pass) => total + pass.height * (pass.rowBytes + 1), 0);
  let pixels: Uint8Array;
  try {
    // The decoded size is known from IHDR, so a deflate stream that expands
    // further (a decompression bomb, or garbage) is cut off rather than
    // allocated.
    pixels = inflateSync(parsed.data, { maxOutputLength: Math.max(expected, 1) });
  } catch (error) {
    fail(`image data does not inflate to ${expected} bytes (${error instanceof Error ? error.message : String(error)})`);
  }
  if (pixels.length < expected) fail(`image data inflates to ${pixels.length} bytes, expected ${expected}`);

  const read = pixelReader(parsed);
  const stride = Math.max(1, (header.channels * header.depth) / 8);
  let first: Color | undefined;
  let offset = 0;
  for (const pass of reduced) {
    let previous: Uint8Array = new Uint8Array(pass.rowBytes);
    for (let y = 0; y < pass.height; y += 1) {
      const filter = pixels[offset]!;
      const row = pixels.subarray(offset + 1, offset + 1 + pass.rowBytes);
      offset += pass.rowBytes + 1;
      unfilter(filter, row, previous, stride);
      previous = row;
      for (let x = 0; x < pass.width; x += 1) {
        const color = normalize(read(row, x));
        if (!first) first = color;
        else if (color.some((value, channel) => value !== first![channel])) return undefined;
      }
    }
  }
  if (!first) return undefined;
  const scale = 255 / (2 ** (header.colorType === 3 ? 8 : header.depth) - 1);
  return first.map((value) => Math.round(value * scale)) as Color;
}
