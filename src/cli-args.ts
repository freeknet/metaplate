import path from "node:path";
import { MAX_IMAGE_DIMENSION, type ImageSize } from "./core.js";
import type { ImageFormat } from "./image.js";

export const VERIFY_USAGE =
  "Usage: metaplate verify [--format png|jpeg|webp] --size WIDTHxHEIGHT <file> [...] [--size WIDTHxHEIGHT <file> [...]]";

const FORMATS = new Set<ImageFormat>(["png", "jpeg", "webp"]);

export type VerifyTarget = {
  file: string;
  size: ImageSize;
  format?: ImageFormat;
};

/** Formats a stable, concise path for CLI logs, including duplicate basenames. */
export function formatVerifyPath(file: string, cwd = process.cwd()): string {
  const relative = path.relative(cwd, path.resolve(cwd, file));
  return (relative || path.basename(file)).split(path.sep).join("/");
}

function parseSize(value: string | undefined) {
  const match = /^(\d+)x(\d+)$/.exec(value ?? "");
  if (!match) throw new Error(`Invalid size. ${VERIFY_USAGE}`);

  const size: ImageSize = { width: Number(match[1]), height: Number(match[2]) };
  // A PNG cannot declare a zero dimension, and no format can declare a
  // fractional, negative, infinite, or over-long one, so accepting any of
  // those only defers the rejection to a mismatch that blames the file.
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width < 1 ||
    size.height < 1 ||
    size.width > MAX_IMAGE_DIMENSION ||
    size.height > MAX_IMAGE_DIMENSION
  ) {
    throw new Error(`Invalid size. ${VERIFY_USAGE}`);
  }

  return size;
}

/** Parses one or more size-delimited groups of image paths. */
export function parseVerifyTargets(args: string[]): VerifyTarget[] {
  if (args[0] !== "verify") throw new Error(VERIFY_USAGE);

  const targets: VerifyTarget[] = [];
  let size: ImageSize | undefined;
  let format: ImageFormat | undefined;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--size") {
      size = parseSize(args[index + 1]);
      index += 1;
      continue;
    }
    if (argument === "--format") {
      const value = args[index + 1];
      if (!value || !FORMATS.has(value as ImageFormat)) {
        throw new Error(`Invalid format. ${VERIFY_USAGE}`);
      }
      format = value as ImageFormat;
      index += 1;
      continue;
    }
    if (!size || !argument) throw new Error(VERIFY_USAGE);
    targets.push(format ? { file: argument, size, format } : { file: argument, size });
  }

  if (targets.length === 0) throw new Error(VERIFY_USAGE);
  return targets;
}