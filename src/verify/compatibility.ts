import { assertImageSize, type SocialImageDescriptor } from "../core/social-image.js";
import { integerOption } from "../core/internal.js";
import {
  SOCIAL_COMPATIBILITY_PROFILES,
  SOCIAL_TARGETS,
  type ProfileSeverity,
  type SocialCompatibilityProfile,
  type SocialTarget,
} from "./compatibility-profiles.js";

export type { SocialTarget } from "./compatibility-profiles.js";

export type CompatibilitySeverity = ProfileSeverity | "unknown";

export type SocialCompatibilityIssue = Readonly<{
  target: SocialTarget;
  severity: CompatibilitySeverity;
  code: "url" | "format" | "dimensions" | "file-size" | "contract";
  message: string;
}>;

export type SocialCompatibilityImage = Omit<SocialImageDescriptor, "url" | "alt"> & {
  url?: string;
  alt?: string;
};

export type SocialCompatibilityOptions = {
  /** Profiles to evaluate. Defaults to the conservative universal profile. */
  targets?: readonly SocialTarget[];
  /** Encoded response size, when known, for platform byte-limit checks. */
  fileSize?: number;
  /** Require a crawler-ready absolute HTTPS URL even for generic Open Graph. */
  crawlerReady?: boolean;
  /** Check the URL contract; defaults to true for direct compatibility checks. */
  checkUrl?: boolean;
  /** Check the alt-text contract; defaults to true for direct compatibility checks. */
  checkAlt?: boolean;
};

export type SocialCompatibilityReport = Readonly<{
  compatible: boolean;
  issues: readonly SocialCompatibilityIssue[];
}>;

const ALL_TARGETS = new Set<SocialTarget>(SOCIAL_TARGETS);

function issue(
  target: SocialTarget,
  severity: CompatibilitySeverity,
  code: SocialCompatibilityIssue["code"],
  message: string,
): SocialCompatibilityIssue {
  return Object.freeze({ target, severity, code, message });
}

function crawlerReadyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function absoluteHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function meetsMinimumSize(
  image: Readonly<{ width: number; height: number }>,
  minimum: SocialCompatibilityProfile["minimumSize"],
): boolean {
  return !minimum || (
    image.width >= (minimum.width ?? 0) && image.height >= (minimum.height ?? 0)
  );
}

/**
 * Evaluates one descriptor against documented social-preview constraints.
 * This is deliberately a local, side-effect-free check: fetchability,
 * response headers, redirects, and crawler access require deployed URL
 * verification with SSRF controls and are not inferred here.
 */
export function socialImageCompatibility(
  image: SocialCompatibilityImage,
  options: SocialCompatibilityOptions = {},
): SocialCompatibilityReport {
  if (image.width === undefined || image.height === undefined) {
    throw new TypeError("social compatibility requires image width and height");
  }
  assertImageSize({ width: image.width, height: image.height });
  integerOption("fileSize", options.fileSize, 0);

  const targets = [...new Set(options.targets ?? ["universal"] as const)];
  for (const target of targets) {
    if (!ALL_TARGETS.has(target)) throw new TypeError(`Unknown social target: ${target}`);
  }
  const issues: SocialCompatibilityIssue[] = [];
  const type = image.type?.toLowerCase();

  for (const target of targets) {
    const profile: SocialCompatibilityProfile =
      SOCIAL_COMPATIBILITY_PROFILES[target];
    if (options.checkUrl !== false) {
      if (
        (options.crawlerReady || profile.crawlerReady) &&
        (!image.url || !crawlerReadyUrl(image.url))
      ) {
        issues.push(
          issue(
            target,
            "error",
            "url",
            "Crawler-ready social images require an absolute HTTPS URL.",
          ),
        );
      } else if (profile.absoluteUrl && (!image.url || !absoluteHttpUrl(image.url))) {
        issues.push(issue(target, "error", "url", profile.absoluteUrl));
      }
    }

    if (options.checkAlt !== false && !image.alt) {
      issues.push(issue(target, "error", "contract", "Social images require alt text."));
    }

    if (profile.format) {
      if (!type) {
        issues.push(
          issue(
            target,
            profile.format.missingSeverity,
            "format",
            "No media type is declared, so raster compatibility cannot be confirmed.",
          ),
        );
      } else if (!profile.format.accepted.includes(type)) {
        issues.push(
          issue(
            target,
            "error",
            "format",
            `${type} ${profile.format.invalidMessage}`,
          ),
        );
      }
    } else if (profile.warnOnSvg && type === "image/svg+xml") {
      issues.push(
        issue(target, "warning", "format", profile.warnOnSvg),
      );
    }

    const meetsMinimum = meetsMinimumSize(image, profile.minimumSize);
    if (profile.minimumSize && !meetsMinimum) {
      issues.push(
        issue(target, "error", "dimensions", profile.minimumSize.message),
      );
    }
    if (
      profile.maximumAspectRatio &&
      image.width / image.height > profile.maximumAspectRatio.value
    ) {
      const { message } = profile.maximumAspectRatio;
      issues.push(issue(
        target,
        "error",
        "dimensions",
        `${message} Received ${image.width}x${image.height}.`,
      ));
    }
    if (
      profile.maximumFileSize &&
      options.fileSize !== undefined &&
      options.fileSize > profile.maximumFileSize.bytes
    ) {
      const { severity = "error", message } = profile.maximumFileSize;
      issues.push(issue(target, severity, "file-size", message));
    }

    if (profile.recommendedAspectRatio && meetsMinimum) {
      const ratio = image.width / image.height;
      const { value, tolerance, message } = profile.recommendedAspectRatio;
      if (Math.abs(ratio - value) > tolerance) {
        issues.push(issue(target, "warning", "dimensions", `${message} Received ${ratio.toFixed(2)}:1.`));
      }
    }

    if (profile.unknownContract) {
      issues.push(
        issue(target, "unknown", "contract", profile.unknownContract),
      );
    }
  }

  return Object.freeze({
    compatible: !issues.some(({ severity }) => severity === "error"),
    issues: Object.freeze(issues),
  });
}
