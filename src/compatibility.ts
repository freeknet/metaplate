import { assertImageSize, type SocialImageDescriptor } from "./core.js";

export type SocialTarget =
  | "universal"
  | "openGraph"
  | "facebook"
  | "x"
  | "linkedin"
  | "slack"
  | "mastodon"
  | "discord"
  | "instagram";

export type CompatibilitySeverity = "error" | "warning" | "unknown";

export type SocialCompatibilityIssue = Readonly<{
  target: SocialTarget;
  severity: CompatibilitySeverity;
  code: "url" | "format" | "dimensions" | "file-size" | "contract";
  message: string;
}>;

export type SocialCompatibilityOptions = {
  /** Profiles to evaluate. Defaults to the conservative universal profile. */
  targets?: readonly SocialTarget[];
  /** Encoded response size, when known, for platform byte-limit checks. */
  fileSize?: number;
  /** Require a crawler-ready absolute HTTPS URL even for generic Open Graph. */
  crawlerReady?: boolean;
};

export type SocialCompatibilityReport = Readonly<{
  compatible: boolean;
  issues: readonly SocialCompatibilityIssue[];
}>;

const UNIVERSAL_TYPES = new Set(["image/png", "image/jpeg"]);
const DOCUMENTED_RASTER_TYPES = new Set([...UNIVERSAL_TYPES, "image/gif"]);
const ALL_TARGETS = new Set<SocialTarget>([
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
const CRAWLER_TARGETS = new Set<SocialTarget>([
  "universal",
  "facebook",
  "x",
  "linkedin",
  "slack",
  "mastodon",
]);

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

/**
 * Evaluates one descriptor against documented social-preview constraints.
 * This is deliberately a local, side-effect-free check: fetchability,
 * response headers, redirects, and crawler access require deployed URL
 * verification with SSRF controls and are not inferred here.
 */
export function socialImageCompatibility(
  image: SocialImageDescriptor,
  options: SocialCompatibilityOptions = {},
): SocialCompatibilityReport {
  assertImageSize(image);
  if (
    options.fileSize !== undefined &&
    (!Number.isInteger(options.fileSize) || options.fileSize < 0)
  ) {
    throw new Error(`fileSize must be a non-negative integer; received ${options.fileSize}`);
  }

  const targets = [...new Set(options.targets ?? ["universal"] as const)];
  for (const target of targets) {
    if (!ALL_TARGETS.has(target)) throw new Error(`Unknown social target: ${target}`);
  }
  const issues: SocialCompatibilityIssue[] = [];
  const type = image.type?.toLowerCase();

  for (const target of targets) {
    if (
      (options.crawlerReady || CRAWLER_TARGETS.has(target)) &&
      !crawlerReadyUrl(image.url)
    ) {
      issues.push(
        issue(
          target,
          "error",
          "url",
          "Crawler-ready social images require an absolute HTTPS URL.",
        ),
      );
    }

    if (!image.alt) {
      issues.push(issue(target, "error", "contract", "Social images require alt text."));
    }

    if (target === "universal" || target === "facebook" || target === "linkedin") {
      if (!type) {
        issues.push(
          issue(
            target,
            target === "universal" ? "error" : "warning",
            "format",
            "No media type is declared, so raster compatibility cannot be confirmed.",
          ),
        );
      } else if (
        !(target === "universal" ? UNIVERSAL_TYPES : DOCUMENTED_RASTER_TYPES).has(type)
      ) {
        issues.push(
          issue(
            target,
            "error",
            "format",
            `${type} is not a documented universal raster social-preview format; use PNG or JPEG.`,
          ),
        );
      }
    } else if (
      (target === "openGraph" || target === "slack" || target === "mastodon") &&
      type === "image/svg+xml"
    ) {
      issues.push(
        issue(
          target,
          "warning",
          "format",
          "SVG is structurally valid metadata but is not a safe cross-client social delivery format.",
        ),
      );
    }

    if (target === "linkedin") {
      if (image.width < 1200 || image.height < 627) {
        issues.push(
          issue(
            target,
            "error",
            "dimensions",
            "LinkedIn full-size previews require at least 1200x627 pixels.",
          ),
        );
      }
      if (options.fileSize !== undefined && options.fileSize > 5_000_000) {
        issues.push(
          issue(target, "error", "file-size", "LinkedIn social images must not exceed 5 MB."),
        );
      }
    }

    if (target === "discord" || target === "instagram") {
      issues.push(
        issue(
          target,
          "unknown",
          "contract",
          `${target === "discord" ? "Discord" : "Instagram"} does not publish a stable webpage image-tag compatibility contract.`,
        ),
      );
    }
  }

  return Object.freeze({
    compatible: !issues.some(({ severity }) => severity === "error"),
    issues: Object.freeze(issues),
  });
}
