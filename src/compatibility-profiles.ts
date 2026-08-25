export const SOCIAL_TARGETS = [
  "universal",
  "openGraph",
  "facebook",
  "x",
  "linkedin",
  "slack",
  "mastodon",
  "discord",
  "instagram",
] as const;

export type SocialTarget = (typeof SOCIAL_TARGETS)[number];
export type ProfileSeverity = "error" | "warning";

type FormatProfile = Readonly<{
  accepted: readonly string[];
  missingSeverity: ProfileSeverity;
  invalidMessage: string;
}>;

export type SocialCompatibilityProfile = Readonly<{
  crawlerReady: boolean;
  format?: FormatProfile;
  warnOnSvg?: string;
  minimumSize?: Readonly<{ width: number; height: number; message: string }>;
  maximumFileSize?: Readonly<{ bytes: number; message: string }>;
  unknownContract?: string;
}>;

const UNIVERSAL_RASTER_TYPES = ["image/png", "image/jpeg"] as const;
const DOCUMENTED_RASTER_TYPES = [...UNIVERSAL_RASTER_TYPES, "image/gif"] as const;
const UNIVERSAL_FORMAT_MESSAGE =
  "is not a documented universal raster social-preview format; use PNG or JPEG.";
const SVG_WARNING =
  "SVG is structurally valid metadata but is not a safe cross-client social delivery format.";

/**
 * Trackable compatibility policy. Keep platform facts here so the evaluator
 * remains generic and a platform change has one reviewable source of truth.
 */
export const SOCIAL_COMPATIBILITY_PROFILES = {
  universal: {
    crawlerReady: true,
    format: {
      accepted: UNIVERSAL_RASTER_TYPES,
      missingSeverity: "error",
      invalidMessage: UNIVERSAL_FORMAT_MESSAGE,
    },
  },
  openGraph: { crawlerReady: false, warnOnSvg: SVG_WARNING },
  facebook: {
    crawlerReady: true,
    format: {
      accepted: DOCUMENTED_RASTER_TYPES,
      missingSeverity: "warning",
      invalidMessage: UNIVERSAL_FORMAT_MESSAGE,
    },
  },
  x: { crawlerReady: true },
  linkedin: {
    crawlerReady: true,
    format: {
      accepted: DOCUMENTED_RASTER_TYPES,
      missingSeverity: "warning",
      invalidMessage: UNIVERSAL_FORMAT_MESSAGE,
    },
    minimumSize: {
      width: 1200,
      height: 627,
      message: "LinkedIn full-size previews require at least 1200x627 pixels.",
    },
    maximumFileSize: {
      bytes: 5_000_000,
      message: "LinkedIn social images must not exceed 5 MB.",
    },
  },
  slack: { crawlerReady: true, warnOnSvg: SVG_WARNING },
  mastodon: { crawlerReady: true, warnOnSvg: SVG_WARNING },
  discord: {
    crawlerReady: false,
    unknownContract:
      "Discord does not publish a stable webpage image-tag compatibility contract.",
  },
  instagram: {
    crawlerReady: false,
    unknownContract:
      "Instagram does not publish a stable webpage image-tag compatibility contract.",
  },
} as const satisfies Record<SocialTarget, SocialCompatibilityProfile>;
