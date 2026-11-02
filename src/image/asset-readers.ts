/**
 * `metaplate/assets`: Node readers that turn project files and allowlisted
 * remote URLs into `imageAsset` values for a plate's `<img src>`. No renderer
 * peers, so a Next.js, Astro, or build-script plate can import it without
 * loading Satori or Resvg. On an edge runtime, use `imageAssetLoader` from
 * `metaplate/image` with `fetch` against your own origin instead.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { memoizeLoad } from "../core/bytes.js";
import {
  IMAGE_ASSET_DEFAULTS,
  assertImageAssetOptions,
  imageAsset,
  type ImageAsset,
  type ImageAssetOptions,
} from "./asset.js";
import { projectFilePath } from "../core/project-path.js";
import {
  REMOTE_IMAGE_ACCEPT,
  RemoteImageError,
  assertRemoteFetchOptions,
  fetchRemoteResourceVia,
  type RemoteFetchOptions,
} from "../verify/remote.js";

export {
  IMAGE_ASSET_DEFAULTS,
  imageAsset,
  imageAssetLoader,
  type ImageAsset,
  type ImageAssetBytes,
  type ImageAssetOptions,
  type ImageAssetSource,
} from "./asset.js";
export type { ImageFormat } from "./inspect.js";
export {
  RemoteImageError,
  type RemoteAddress,
  type RemoteFetchOptions,
  type RemoteImageErrorCode,
  type RemoteResolver,
} from "../verify/remote.js";

export type FileImageOptions = ImageAssetOptions & {
  /** Base directory for relative paths. Defaults to `process.cwd()`. */
  cwd?: string;
};

/**
 * Prefixes a format or size error with the file or URL it came from, without
 * changing its class. System errors (`ENOENT` and the like) already name it.
 */
function withSource(error: unknown, source: string): unknown {
  if (error instanceof Error && (error as { code?: unknown }).code === undefined) {
    error.message = `${source}: ${error.message}`;
  }
  return error;
}

/**
 * Reads a project image file, such as a logo, into an `imageAsset`. Relative
 * paths resolve against `cwd`; a `file:` URL is read as is. The file's size
 * is checked against `maxBytes` before it is read.
 */
export async function readImageAsset(
  file: string | URL,
  options: FileImageOptions = {},
): Promise<ImageAsset> {
  assertImageAssetOptions(options);
  const target = projectFilePath(file, path.resolve(options.cwd ?? process.cwd()), "image");
  const maxBytes = options.maxBytes ?? IMAGE_ASSET_DEFAULTS.maxBytes;
  try {
    const { size } = await stat(target);
    if (size > maxBytes) {
      throw new RangeError(
        `Image is ${size} bytes, over the ${maxBytes}-byte maxBytes limit. ` +
          "Resize it, or raise maxBytes if the card needs it",
      );
    }
    return imageAsset(await readFile(target), options);
  } catch (error) {
    throw withSource(error, target);
  }
}

/**
 * Memoizes `readImageAsset` across renders, as `fileFontLoader` does for
 * fonts: the file is read on first use, and a failed read is retried on the
 * next render rather than memoized.
 */
export function fileImageLoader(
  file: string | URL,
  options: FileImageOptions = {},
): () => Promise<ImageAsset> {
  assertImageAssetOptions(options);
  return memoizeLoad(() => readImageAsset(file, options));
}

/** Defaults for `remoteImageLoader`. */
export const REMOTE_IMAGE_LOADER_DEFAULTS = Object.freeze({
  /** Images kept in memory; the oldest is evicted first. */
  cacheSize: 64,
  /** Largest image fetched, enforced while streaming. */
  maxBytes: IMAGE_ASSET_DEFAULTS.maxBytes,
});

export type RemoteImageLoaderOptions = RemoteFetchOptions &
  ImageAssetOptions & {
    /**
     * The only origins images are fetched from, such as
     * `["https://cdn.example.com"]`. Required: every request and every
     * redirect hop must stay on one of them. Entries are bare origins; a
     * path, query, or credentials is rejected rather than silently ignored.
     */
    origins: readonly (string | URL)[];
    /**
     * Images memoized per loader, by URL, oldest evicted first. Defaults to
     * 64; `0` disables the cache. Failed loads are never cached.
     */
    cacheSize?: number;
  };

/** Loads one image URL as an `imageAsset`, memoized per loader. */
export type RemoteImageLoader = (url: string | URL) => Promise<ImageAsset>;

function allowedOrigins(origins: readonly (string | URL)[] | undefined): ReadonlySet<string> {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new TypeError(
      'remoteImageLoader needs an origins allowlist, such as origins: ["https://cdn.example.com"]',
    );
  }
  const allowed = new Set<string>();
  for (const entry of origins as readonly (string | URL)[]) {
    let url: URL;
    try {
      url = new URL(String(entry));
    } catch {
      throw new TypeError(`origins entry ${JSON.stringify(String(entry))} is not a URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError(`origins entry ${url.href} must use http: or https:`);
    }
    if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      throw new TypeError(
        `origins entries must be bare origins such as https://cdn.example.com; received ${JSON.stringify(String(entry))}`,
      );
    }
    allowed.add(url.origin);
  }
  return allowed;
}

function cacheSizeFrom(cacheSize: number | undefined): number {
  if (cacheSize === undefined) return REMOTE_IMAGE_LOADER_DEFAULTS.cacheSize;
  if (!Number.isSafeInteger(cacheSize) || cacheSize < 0) {
    throw new TypeError(`cacheSize must be a non-negative integer; received ${cacheSize}`);
  }
  return cacheSize;
}

/**
 * Loads remote images, such as per-page avatars or covers, for an `async`
 * plate component. Satori would otherwise fetch an `<img src>` URL itself,
 * under no origin allowlist, byte cap, or timeout of the application's
 * choosing. This loader fetches only from `origins`, through the same
 * hardened fetcher as `verify-url` (public addresses only unless
 * `allowPrivate`, every redirect re-checked against the policy and the
 * allowlist, a streaming byte cap, total and per-connection timeouts, no
 * cookies or credentials sent), checks the bytes with `imageAsset`, and
 * memoizes each URL in a bounded cache. Failures reject with
 * `RemoteImageError` (code `"origin"` for a URL or redirect off the
 * allowlist) or the `imageAsset` error, prefixed with the URL.
 */
export function remoteImageLoader(options: RemoteImageLoaderOptions): RemoteImageLoader {
  const { origins, cacheSize, formats, ...fetchOptions } = options;
  const allowed = allowedOrigins(origins);
  const capacity = cacheSizeFrom(cacheSize);
  const maxBytes = fetchOptions.maxBytes ?? REMOTE_IMAGE_LOADER_DEFAULTS.maxBytes;
  const assetOptions: ImageAssetOptions = { maxBytes, ...(formats === undefined ? {} : { formats }) };
  const remoteOptions: RemoteFetchOptions = { ...fetchOptions, maxBytes };
  assertImageAssetOptions(assetOptions);
  assertRemoteFetchOptions(remoteOptions);

  const checkOrigin = (url: URL, label: string) => {
    if (!allowed.has(url.origin)) {
      throw new RemoteImageError(
        "origin",
        `${label} ${url.href} is not on an allowed origin (${[...allowed].join(", ")})`,
        url.href,
      );
    }
  };

  async function load(input: string | URL): Promise<ImageAsset> {
    const remote = await fetchRemoteResourceVia(
      input,
      remoteOptions,
      (address) => address,
      REMOTE_IMAGE_ACCEPT,
      { checkHop: checkOrigin },
    );
    try {
      return imageAsset(remote.bytes, assetOptions);
    } catch (error) {
      throw withSource(error, remote.finalUrl);
    }
  }

  const cache = new Map<string, Promise<ImageAsset>>();
  return (input) => {
    let key: string;
    try {
      key = new URL(String(input)).href;
    } catch {
      // The fetcher reports the unparseable URL with its stable error code.
      return load(input);
    }
    if (capacity === 0) return load(key);
    const cached = cache.get(key);
    if (cached) return cached;
    const loaded = load(key);
    loaded.catch(() => {
      if (cache.get(key) === loaded) cache.delete(key);
    });
    if (cache.size >= capacity) cache.delete(cache.keys().next().value!);
    cache.set(key, loaded);
    return loaded;
  };
}

