import { assertImageSize, type SocialImageDescriptor } from "./core.js";
import {
  socialImageCompatibility,
  type SocialCompatibilityIssue,
  type SocialCompatibilityOptions,
  type SocialCompatibilityReport,
} from "./compatibility.js";
import { imageContentType, imageDimensions, type ImageFormat } from "./image.js";

export type SocialImageVerificationOptions = Omit<SocialCompatibilityOptions, "fileSize"> & {
  /** Optional application-specific byte ceiling, measured from encoded bytes. */
  maxFileSize?: number;
};

export type SocialImageVerificationIssue = Readonly<{
  severity: "error" | "warning" | "unknown";
  code: "format" | "dimensions" | "file-size" | "metadata" | SocialCompatibilityIssue["code"];
  message: string;
  target?: SocialCompatibilityIssue["target"];
}>;

export type SocialImageVerificationReport = Readonly<{
  compatible: boolean;
  actual: Readonly<{
    width: number;
    height: number;
    format: ImageFormat;
    contentType: string;
    byteLength: number;
  }>;
  compatibility: SocialCompatibilityReport;
  issues: readonly SocialImageVerificationIssue[];
}>;

function issue(
  severity: SocialImageVerificationIssue["severity"],
  code: SocialImageVerificationIssue["code"],
  message: string,
  target?: SocialCompatibilityIssue["target"],
): SocialImageVerificationIssue {
  return Object.freeze({ severity, code, message, ...(target ? { target } : {}) });
}

/**
 * Verifies encoded bytes and their published social descriptor as one
 * contract. Structural image failures still throw, while ordinary metadata
 * and compatibility findings are returned for CI and application reporting.
 */
export function verifySocialImage(
  bytes: ArrayBuffer | Uint8Array,
  descriptor: SocialImageDescriptor,
  options: SocialImageVerificationOptions = {},
): SocialImageVerificationReport {
  const actual = imageDimensions(bytes);
  const byteLength = bytes instanceof Uint8Array ? bytes.byteLength : bytes.byteLength;
  if (descriptor.width !== undefined || descriptor.height !== undefined) {
    if (descriptor.width === undefined || descriptor.height === undefined) {
      throw new TypeError("descriptor width and height must be provided together");
    }
    assertImageSize({ width: descriptor.width, height: descriptor.height });
  }
  if (options.maxFileSize !== undefined &&
      (!Number.isInteger(options.maxFileSize) || options.maxFileSize < 0)) {
    throw new Error(`maxFileSize must be a non-negative integer; received ${options.maxFileSize}`);
  }

  const compatibilityDescriptor = {
    ...descriptor,
    width: descriptor.width ?? actual.width,
    height: descriptor.height ?? actual.height,
  };
  const compatibility = socialImageCompatibility(compatibilityDescriptor, {
    ...(options.targets ? { targets: options.targets } : {}),
    fileSize: byteLength,
    ...(options.crawlerReady !== undefined ? { crawlerReady: options.crawlerReady } : {}),
  });
  const issues: SocialImageVerificationIssue[] = [];
  const actualContentType = imageContentType(actual.format);
  if (
    descriptor.width !== undefined &&
    descriptor.height !== undefined &&
    (actual.width !== descriptor.width || actual.height !== descriptor.height)
  ) {
    issues.push(issue(
      "error",
      "dimensions",
      `Metadata advertises ${descriptor.width}x${descriptor.height}, but image bytes are ${actual.width}x${actual.height}.`,
    ));
  }
  if (descriptor.type !== undefined && descriptor.type.toLowerCase() !== actualContentType) {
    issues.push(issue(
      "error",
      "format",
      `Metadata advertises ${descriptor.type ?? "no media type"}, but image bytes are ${actualContentType}.`,
    ));
  }
  if (options.maxFileSize !== undefined && byteLength > options.maxFileSize) {
    issues.push(issue(
      "error",
      "file-size",
      `Image bytes are ${byteLength} bytes, exceeding the ${options.maxFileSize}-byte limit.`,
    ));
  }
  for (const compatibilityIssue of compatibility.issues) {
    issues.push(issue(
      compatibilityIssue.severity,
      compatibilityIssue.code,
      compatibilityIssue.message,
      compatibilityIssue.target,
    ));
  }

  return Object.freeze({
    compatible: !issues.some(({ severity }) => severity === "error"),
    actual: Object.freeze({
      width: actual.width,
      height: actual.height,
      format: actual.format,
      contentType: actualContentType,
      byteLength,
    }),
    compatibility,
    issues: Object.freeze(issues),
  });
}
