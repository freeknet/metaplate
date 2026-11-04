/**
 * Not an entry point: the JPEG decoder behind `metaplate verify
 * --require-content`, beside the PNG one in `png-content.ts`.
 *
 * It entropy-decodes the DCT coefficients of baseline, extended, and
 * progressive Huffman JPEGs (ITU T.81 Annex F and G).
 * https://www.w3.org/Graphics/JPEG/itu-t81.pdf
 *
 * `jpegUniformColor` needs no inverse DCT: it reports a single color only
 * when every 8x8 block that covers the image, in every component, holds the
 * same DC value and no AC energy. Such blocks decode to one flat sample,
 * chroma upsampling keeps it flat, and color conversion maps it to one
 * color, so a card with content is never reported blank.
 *
 * `decodeJpegPixels` runs the full decode for `compareImages`: dequantization,
 * a floating-point inverse DCT, bilinear chroma upsampling between sample
 * centers, and color conversion. Its output can differ from libjpeg's by a
 * few levels where chroma changes sharply; both sides of a comparison go
 * through the same decoder, so that never reads as a change.
 *
 * Lossless, hierarchical, and arithmetic-coded JPEGs are refused, as is any
 * file it cannot decode, so a damaged file is never reported as having
 * content.
 */

import { MAX_DECODED_PIXELS, type DecodedPixels } from "./png-content.js";

type Color = [number, number, number, number];

type Huffman = { values: Uint8Array; maxCode: Int32Array; valueOffset: Int32Array };

type Component = {
  id: number;
  h: number;
  v: number;
  quantTable: number;
  /** Blocks per line and column, padded to whole MCUs. */
  blocksPerLine: number;
  blocksPerColumn: number;
  /** Blocks that cover the image itself, before MCU padding. */
  visibleBlocksPerLine: number;
  visibleBlocksPerColumn: number;
  /** 64 coefficients per block, in zigzag order. */
  coefficients: Int32Array;
  scanned: boolean;
};

type Frame = {
  progressive: boolean;
  precision: number;
  width: number;
  height: number;
  maxH: number;
  maxV: number;
  mcusPerLine: number;
  mcusPerColumn: number;
  components: Component[];
};

function fail(message: string): never {
  throw new Error(`Cannot decode JPEG pixels: ${message}`);
}

function readUint16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) fail("segment runs past the end of the file");
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

/** Builds the canonical code tables of Annex C from a DHT definition. */
function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxCode = new Int32Array(17).fill(-1);
  const valueOffset = new Int32Array(17);
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length += 1) {
    const count = counts[length - 1]!;
    if (count > 0) {
      valueOffset[length] = index - code;
      code += count;
      index += count;
      if (code > 2 ** length) fail("Huffman table assigns more codes than its lengths allow");
      maxCode[length] = code - 1;
    }
    code <<= 1;
  }
  return { values, maxCode, valueOffset };
}

/** Reads the entropy-coded data of one scan, undoing 0xFF00 byte stuffing. */
class BitReader {
  private buffer = 0;
  private count = 0;

  constructor(private readonly bytes: Uint8Array, public position: number) {}

  /** At a marker or the end of the file, pads with zero bits as libjpeg does. */
  bit(): number {
    if (this.count === 0) {
      const byte = this.bytes[this.position];
      if (byte === undefined) {
        this.buffer = 0;
      } else if (byte === 0xff) {
        const next = this.bytes[this.position + 1];
        if (next === 0x00) {
          this.buffer = 0xff;
          this.position += 2;
        } else {
          this.buffer = 0;
        }
      } else {
        this.buffer = byte;
        this.position += 1;
      }
      this.count = 8;
    }
    this.count -= 1;
    return (this.buffer >> this.count) & 1;
  }

  bits(length: number): number {
    let value = 0;
    for (let index = 0; index < length; index += 1) value = (value << 1) | this.bit();
    return value;
  }

  /** `RECEIVE` and `EXTEND` (F.2.2.1): a signed magnitude of `length` bits. */
  signed(length: number): number {
    if (length === 0) return 0;
    const value = this.bits(length);
    return value < 1 << (length - 1) ? value - (1 << length) + 1 : value;
  }

  decode(table: Huffman | undefined): number {
    if (!table) fail("scan uses an undefined Huffman table");
    let code = this.bit();
    for (let length = 1; length <= 16; length += 1) {
      if (code <= table.maxCode[length]!) {
        const value = table.values[table.valueOffset[length]! + code];
        if (value === undefined) fail("Huffman code points past its table");
        return value;
      }
      code = (code << 1) | this.bit();
    }
    return fail("invalid Huffman code");
  }

  /** Drops the bits left in the current byte, for a restart marker or the scan's end. */
  align(): void {
    this.count = 0;
  }
}

type ScanComponent = { component: Component; dc: Huffman | undefined; ac: Huffman | undefined; predictor: number };

type Scan = {
  components: ScanComponent[];
  start: number;
  end: number;
  high: number;
  low: number;
};

/** Decodes one scan into the components' coefficients; returns where the scan's data ends. */
function decodeScan(bytes: Uint8Array, offset: number, frame: Frame, scan: Scan, restartInterval: number): number {
  const reader = new BitReader(bytes, offset);
  const { start, end, high, low } = scan;
  let endOfBands = 0;
  // Annex G.1.2.3 refinement state, carried across blocks within an end-of-band run.
  let refineState = 0;
  let refineValue = 0;

  const baseline = (entry: ScanComponent, data: Int32Array, base: number) => {
    entry.predictor += reader.signed(reader.decode(entry.dc));
    data[base] = entry.predictor;
    for (let k = 1; k < 64;) {
      const symbol = reader.decode(entry.ac);
      const size = symbol & 15;
      const run = symbol >> 4;
      if (size === 0) {
        if (run < 15) break;
        k += 16;
        continue;
      }
      k += run;
      if (k > 63) fail("AC coefficient past the end of the block");
      data[base + k] = reader.signed(size);
      k += 1;
    }
  };
  const dcFirst = (entry: ScanComponent, data: Int32Array, base: number) => {
    entry.predictor += reader.signed(reader.decode(entry.dc));
    data[base] = entry.predictor * 2 ** low;
  };
  const dcRefine = (_entry: ScanComponent, data: Int32Array, base: number) => {
    if (reader.bit()) data[base] = data[base]! | (1 << low);
  };
  const acFirst = (entry: ScanComponent, data: Int32Array, base: number) => {
    if (endOfBands > 0) {
      endOfBands -= 1;
      return;
    }
    for (let k = start; k <= end;) {
      const symbol = reader.decode(entry.ac);
      const size = symbol & 15;
      const run = symbol >> 4;
      if (size === 0) {
        if (run < 15) {
          endOfBands = reader.bits(run) + (1 << run) - 1;
          break;
        }
        k += 16;
        continue;
      }
      k += run;
      if (k > end) fail("AC coefficient past the end of the spectral band");
      data[base + k] = reader.signed(size) * 2 ** low;
      k += 1;
    }
  };
  const acRefine = (entry: ScanComponent, data: Int32Array, base: number) => {
    let run = 0;
    for (let k = start; k <= end;) {
      const index = base + k;
      const current = data[index]!;
      const correct = () => {
        if (reader.bit()) data[index] = current + (current < 0 ? -1 : 1) * (1 << low);
      };
      if (refineState === 0) {
        const symbol = reader.decode(entry.ac);
        const size = symbol & 15;
        run = symbol >> 4;
        if (size === 0) {
          if (run < 15) {
            endOfBands = reader.bits(run) + (1 << run);
            refineState = 4;
          } else {
            run = 16;
            refineState = 1;
          }
        } else {
          if (size !== 1) fail("refinement scan codes a coefficient wider than one bit");
          refineValue = reader.signed(1);
          refineState = run ? 2 : 3;
        }
        continue;
      }
      if (current !== 0) {
        correct();
      } else if (refineState === 1 || refineState === 2) {
        run -= 1;
        if (run === 0) refineState = refineState === 2 ? 3 : 0;
      } else if (refineState === 3) {
        data[index] = refineValue * (1 << low);
        refineState = 0;
      }
      k += 1;
    }
    if (refineState === 4) {
      endOfBands -= 1;
      if (endOfBands === 0) refineState = 0;
    }
  };

  let decodeBlock: (entry: ScanComponent, data: Int32Array, base: number) => void;
  if (!frame.progressive) decodeBlock = baseline;
  else if (start === 0) decodeBlock = high === 0 ? dcFirst : dcRefine;
  else decodeBlock = high === 0 ? acFirst : acRefine;

  const blockAt = (entry: ScanComponent, row: number, column: number) => {
    const { component } = entry;
    decodeBlock(entry, component.coefficients, (row * component.blocksPerLine + column) * 64);
  };

  // A single-component scan codes only the blocks that cover the image, one
  // per MCU; an interleaved scan codes whole MCUs (A.2).
  const single = scan.components.length === 1 ? scan.components[0]! : undefined;
  const mcus = single
    ? single.component.visibleBlocksPerLine * single.component.visibleBlocksPerColumn
    : frame.mcusPerLine * frame.mcusPerColumn;

  for (let mcu = 0; mcu < mcus; mcu += 1) {
    if (restartInterval > 0 && mcu > 0 && mcu % restartInterval === 0) {
      reader.align();
      let position = reader.position;
      while (bytes[position] === 0xff && bytes[position + 1] === 0xff) position += 1;
      const marker = bytes[position + 1] ?? 0;
      if (bytes[position] !== 0xff || marker < 0xd0 || marker > 0xd7) fail("expected a restart marker");
      reader.position = position + 2;
      for (const entry of scan.components) entry.predictor = 0;
      endOfBands = 0;
      refineState = 0;
    }
    if (single) {
      const perLine = single.component.visibleBlocksPerLine;
      blockAt(single, Math.floor(mcu / perLine), mcu % perLine);
      continue;
    }
    const mcuRow = Math.floor(mcu / frame.mcusPerLine);
    const mcuColumn = mcu % frame.mcusPerLine;
    for (const entry of scan.components) {
      for (let y = 0; y < entry.component.v; y += 1) {
        for (let x = 0; x < entry.component.h; x += 1) {
          blockAt(entry, mcuRow * entry.component.v + y, mcuColumn * entry.component.h + x);
        }
      }
    }
  }
  reader.align();
  return reader.position;
}

function readFrame(segment: Uint8Array, progressive: boolean): Frame {
  if (segment.length < 6) fail("SOF segment is too short");
  const precision = segment[0]!;
  const height = readUint16(segment, 1);
  const width = readUint16(segment, 3);
  const count = segment[5]!;
  if (precision !== 8 && precision !== 12) fail(`unsupported sample precision ${precision}`);
  if (height === 0) fail("the image height is defined by a DNL marker, which is not supported");
  if (width === 0 || (count !== 1 && count !== 3 && count !== 4)) fail("invalid frame header");
  if (segment.length < 6 + count * 3) fail("SOF segment is too short");
  const parts = Array.from({ length: count }, (_, index) => {
    const base = 6 + index * 3;
    const sampling = segment[base + 1]!;
    return { id: segment[base]!, h: sampling >> 4, v: sampling & 15, quantTable: segment[base + 2]! };
  });
  if (parts.some(({ h, v, quantTable }) => h < 1 || h > 4 || v < 1 || v > 4 || quantTable > 3)) {
    fail("invalid component sampling factors or quantization table");
  }
  const maxH = Math.max(...parts.map(({ h }) => h));
  const maxV = Math.max(...parts.map(({ v }) => v));
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerColumn = Math.ceil(height / (8 * maxV));
  const components = parts.map((part): Component => {
    const blocksPerLine = mcusPerLine * part.h;
    const blocksPerColumn = mcusPerColumn * part.v;
    return {
      ...part,
      blocksPerLine,
      blocksPerColumn,
      visibleBlocksPerLine: Math.ceil(Math.ceil((width * part.h) / maxH) / 8),
      visibleBlocksPerColumn: Math.ceil(Math.ceil((height * part.v) / maxV) / 8),
      coefficients: new Int32Array(blocksPerLine * blocksPerColumn * 64),
      scanned: false,
    };
  });
  return { progressive, precision, width, height, maxH, maxV, mcusPerLine, mcusPerColumn, components };
}

/**
 * The one coefficient set every covering block of a component shares when it
 * is flat (no AC energy), or `undefined` when two blocks differ or any block
 * has detail.
 */
function flatDc(component: Component): number | undefined {
  const data = component.coefficients;
  const dc = data[0]!;
  for (let row = 0; row < component.visibleBlocksPerColumn; row += 1) {
    for (let column = 0; column < component.visibleBlocksPerLine; column += 1) {
      const base = (row * component.blocksPerLine + column) * 64;
      if (data[base] !== dc) return undefined;
      for (let k = 1; k < 64; k += 1) if (data[base + k] !== 0) return undefined;
    }
  }
  return dc;
}

const clamp = (value: number) => Math.min(255, Math.max(0, Math.round(value)));

function ycc(y: number, cb: number, cr: number): [number, number, number] {
  return [
    clamp(y + 1.402 * (cr - 128)),
    clamp(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)),
    clamp(y + 1.772 * (cb - 128)),
  ];
}

/**
 * Converts component samples to RGBA, following JFIF and Adobe's APP14
 * transform flag. The choice is made once per frame, not per pixel.
 */
function colorConverter(frame: Frame, adobeTransform: number | undefined): (samples: readonly number[]) => Color {
  const count = frame.components.length;
  if (count === 1) return ([gray]) => [clamp(gray!), clamp(gray!), clamp(gray!), 255];
  if (count === 3) {
    const rgbIds = frame.components.map(({ id }) => id).join() === "82,71,66";
    if ((adobeTransform ?? (rgbIds ? 0 : 1)) === 0) return ([r, g, b]) => [clamp(r!), clamp(g!), clamp(b!), 255];
    return ([y, cb, cr]) => [...ycc(y!, cb!, cr!), 255];
  }
  // Four components: CMYK, or YCCK with transform 2; Adobe stores them inverted.
  const inverted = adobeTransform !== undefined;
  const light = (value: number) => (inverted ? value : 255 - value);
  return ([a, b, c, k]) => {
    const cmy = adobeTransform === 2 ? ycc(a!, b!, c!).map((value) => 255 - value) : [a!, b!, c!];
    return [...cmy.map((value) => clamp((light(value) * light(k!)) / 255)), 255] as Color;
  };
}

type Parsed = {
  frame: Frame;
  /** Each table's 64 steps, in zigzag order like the coefficients. */
  quantization: Map<number, Int32Array>;
  adobeTransform: number | undefined;
};

/** Reads every marker segment and entropy-decodes every scan into the frame's coefficients. */
function parseJpeg(bytes: Uint8Array): Parsed {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) fail("not a JPEG");
  const quantization = new Map<number, Int32Array>();
  const dcTables = new Map<number, Huffman>();
  const acTables = new Map<number, Huffman>();
  let frame: Frame | undefined;
  let restartInterval = 0;
  let adobeTransform: number | undefined;
  let offset = 2;

  for (;;) {
    while (bytes[offset] === 0xff && bytes[offset + 1] === 0xff) offset += 1;
    if (offset + 2 > bytes.length) fail("the file ends before its EOI marker");
    if (bytes[offset] !== 0xff) fail(`expected a marker at byte ${offset}`);
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = readUint16(bytes, offset);
    if (length < 2 || offset + length > bytes.length) fail("segment runs past the end of the file");
    const segment = bytes.subarray(offset + 2, offset + length);
    offset += length;

    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (frame) fail("more than one frame");
      frame = readFrame(segment, marker === 0xc2);
    } else if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      fail("lossless, hierarchical, and arithmetic-coded JPEGs are not supported");
    } else if (marker === 0xdb) {
      for (let at = 0; at < segment.length;) {
        const precision = segment[at]! >> 4;
        const id = segment[at]! & 15;
        const size = precision === 0 ? 64 : 128;
        if (at + 1 + size > segment.length || id > 3) fail("invalid DQT segment");
        const steps = new Int32Array(64);
        for (let k = 0; k < 64; k += 1) {
          steps[k] = precision === 0 ? segment[at + 1 + k]! : readUint16(segment, at + 1 + k * 2);
        }
        quantization.set(id, steps);
        at += 1 + size;
      }
    } else if (marker === 0xc4) {
      for (let at = 0; at < segment.length;) {
        const tableClass = segment[at]! >> 4;
        const id = segment[at]! & 15;
        const counts = segment.subarray(at + 1, at + 17);
        const total = counts.reduce((sum, count) => sum + count, 0);
        if (counts.length < 16 || at + 17 + total > segment.length || tableClass > 1 || id > 3) fail("invalid DHT segment");
        const table = buildHuffman(counts, segment.subarray(at + 17, at + 17 + total));
        (tableClass === 0 ? dcTables : acTables).set(id, table);
        at += 17 + total;
      }
    } else if (marker === 0xdd) {
      restartInterval = readUint16(segment, 0);
    } else if (marker === 0xee) {
      // APP14 "Adobe": version, flags0, flags1, then the transform byte.
      const adobe = String.fromCharCode(...segment.subarray(0, 5)) === "Adobe";
      if (adobe && segment.length >= 12) adobeTransform = segment[11];
    } else if (marker === 0xda) {
      if (!frame) fail("scan before the frame header");
      const count = segment[0] ?? 0;
      if (count < 1 || count > 4 || segment.length < 4 + count * 2) fail("invalid SOS segment");
      const components = Array.from({ length: count }, (_, index): ScanComponent => {
        const id = segment[1 + index * 2]!;
        const tables = segment[2 + index * 2]!;
        const component = frame!.components.find((candidate) => candidate.id === id);
        if (!component) fail(`scan names unknown component ${id}`);
        component.scanned = true;
        return { component, dc: dcTables.get(tables >> 4), ac: acTables.get(tables & 15), predictor: 0 };
      });
      const tail = 1 + count * 2;
      const scan: Scan = {
        components,
        start: segment[tail]!,
        end: segment[tail + 1]!,
        high: segment[tail + 2]! >> 4,
        low: segment[tail + 2]! & 15,
      };
      if (frame.progressive) {
        const dcScan = scan.start === 0;
        if ((dcScan && scan.end !== 0) || (!dcScan && (scan.end < scan.start || scan.end > 63 || count !== 1))) {
          fail("invalid progressive scan");
        }
      } else if (scan.start !== 0 || scan.end !== 63 || scan.high !== 0 || scan.low !== 0) {
        fail("invalid sequential scan");
      }
      offset = decodeScan(bytes, offset, frame, scan, restartInterval);
    }
  }

  if (!frame) fail("no frame header");
  if (frame.components.some(({ scanned }) => !scanned)) fail("a component has no scan");
  for (const component of frame.components) {
    if (!quantization.has(component.quantTable)) fail(`quantization table ${component.quantTable} is not defined`);
  }
  return { frame, quantization, adobeTransform };
}

/**
 * The single RGBA color (8 bits per channel) of every pixel of a JPEG, or
 * `undefined` when any 8x8 block has detail or two blocks differ. The color
 * is the flat sample's value before the decoder's rounding, so it may differ
 * from a decoder's output by one. Throws for bytes it cannot decode.
 */
export function jpegUniformColor(bytes: Uint8Array): Color | undefined {
  const { frame, quantization, adobeTransform } = parseJpeg(bytes);
  const samples: number[] = [];
  for (const component of frame.components) {
    const dc = flatDc(component);
    if (dc === undefined) return undefined;
    const step = quantization.get(component.quantTable)![0]!;
    // A block with only a DC coefficient decodes to DC * Q / 8 around the level shift.
    const center = frame.precision === 12 ? 2048 : 128;
    const value = (dc * step) / 8 + center;
    samples.push(clamp(frame.precision === 12 ? value / 16 : value));
  }
  return colorConverter(frame, adobeTransform)(samples);
}

/** Natural (row-major) position of each zigzag-ordered coefficient. */
const ZIGZAG = Uint8Array.from([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
  28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
]);

/** `COSINES[x * 8 + u]` is C(u) / 2 * cos((2x + 1) u pi / 16), the A.3.3 IDCT basis. */
const COSINES = Float64Array.from({ length: 64 }, (_, index) => {
  const x = index >> 3;
  const u = index & 7;
  return ((u === 0 ? Math.SQRT1_2 : 1) / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
});

/** Dequantizes and inverse-transforms every block of a component into 8-bit samples. */
function componentSamples(component: Component, steps: Int32Array, precision: number): Uint8Array {
  const width = component.blocksPerLine * 8;
  const samples = new Uint8Array(width * component.blocksPerColumn * 8);
  const block = new Float64Array(64);
  const rows = new Float64Array(64);
  const center = precision === 12 ? 2048 : 128;
  const scale = precision === 12 ? 1 / 16 : 1;
  for (let blockRow = 0; blockRow < component.blocksPerColumn; blockRow += 1) {
    for (let blockColumn = 0; blockColumn < component.blocksPerLine; blockColumn += 1) {
      const base = (blockRow * component.blocksPerLine + blockColumn) * 64;
      for (let k = 0; k < 64; k += 1) block[ZIGZAG[k]!] = component.coefficients[base + k]! * steps[k]!;
      // Rows first: rows[v * 8 + x] is the sum over u of C(x, u) F(v, u).
      for (let v = 0; v < 8; v += 1) {
        for (let x = 0; x < 8; x += 1) {
          let sum = 0;
          for (let u = 0; u < 8; u += 1) sum += COSINES[x * 8 + u]! * block[v * 8 + u]!;
          rows[v * 8 + x] = sum;
        }
      }
      for (let y = 0; y < 8; y += 1) {
        const line = (blockRow * 8 + y) * width + blockColumn * 8;
        for (let x = 0; x < 8; x += 1) {
          let sum = 0;
          for (let v = 0; v < 8; v += 1) sum += COSINES[y * 8 + v]! * rows[v * 8 + x]!;
          samples[line + x] = clamp((sum + center) * scale);
        }
      }
    }
  }
  return samples;
}

/**
 * Every pixel of a JPEG as 8-bit RGBA (alpha always 255). Throws for bytes
 * it cannot decode, and for an image larger than `maxPixels`.
 */
export function decodeJpegPixels(bytes: Uint8Array, maxPixels = MAX_DECODED_PIXELS): DecodedPixels {
  const { frame, quantization, adobeTransform } = parseJpeg(bytes);
  const { width, height, maxH, maxV } = frame;
  if (width * height > maxPixels) fail(`${width}x${height} is more than ${maxPixels} pixels`);
  const planes = frame.components.map((component) => {
    const scaleX = component.h / maxH;
    const scaleY = component.v / maxV;
    return {
      samples: componentSamples(component, quantization.get(component.quantTable)!, frame.precision),
      lineWidth: component.blocksPerLine * 8,
      // The last sample that covers the image, so edges repeat it instead of padding.
      lastX: Math.ceil(width * scaleX) - 1,
      lastY: Math.ceil(height * scaleY) - 1,
      scaleX,
      scaleY,
      full: scaleX === 1 && scaleY === 1,
    };
  });
  const convert = colorConverter(frame, adobeTransform);
  const data = new Uint8Array(width * height * 4);
  const values = new Array<number>(planes.length).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let index = 0; index < planes.length; index += 1) {
        const plane = planes[index]!;
        if (plane.full) {
          values[index] = plane.samples[y * plane.lineWidth + x]!;
          continue;
        }
        // Subsampled planes are interpolated between sample centers, as
        // libjpeg's default "fancy" upsampling does for 2:1 factors.
        const sampleX = Math.min(plane.lastX, Math.max(0, (x + 0.5) * plane.scaleX - 0.5));
        const sampleY = Math.min(plane.lastY, Math.max(0, (y + 0.5) * plane.scaleY - 0.5));
        const left = Math.floor(sampleX);
        const top = Math.floor(sampleY);
        const right = Math.min(plane.lastX, left + 1);
        const bottom = Math.min(plane.lastY, top + 1);
        const fx = sampleX - left;
        const fy = sampleY - top;
        const at = (column: number, row: number) => plane.samples[row * plane.lineWidth + column]!;
        const upper = at(left, top) * (1 - fx) + at(right, top) * fx;
        const lower = at(left, bottom) * (1 - fx) + at(right, bottom) * fx;
        values[index] = upper * (1 - fy) + lower * fy;
      }
      data.set(convert(values), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}
