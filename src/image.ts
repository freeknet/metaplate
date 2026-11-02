/**
 * `metaplate/image`: runtime-neutral image inspection. Dimension and
 * structural verification for SVG, PNG, JPEG, WebP, and GIF, and `imageAsset`
 * for embedding image bytes in a plate. No peers and no Node built-ins.
 */

export {
  detectFormat,
  imageContentType,
  imageDimensions,
  verifyImage,
  type ImageDimensions,
  type ImageFormat,
  type OutputFormat,
} from "./image/inspect.js";

export {
  IMAGE_ASSET_DEFAULTS,
  imageAsset,
  imageAssetLoader,
  type ImageAsset,
  type ImageAssetBytes,
  type ImageAssetOptions,
  type ImageAssetSource,
} from "./image/asset.js";
