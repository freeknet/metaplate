import path from "node:path";
import process from "node:process";
import { MAX_IMAGE_DIMENSION, type ImageSize } from "./core.js";
import type { SocialTarget } from "./compatibility-profiles.js";
import type { ImageFormat } from "./image.js";

export const VERIFY_USAGE =
  "Usage: metaplate verify [--json] [--target TARGET] [--url URL] [--alt TEXT] [--format svg|png|jpeg|webp|gif] --size WIDTHxHEIGHT <file> [...] [--size WIDTHxHEIGHT <file> [...]]";

const FORMATS = new Set<ImageFormat>(["svg", "png", "jpeg", "webp", "gif"]);
const TARGETS = new Set<SocialTarget>([
  "universal",
  "openGraph",
  "facebook",
  "x",
  "linkedin",
  "slack",
  "mastodon",
  "discord",
  "instagram",
]);

export type VerifyTarget = {
  file: string;
  size: ImageSize;
  format?: ImageFormat;
};

export type VerifyInvocation = {
  targets: VerifyTarget[];
  json: boolean;
  socialTargets: SocialTarget[];
  url?: string;
  alt?: string;
  maxFileSize?: number;
};

/** Formats a stable, concise path for CLI logs, including duplicate basenames. */
export function formatVerifyPath(file: string, cwd = process.cwd()): string {
  const relative = path.relative(cwd, path.resolve(cwd, file));
  return (relative || path.basename(file)).split(path.sep).join("/");
}

function parseSize(value: string | undefined): ImageSize {
  const match = /^(\d+)x(\d+)$/.exec(value ?? "");
  if (!match) throw new Error(`Invalid size. ${VERIFY_USAGE}`);

  const size: ImageSize = { width: Number(match[1]), height: Number(match[2]) };
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

function parseMaxFileSize(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid max file size. ${VERIFY_USAGE}`);
  }
  return parsed;
}

/** Parses one or more size-delimited groups of image paths and social checks. */
export function parseVerifyInvocation(args: string[]): VerifyInvocation {
  if (args[0] !== "verify") throw new Error(VERIFY_USAGE);

  const targets: VerifyTarget[] = [];
  const socialTargets: SocialTarget[] = [];
  let size: ImageSize | undefined;
  let format: ImageFormat | undefined;
  let json = false;
  let url: string | undefined;
  let alt: string | undefined;
  let maxFileSize: number | undefined;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
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
    if (argument === "--target") {
      const value = args[index + 1] as SocialTarget | undefined;
      if (!value || !TARGETS.has(value)) {
        throw new Error(`Invalid target. ${VERIFY_USAGE}`);
      }
      socialTargets.push(value);
      index += 1;
      continue;
    }
    if (argument === "--url") {
      url = args[index + 1];
      if (!url) throw new Error(`Invalid URL. ${VERIFY_USAGE}`);
      index += 1;
      continue;
    }
    if (argument === "--alt") {
      alt = args[index + 1];
      if (!alt) throw new Error(`Invalid alt text. ${VERIFY_USAGE}`);
      index += 1;
      continue;
    }
    if (argument === "--max-file-size") {
      maxFileSize = parseMaxFileSize(args[index + 1]);
      index += 1;
      continue;
    }
    if (!size || !argument) throw new Error(VERIFY_USAGE);
    targets.push(format ? { file: argument, size, format } : { file: argument, size });
  }

  if (targets.length === 0) throw new Error(VERIFY_USAGE);
  return {
    targets,
    json,
    socialTargets: [...new Set(socialTargets)],
    ...(url ? { url } : {}),
    ...(alt ? { alt } : {}),
    ...(maxFileSize !== undefined ? { maxFileSize } : {}),
  };
}

/** Backward-compatible target-only parser used by existing consumers/tests. */
export function parseVerifyTargets(args: string[]): VerifyTarget[] {
  return parseVerifyInvocation(args).targets;
}
