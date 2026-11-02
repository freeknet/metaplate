import { base64, bytesOf, memoizeLoad } from "../core/bytes.js";
import {
  ascii,
  detectFormat,
  imageContentType,
  imageDimensions,
  matches,
  svgIntrinsicSize,
  type ImageFormat,
} from "./inspect.js";

/**
 * Not an entry point: `imageAsset` and its loader, re-exported by
 * `metaplate/image` (and by `metaplate/assets` beside its Node readers).
 */


/** Bytes of an image file, in any binary container. */
export type ImageAssetBytes = ArrayBuffer | ArrayBufferView;

/** An image embedded as a `data:` URI, with the intrinsic size Satori uses. */
export type ImageAsset = Readonly<{
  /** `data:<type>;base64,…`, ready for `<img src>` or a CSS `url()`. */
  src: string;
  /** Intrinsic width in pixels (for SVG, the size Satori derives from it). */
  width: number;
  /** Intrinsic height in pixels. */
  height: number;
  format: ImageFormat;
  contentType: string;
  /** Size of the source bytes, before base64 encoding. */
  byteLength: number;
}>;

export type ImageAssetOptions = {
  /**
   * Formats to accept. Defaults to `IMAGE_ASSET_DEFAULTS.formats`, the
   * formats every Metaplate renderer draws: PNG, JPEG, and SVG. Add `"gif"`
   * for `metaplate/node` and `metaplate/edge`, which draw a GIF's first
   * frame, and `"webp"` only for SVG output a browser displays.
   */
  formats?: readonly ImageFormat[];
  /** Largest source accepted, in bytes. Defaults to 4 MiB. */
  maxBytes?: number;
};

/**
 * Defaults for `imageAsset`. Satori embeds PNG, JPEG, GIF, WebP, and SVG, but
 * every renderer Metaplate drives rasterises Satori's SVG with Resvg:
 * `@resvg/resvg-js` and `@resvg/resvg-wasm` 2.6 draw GIF but not WebP, and the
 * Resvg that Next.js 16 bundles in `next/og` draws neither. An image the
 * renderer cannot decode becomes an empty box in a card that still has the
 * right size and format, so only the formats every renderer draws are on by
 * default.
 */
export const IMAGE_ASSET_DEFAULTS = Object.freeze({
  formats: Object.freeze(["png", "jpeg", "svg"]) as readonly ImageFormat[],
  maxBytes: 4 * 1024 * 1024,
});

const IMAGE_FORMATS: readonly ImageFormat[] = ["svg", "png", "jpeg", "webp", "gif"];

const FORMAT_NAMES: Readonly<Record<ImageFormat, string>> = {
  svg: "SVG",
  png: "PNG",
  jpeg: "JPEG",
  webp: "WebP",
  gif: "GIF",
};

/** Why a format Satori accepts is left out of the default set. */
const DISABLED_REASONS: Readonly<Partial<Record<ImageFormat, string>>> = {
  webp:
    "Resvg 2.6 (metaplate/node, metaplate/edge) and next/og draw WebP as nothing. Convert it to " +
    'PNG or JPEG, or add "webp" to formats only for SVG output that a browser displays',
  gif:
    'next/og draws GIF as nothing. Convert it to PNG, or add "gif" to formats when the plate ' +
    "renders with metaplate/node or metaplate/edge, which draw its first frame",
};

function assetFormats(formats: readonly ImageFormat[] | undefined): readonly ImageFormat[] {
  if (formats === undefined) return IMAGE_ASSET_DEFAULTS.formats;
  for (const format of formats) {
    if (!IMAGE_FORMATS.includes(format)) {
      throw new TypeError(
        `formats entries must be one of ${IMAGE_FORMATS.join(", ")}; received ${JSON.stringify(format)}`,
      );
    }
  }
  return formats;
}

function assetMaxBytes(maxBytes: number | undefined): number {
  if (maxBytes === undefined) return IMAGE_ASSET_DEFAULTS.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError(`maxBytes must be a positive integer; received ${maxBytes}`);
  }
  return maxBytes;
}

/** Validates `imageAsset` options once, where a loader is defined. */
export function assertImageAssetOptions(options: ImageAssetOptions): void {
  assetFormats(options.formats);
  assetMaxBytes(options.maxBytes);
}

const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "mif1", "msf1"]);

/** Names image formats Satori cannot embed, so the error says what arrived. */
function unsupportedFormatName(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return "AVIF";
    if (HEIF_BRANDS.has(brand)) return "HEIC/HEIF";
  }
  if (
    matches(bytes, [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20]) ||
    matches(bytes, [0xff, 0x0a])
  ) {
    return "JPEG XL";
  }
  if (matches(bytes, [0x49, 0x49, 0x2a, 0x00]) || matches(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return "TIFF";
  }
  if (matches(bytes, [0x00, 0x00, 0x01, 0x00])) return "ICO";
  if (bytes.byteLength >= 14 && ascii(bytes, 0, 2) === "BM") return "BMP";
  return undefined;
}

function describeBytes(bytes: Uint8Array): string {
  const head = [...bytes.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
  return `${bytes.byteLength} bytes starting ${head || "(empty)"}`;
}

const SATORI_FORMATS = "Satori's <img> accepts PNG, JPEG, GIF, WebP, and SVG";

function disabledFormatMessage(format: ImageFormat, formats: readonly ImageFormat[]): string {
  const reason = DISABLED_REASONS[format];
  const detail =
    reason !== undefined && formats === IMAGE_ASSET_DEFAULTS.formats
      ? reason
      : `formats allows only ${formats.map((name) => FORMAT_NAMES[name]).join(", ") || "nothing"}`;
  return `${FORMAT_NAMES[format]} images are not enabled: ${detail}`;
}

/**
 * Embeds image bytes as a `data:` URI for a plate's `<img src>`, with the
 * intrinsic size Satori lays it out at. Nothing is fetched, here or at render
 * time: the caller supplies the bytes (`readImageAsset` and
 * `remoteImageLoader` in `metaplate/assets` read and fetch them on Node).
 *
 * The format comes from the bytes, never from a file name or `Content-Type`,
 * and raster files are walked by the same structural detector as
 * `imageDimensions`. A truncated download, an HTML error page, or a format
 * the renderer would draw as nothing throws here with the reason, rather
 * than leaving an empty box in a card that otherwise looks valid.
 */
export function imageAsset(input: ImageAssetBytes, options: ImageAssetOptions = {}): ImageAsset {
  const formats = assetFormats(options.formats);
  const maxBytes = assetMaxBytes(options.maxBytes);
  const bytes = bytesOf(input);
  if (bytes.byteLength > maxBytes) {
    throw new RangeError(
      `Image is ${bytes.byteLength} bytes, over the ${maxBytes}-byte maxBytes limit. ` +
        "Resize it, or raise maxBytes if the card needs it",
    );
  }

  const format = detectFormat(bytes);
  if (format === undefined) {
    const unsupported = unsupportedFormatName(bytes);
    throw new TypeError(
      unsupported === undefined
        ? `Unrecognized image (${describeBytes(bytes)}): ${SATORI_FORMATS}`
        : `${unsupported} images cannot be embedded: ${SATORI_FORMATS}. Convert it to PNG or JPEG`,
    );
  }
  if (!formats.includes(format)) throw new TypeError(disabledFormatMessage(format, formats));

  const { width, height } = format === "svg" ? svgIntrinsicSize(bytes) : imageDimensions(bytes);
  const contentType = imageContentType(format);
  return Object.freeze({
    src: `data:${contentType};base64,${base64(bytes)}`,
    width,
    height,
    format,
    contentType,
    byteLength: bytes.byteLength,
  });
}

/** Image bytes, a `Response` carrying them, or a function producing either. */
export type ImageAssetSource =
  | ImageAssetBytes
  | Response
  | (() => ImageAssetBytes | Response | Promise<ImageAssetBytes | Response>);

async function sourceBytes(source: ImageAssetSource): Promise<ImageAssetBytes> {
  const value = await (typeof source === "function" ? source() : source);
  if (typeof Response !== "undefined" && value instanceof Response) {
    if (!value.ok) {
      throw new Error(`Image request ${value.url || "(no URL)"} returned ${value.status}`);
    }
    return value.arrayBuffer();
  }
  return value as ImageAssetBytes;
}

/**
 * Memoizes one image asset across renders, in any runtime. The source is
 * bytes, a `Response`, or a function producing either, such as
 * `() => fetch(new URL("/images/logo.png", origin))` on an edge runtime; a
 * function runs on first use. A failure, including a non-2xx `Response`, is
 * not memoized, so the next render tries again.
 */
export function imageAssetLoader(
  source: ImageAssetSource,
  options: ImageAssetOptions = {},
): () => Promise<ImageAsset> {
  assertImageAssetOptions(options);
  return memoizeLoad(async () => imageAsset(await sourceBytes(source), options));
}
