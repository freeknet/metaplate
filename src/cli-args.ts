import path from "node:path";
import process from "node:process";
import { MAX_IMAGE_DIMENSION, type ImageSize } from "./core.js";
import { SOCIAL_TARGETS, type SocialTarget } from "./compatibility-profiles.js";
import type { ImageFormat } from "./image.js";
import { isRobotsProductToken } from "./robots.js";

export const VERIFY_USAGE =
  "Usage: metaplate verify [--json] [--require-content] [--target TARGET] [--url URL] [--alt TEXT] [--max-file-size BYTES] [--format svg|png|jpeg|webp|gif] --size WIDTHxHEIGHT <file> [...] [--size WIDTHxHEIGHT <file> [...]]";

const FORMATS = new Set<ImageFormat>(["svg", "png", "jpeg", "webp", "gif"]);
const TARGETS = new Set<SocialTarget>(SOCIAL_TARGETS);

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
  /** Fail a PNG whose every pixel is one color (`--require-content`). */
  requireContent?: boolean;
};

/** Formats a stable, concise path for CLI logs, including duplicate basenames. */
export function formatVerifyPath(file: string, cwd = process.cwd()): string {
  const relative = path.relative(cwd, path.resolve(cwd, file));
  return (relative || path.basename(file)).split(path.sep).join("/");
}

export const VERIFY_URL_USAGE =
  "Usage: metaplate verify-url [--json] [--require-content] [--target TARGET] [--alt TEXT] [--max-file-size BYTES] [--format svg|png|jpeg|webp|gif] [--max-bytes BYTES] [--max-redirects N] [--timeout MS] [--allow-port PORT] [--allow-private] --size WIDTHxHEIGHT <url> [...] [--size WIDTHxHEIGHT <url> [...]]";

export type VerifyUrlTarget = {
  url: string;
  size: ImageSize;
  format?: ImageFormat;
};

/** Fetch limits for `verify-url`; omitted fields use the fetcher defaults. */
export type VerifyUrlFetchOptions = {
  allowPrivate: boolean;
  allowedPorts: number[];
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
};

export type VerifyUrlInvocation = Omit<VerifyInvocation, "targets" | "url"> & {
  targets: VerifyUrlTarget[];
  fetch: VerifyUrlFetchOptions;
};

export const VERIFY_PAGE_USAGE =
  "Usage: metaplate verify-page [--json] [--target TARGET] [--crawler TOKEN] [--max-file-size BYTES] [--max-html-bytes BYTES] [--max-images N] [--max-bytes BYTES] [--max-redirects N] [--timeout MS] [--allow-port PORT] [--allow-private] <url> [...]";

/** Fetch limits for `verify-page`: the `verify-url` limits plus the page's own. */
export type VerifyPageFetchOptions = VerifyUrlFetchOptions & {
  maxHtmlBytes?: number;
  maxImages?: number;
};

export type VerifyPageInvocation = {
  urls: string[];
  json: boolean;
  socialTargets: SocialTarget[];
  /** robots.txt product tokens from `--crawler`, deduplicated; omitted when none. */
  crawlers?: string[];
  maxFileSize?: number;
  fetch: VerifyPageFetchOptions;
};

function parseSize(value: string | undefined, usage: string): ImageSize {
  const match = /^(\d+)x(\d+)$/.exec(value ?? "");
  if (!match) throw new Error(`Invalid size. ${usage}`);

  const size: ImageSize = { width: Number(match[1]), height: Number(match[2]) };
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width < 1 ||
    size.height < 1 ||
    size.width > MAX_IMAGE_DIMENSION ||
    size.height > MAX_IMAGE_DIMENSION
  ) {
    throw new Error(`Invalid size. ${usage}`);
  }

  return size;
}

/** Parses a plain decimal integer within bounds, naming the flag on failure. */
function parseInteger(
  value: string | undefined,
  label: string,
  usage: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  // Only plain decimal digits: `Number("")` is 0 and `Number("0x10")` is 16,
  // and neither is a byte ceiling anyone typed on purpose.
  const parsed = /^\d+$/.test(value ?? "") ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid ${label}. ${usage}`);
  }
  return parsed;
}

type GroupEntry = { value: string; size?: ImageSize; format?: ImageFormat };

type ParsedGroups = {
  entries: GroupEntry[];
  json: boolean;
  socialTargets: SocialTarget[];
  alt?: string;
  maxFileSize?: number;
};

type CommandFlags = {
  /** Flags that take exactly one value. */
  values?: Readonly<Record<string, (value: string | undefined) => void>>;
  /** Flags that take no value. */
  switches?: Readonly<Record<string, () => void>>;
};

/**
 * Parses the flags shared by every verify command plus command-specific ones.
 * `sized` commands take `--size` groups (and `--format`/`--alt`); the others
 * take plain positional values.
 */
function parseGroups(args: string[], command: string, usage: string, flags: CommandFlags, sized = true): ParsedGroups {
  if (args[0] !== command) throw new Error(usage);

  const entries: GroupEntry[] = [];
  const socialTargets: SocialTarget[] = [];
  let size: ImageSize | undefined;
  let format: ImageFormat | undefined;
  let json = false;
  let alt: string | undefined;
  let maxFileSize: number | undefined;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    const toggle = argument === undefined ? undefined : flags.switches?.[argument];
    if (toggle) {
      toggle();
      continue;
    }
    const value = args[index + 1];
    const handler = argument === undefined ? undefined : flags.values?.[argument];
    if (handler) {
      handler(value);
      index += 1;
      continue;
    }
    if (!sized && (argument === "--size" || argument === "--format" || argument === "--alt")) {
      throw new Error(`${argument} is not accepted here. ${usage}`);
    }
    if (argument === "--size") {
      size = parseSize(value, usage);
      index += 1;
      continue;
    }
    if (argument === "--format") {
      if (!value || !FORMATS.has(value as ImageFormat)) {
        throw new Error(`Invalid format. ${usage}`);
      }
      format = value as ImageFormat;
      index += 1;
      continue;
    }
    if (argument === "--target") {
      if (!value || !TARGETS.has(value as SocialTarget)) {
        throw new Error(`Invalid target. ${usage}`);
      }
      socialTargets.push(value as SocialTarget);
      index += 1;
      continue;
    }
    if (argument === "--alt") {
      alt = value;
      if (!alt) throw new Error(`Invalid alt text. ${usage}`);
      index += 1;
      continue;
    }
    if (argument === "--max-file-size") {
      maxFileSize = parseInteger(value, "max file size", usage);
      index += 1;
      continue;
    }
    // Unsized commands have no file operands, so an unknown flag is a typo.
    if (!argument || (sized ? !size : argument.startsWith("--"))) throw new Error(usage);
    entries.push({ value: argument, ...(size ? { size } : {}), ...(format ? { format } : {}) });
  }

  if (entries.length === 0) throw new Error(usage);
  return {
    entries,
    json,
    socialTargets: [...new Set(socialTargets)],
    ...(alt ? { alt } : {}),
    ...(maxFileSize !== undefined ? { maxFileSize } : {}),
  };
}

function entryTarget<Key extends string>(key: Key, { value, size, format }: GroupEntry) {
  // Sized commands reject an entry before its first --size.
  return { [key]: value, size: size!, ...(format ? { format } : {}) } as Record<Key, string> & {
    size: ImageSize;
    format?: ImageFormat;
  };
}

/** Parses one or more size-delimited groups of image paths and social checks. */
export function parseVerifyInvocation(args: string[]): VerifyInvocation {
  let url: string | undefined;
  const content = requireContentFlag();
  const { entries, ...parsed } = parseGroups(args, "verify", VERIFY_USAGE, {
    switches: content.switches,
    values: {
      "--url": (value) => {
        if (!value) throw new Error(`Invalid URL. ${VERIFY_USAGE}`);
        url = value;
      },
    },
  });

  // Metadata fields are only ever evaluated against a compatibility profile;
  // accepting them without one would silently verify less than was asked for.
  if ((url !== undefined || parsed.alt !== undefined) && parsed.socialTargets.length === 0) {
    throw new Error(`--url and --alt require at least one --target. ${VERIFY_USAGE}`);
  }
  return {
    targets: entries.map((entry) => entryTarget("file", entry)),
    ...parsed,
    ...(url ? { url } : {}),
    ...content.option(),
  };
}

/**
 * `--require-content`, shared by `verify` and `verify-url`. The option is
 * present only when the flag was given, so existing invocations parse as before.
 */
function requireContentFlag() {
  let enabled = false;
  return {
    switches: { "--require-content": () => { enabled = true; } },
    option: (): { requireContent?: true } => (enabled ? { requireContent: true } : {}),
  };
}

/** The remote fetch-limit flags shared by `verify-url` and `verify-page`. */
function fetchLimitFlags(limits: VerifyUrlFetchOptions, usage: string) {
  return {
    switches: { "--allow-private": () => { limits.allowPrivate = true; } },
    values: {
      "--allow-port": (value: string | undefined) => { limits.allowedPorts.push(parseInteger(value, "port", usage, 1, 65_535)); },
      "--max-bytes": (value: string | undefined) => { limits.maxBytes = parseInteger(value, "max bytes", usage, 1); },
      "--max-redirects": (value: string | undefined) => { limits.maxRedirects = parseInteger(value, "max redirects", usage, 0, 20); },
      "--timeout": (value: string | undefined) => { limits.timeoutMs = parseInteger(value, "timeout", usage, 1); },
    },
  };
}

/** Parses `verify-url`: the shared verify flags plus the remote fetch limits. */
export function parseVerifyUrlInvocation(args: string[]): VerifyUrlInvocation {
  const limits: VerifyUrlFetchOptions = { allowPrivate: false, allowedPorts: [] };
  const usage = VERIFY_URL_USAGE;
  const shared = fetchLimitFlags(limits, usage);
  const content = requireContentFlag();
  const { entries, ...parsed } = parseGroups(args, "verify-url", usage, {
    values: shared.values,
    switches: { ...shared.switches, ...content.switches },
  });

  if (parsed.alt !== undefined && parsed.socialTargets.length === 0) {
    throw new Error(`--alt requires at least one --target. ${usage}`);
  }
  return {
    targets: entries.map((entry) => entryTarget("url", entry)),
    ...parsed,
    ...content.option(),
    fetch: { ...limits, allowedPorts: [...new Set(limits.allowedPorts)] },
  };
}

/** Parses `verify-page`: page URLs, target checks, and the fetch limits. */
export function parseVerifyPageInvocation(args: string[]): VerifyPageInvocation {
  const limits: VerifyPageFetchOptions = { allowPrivate: false, allowedPorts: [] };
  const usage = VERIFY_PAGE_USAGE;
  const shared = fetchLimitFlags(limits, usage);
  const crawlers: string[] = [];
  const { entries, json, socialTargets, maxFileSize } = parseGroups(args, "verify-page", usage, {
    switches: shared.switches,
    values: {
      ...shared.values,
      "--crawler": (value) => {
        if (value === undefined || !isRobotsProductToken(value)) throw new Error(`Invalid crawler token. ${usage}`);
        if (!crawlers.some((seen) => seen.toLowerCase() === value.toLowerCase())) crawlers.push(value);
      },
      "--max-html-bytes": (value) => { limits.maxHtmlBytes = parseInteger(value, "max HTML bytes", usage, 1); },
      "--max-images": (value) => { limits.maxImages = parseInteger(value, "max images", usage, 1, 100); },
    },
  }, false);
  return {
    urls: entries.map(({ value }) => value),
    json,
    socialTargets,
    ...(crawlers.length > 0 ? { crawlers } : {}),
    ...(maxFileSize !== undefined ? { maxFileSize } : {}),
    fetch: { ...limits, allowedPorts: [...new Set(limits.allowedPorts)] },
  };
}

/** Backward-compatible target-only parser used by existing consumers/tests. */
export function parseVerifyTargets(args: string[]): VerifyTarget[] {
  return parseVerifyInvocation(args).targets;
}

export const RENDER_USAGE =
  "Usage: metaplate render [--json] [--out DIR] [--manifest FILE] [--concurrency N] <module>";

export const MANIFEST_FILENAME = "metaplate-manifest.json";

/** Renders in flight at once unless `--concurrency` says otherwise. */
export const DEFAULT_RENDER_CONCURRENCY = 4;

export type RenderInvocation = {
  module: string;
  outDir: string;
  /** Defaults to `metaplate-manifest.json` inside `outDir`. */
  manifest: string;
  concurrency: number;
  json: boolean;
};

/** Parses `render`: one module path plus output, manifest, and pool options. */
export function parseRenderInvocation(args: string[]): RenderInvocation {
  const usage = RENDER_USAGE;
  if (args[0] !== "render") throw new Error(usage);
  let outDir = "public";
  let manifest: string | undefined;
  let concurrency = DEFAULT_RENDER_CONCURRENCY;
  let json = false;
  let module: string | undefined;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    const value = args[index + 1];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--out" || argument === "--manifest") {
      if (!value || value.startsWith("--")) throw new Error(`Invalid ${argument.slice(2)} path. ${usage}`);
      if (argument === "--out") outDir = value;
      else manifest = value;
      index += 1;
    } else if (argument === "--concurrency") {
      concurrency = parseInteger(value, "concurrency", usage, 1, 256);
      index += 1;
    } else if (argument.startsWith("--") || module !== undefined) {
      throw new Error(usage);
    } else {
      module = argument;
    }
  }

  if (module === undefined) throw new Error(usage);
  return {
    module,
    outDir,
    manifest: manifest ?? path.join(outDir, MANIFEST_FILENAME),
    concurrency,
    json,
  };
}

export const PREVIEW_USAGE =
  "Usage: metaplate preview [--host HOST] [--port N] [--target TARGET] [--max-file-size BYTES] <module>";

/** Loopback only, so the gallery is reachable from this machine alone. */
export const DEFAULT_PREVIEW_HOST = "127.0.0.1";

/** Clear of the usual dev-server ports (3000, 4321, 5173, 8080), so it runs beside one. */
export const DEFAULT_PREVIEW_PORT = 4323;

export type PreviewInvocation = {
  module: string;
  host: string;
  /** `0` asks the operating system for any free port. */
  port: number;
  socialTargets: SocialTarget[];
  maxFileSize?: number;
};

/** Parses `preview`: one module path, the listen address, and target checks. */
export function parsePreviewInvocation(args: string[]): PreviewInvocation {
  const usage = PREVIEW_USAGE;
  let host = DEFAULT_PREVIEW_HOST;
  let port = DEFAULT_PREVIEW_PORT;
  const { entries, json, socialTargets, maxFileSize } = parseGroups(args, "preview", usage, {
    values: {
      "--host": (value) => {
        if (!value || value.startsWith("-")) throw new Error(`Invalid host. ${usage}`);
        host = value;
      },
      "--port": (value) => { port = parseInteger(value, "port", usage, 0, 65_535); },
    },
  }, false);
  if (json) throw new Error(`--json is not accepted here. ${usage}`);
  if (entries.length !== 1) throw new Error(usage);
  return {
    module: entries[0]!.value,
    host,
    port,
    socialTargets,
    ...(maxFileSize !== undefined ? { maxFileSize } : {}),
  };
}
