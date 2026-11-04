/** `metaplate/node`: plates rendered with Satori and the native Resvg binding. */
export * from "./render/node.js";
export {
  compareImages,
  decodeImagePixels,
  JPEG_COMPARE_THRESHOLD,
  type CompareImagesOptions,
  type DecodedPixels,
  type ImageComparison,
} from "./image/compare.js";
