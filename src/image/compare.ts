import { detectFormat } from "./inspect.js";
import { decodeJpegPixels } from "./jpeg-content.js";
import { decodePngPixels, type DecodedPixels } from "./png-content.js";
import { encodeRgbPng } from "./png-encode.js";

/**
 * Pixel comparison of two rendered cards, behind `compareImages` in
 * `metaplate/node` and `metaplate verify --baseline`. Node-only: the PNG
 * decoder and encoder use `node:zlib`.
 */

export type { DecodedPixels };

/**
 * The per-channel tolerance when either image is a JPEG: re-encoding the
 * same card moves pixels by a few levels, which is noise, not a change.
 */
export const JPEG_COMPARE_THRESHOLD = 16;

export type CompareImagesOptions = {
  /**
   * How far (0-255) a pixel's channels may move before it counts as
   * changed. Defaults to 0 when both images are PNG, so any change counts,
   * and to 16 when either is a JPEG, so re-encoding noise does not.
   */
  threshold?: number;
  /**
   * Also return `diffImage`: a PNG of the baseline, the current image, and
   * the current image faded with every changed pixel in red, side by side.
   * Only for images of the same size.
   */
  diffImage?: boolean;
};

export type ImageComparison = {
  /** Size of the baseline image. */
  baseline: { width: number; height: number };
  /** Size of the current image. */
  current: { width: number; height: number };
  /** Whether both images have the same dimensions. When not, every pixel counts as changed. */
  sameSize: boolean;
  /** The tolerance used, explicit or defaulted. */
  threshold: number;
  /** Pixels compared: the image's area, or the larger area when the sizes differ. */
  totalPixels: number;
  /** Pixels that moved more than `threshold` in any channel. */
  changedPixels: number;
  /** `changedPixels / totalPixels`, from 0 to 1. */
  changedRatio: number;
  /** Mean of each pixel's largest channel difference, from 0 to 1. */
  meanDifference: number;
  /** Largest channel difference of any pixel, from 0 to 255. */
  maxDifference: number;
  /** The side-by-side PNG, when `diffImage` was asked for and the sizes match. */
  diffImage?: Uint8Array;
};

/** Every pixel of a PNG or JPEG as 8-bit RGBA. Throws for any other format or damaged bytes. */
export function decodeImagePixels(bytes: Uint8Array): DecodedPixels {
  const format = detectFormat(bytes);
  if (format === "png") return decodePngPixels(bytes);
  if (format === "jpeg") return decodeJpegPixels(bytes);
  throw new Error(`Cannot compare ${format ?? "unrecognized"} images: only PNG and JPEG are decoded`);
}

/**
 * The largest channel difference between two RGBA pixels, with color
 * premultiplied by alpha, so two fully transparent pixels compare equal
 * whatever their color channels hold.
 */
function pixelDifference(a: Uint8Array, b: Uint8Array, at: number): number {
  const alphaA = a[at + 3]!;
  const alphaB = b[at + 3]!;
  let largest = Math.abs(alphaA - alphaB);
  for (let channel = 0; channel < 3; channel += 1) {
    const difference = Math.abs((a[at + channel]! * alphaA - b[at + channel]! * alphaB) / 255);
    if (difference > largest) largest = difference;
  }
  return Math.round(largest);
}

const GAP = 8;
const CHANGED: readonly number[] = [230, 0, 60];

/** The baseline, the current image, and the highlighted changes, side by side over white. */
function sideBySide(before: DecodedPixels, after: DecodedPixels, changed: Uint8Array): Uint8Array {
  const { width, height } = after;
  const outWidth = width * 3 + GAP * 2;
  const rgb = new Uint8Array(outWidth * height * 3).fill(255);
  const over = (source: Uint8Array, at: number, channel: number) =>
    Math.round((source[at + channel]! * source[at + 3]! + 255 * (255 - source[at + 3]!)) / 255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const at = pixel * 4;
      const row = y * outWidth;
      for (let channel = 0; channel < 3; channel += 1) {
        rgb[(row + x) * 3 + channel] = over(before.data, at, channel);
        rgb[(row + width + GAP + x) * 3 + channel] = over(after.data, at, channel);
      }
      const highlight = (row + (width + GAP) * 2 + x) * 3;
      if (changed[pixel]) {
        rgb.set(CHANGED, highlight);
      } else {
        // Faded grayscale, so the changes stand out against the layout.
        const luma = 0.299 * over(after.data, at, 0) + 0.587 * over(after.data, at, 1) + 0.114 * over(after.data, at, 2);
        rgb.fill(Math.round(170 + luma / 3), highlight, highlight + 3);
      }
    }
  }
  return encodeRgbPng(outWidth, height, rgb);
}

/**
 * Compares a baseline PNG or JPEG with the current one, pixel by pixel. A
 * pixel is changed when any channel, color premultiplied by alpha, moves
 * more than `threshold`. Images of different sizes are entirely changed.
 * Throws when either image is another format or cannot be decoded.
 */
export function compareImages(
  baseline: Uint8Array,
  current: Uint8Array,
  options: CompareImagesOptions = {},
): ImageComparison {
  const threshold =
    options.threshold ??
    (detectFormat(baseline) === "jpeg" || detectFormat(current) === "jpeg" ? JPEG_COMPARE_THRESHOLD : 0);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) {
    throw new RangeError(`threshold must be from 0 to 255, got ${threshold}`);
  }
  const before = decodeImagePixels(baseline);
  const after = decodeImagePixels(current);
  const sizes = {
    baseline: { width: before.width, height: before.height },
    current: { width: after.width, height: after.height },
  };
  if (before.width !== after.width || before.height !== after.height) {
    const totalPixels = Math.max(before.width * before.height, after.width * after.height);
    return {
      ...sizes,
      sameSize: false,
      threshold,
      totalPixels,
      changedPixels: totalPixels,
      changedRatio: 1,
      meanDifference: 1,
      maxDifference: 255,
    };
  }

  const totalPixels = after.width * after.height;
  const changed = new Uint8Array(totalPixels);
  let changedPixels = 0;
  let sum = 0;
  let maxDifference = 0;
  for (let pixel = 0; pixel < totalPixels; pixel += 1) {
    const difference = pixelDifference(before.data, after.data, pixel * 4);
    sum += difference;
    if (difference > maxDifference) maxDifference = difference;
    if (difference > threshold) {
      changed[pixel] = 1;
      changedPixels += 1;
    }
  }
  return {
    ...sizes,
    sameSize: true,
    threshold,
    totalPixels,
    changedPixels,
    changedRatio: totalPixels === 0 ? 0 : changedPixels / totalPixels,
    meanDifference: totalPixels === 0 ? 0 : sum / totalPixels / 255,
    maxDifference,
    ...(options.diffImage ? { diffImage: sideBySide(before, after, changed) } : {}),
  };
}
