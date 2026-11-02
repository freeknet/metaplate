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
  "teams",
  "whatsapp",
  "bluesky",
  "telegram",
  "threads",
  "pinterest",
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
  /** Require an absolute http(s) image URL without requiring HTTPS. */
  absoluteUrl?: string;
  format?: FormatProfile;
  warnOnSvg?: string;
  /** Omit a dimension the platform does not constrain. */
  minimumSize?: Readonly<{ width?: number; height?: number; message: string }>;
  recommendedAspectRatio?: Readonly<{ value: number; tolerance: number; message: string }>;
  /** Largest documented width/height ratio. */
  maximumAspectRatio?: Readonly<{ value: number; message: string }>;
  /** Severity defaults to "error". */
  maximumFileSize?: Readonly<{ bytes: number; message: string; severity?: ProfileSeverity }>;
  unknownContract?: string;
}>;

const UNIVERSAL_RASTER_TYPES = ["image/png", "image/jpeg"] as const;
const DOCUMENTED_RASTER_TYPES = [...UNIVERSAL_RASTER_TYPES, "image/gif"] as const;
const UNIVERSAL_FORMAT_MESSAGE =
  "is not a documented universal raster social-preview format; use PNG or JPEG.";
const TEAMS_FORMAT_MESSAGE =
  "is not a Teams card image format; Teams documents PNG, JPEG, and GIF.";
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
    recommendedAspectRatio: {
      value: 1.91,
      tolerance: 0.02,
      message: "LinkedIn link previews are optimized for approximately a 1.91:1 aspect ratio.",
    },
    maximumFileSize: {
      bytes: 5_000_000,
      message: "LinkedIn social images must not exceed 5 MB.",
    },
  },
  slack: { crawlerReady: true, warnOnSvg: SVG_WARNING },
  mastodon: { crawlerReady: true, warnOnSvg: SVG_WARNING },
  // Discord's link-preview contract:
  // https://docs.discord.com/developers/link-previews/overview
  // It reads og:image with its width, height, type, and alt; supports PNG,
  // GIF, JPEG, WebP, and AVIF; sets no image dimension or file-size limit; and
  // accepts root-relative image URLs, so crawler-ready URLs are not required.
  discord: {
    crawlerReady: false,
    format: {
      accepted: [...DOCUMENTED_RASTER_TYPES, "image/webp", "image/avif"],
      missingSeverity: "warning",
      invalidMessage: "is not a format Discord link previews support; use PNG, GIF, JPEG, WebP, or AVIF.",
    },
  },
  instagram: {
    crawlerReady: false,
    unknownContract:
      "Instagram does not publish a stable webpage image-tag compatibility contract.",
  },
  /**
   * Teams unfurls an ordinary link into an Adaptive Card built from the
   * page's og:title, og:description, and og:image, and creates no preview
   * for a URL that requires authentication. Card images are PNG, JPEG, or
   * GIF (SVG and animated GIF are unsupported).
   * https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/share-to-teams-from-web-apps#craft-your-website-preview
   * https://learn.microsoft.com/en-us/microsoftteams/platform/messaging-extensions/how-to/micro-capabilities-for-website-links
   * https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-reference#inline-card-images
   */
  teams: {
    crawlerReady: true,
    format: {
      accepted: DOCUMENTED_RASTER_TYPES,
      missingSeverity: "warning",
      invalidMessage: TEAMS_FORMAT_MESSAGE,
    },
  },
  /**
   * WhatsApp crawls the shared page with an HTTP GET request and reads
   * og:image as "an absolute URL for an image used as the thumbnail for the
   * link preview. This image should be under 600KB in size. Image should be
   * 300px or more in width with 4:1 width/height or less aspect ratio." A
   * preview that misses these is not shown in the large size; any relaxed
   * fallback "should not be relied on". No image format or HTTPS rule is
   * published (WhatsApp's own example og:image is an SVG), so neither is
   * checked. 600KB is read as 600,000 bytes, as LinkedIn's 5 MB is read
   * as 5,000,000, and "under" makes 599,999 the largest accepted size.
   * https://developers.facebook.com/documentation/business-messaging/whatsapp/link-previews/
   */
  whatsapp: {
    crawlerReady: false,
    absoluteUrl: "WhatsApp link previews require og:image to be an absolute URL.",
    minimumSize: {
      width: 300,
      message: "WhatsApp large link previews require an image at least 300px wide.",
    },
    maximumAspectRatio: {
      value: 4,
      message: "WhatsApp large link previews require a 4:1 width/height aspect ratio or less.",
    },
    maximumFileSize: {
      bytes: 599_999,
      message: "WhatsApp large link previews require an image under 600KB.",
    },
  },
  /**
   * Bluesky stores a link card in the post record: "each client fetches and
   * embeds this card metadata, including blob upload if needed". Bluesky's
   * example uploads the og:image bytes as the card's thumb blob and turns a
   * relative og:image into a full URL itself; no image URL rule is published,
   * so crawler-ready URLs are not required. The app.bsky.embed.external
   * lexicon limits the thumb blob to image/* and 1,000,000 bytes. The limit
   * binds the uploaded blob, not the served file, so a larger image is a
   * warning: it embeds only if the posting client re-encodes it. No dimension
   * or format rule beyond image/* is published.
   * https://bsky.network/docs/about-bluesky-content/posts#website-card-embeds
   * https://github.com/bluesky-social/atproto/blob/main/packages/api/lexicons/app/bsky/embed/external.json
   */
  bluesky: {
    crawlerReady: false,
    maximumFileSize: {
      bytes: 1_000_000,
      severity: "warning",
      message:
        "Bluesky card thumbnails are blobs limited to 1,000,000 bytes; a larger image embeds only if the posting client re-encodes it.",
    },
  },
  /**
   * Telegram documents link-preview options for bots and Instant View
   * templates, but not which page tags or image properties an ordinary link
   * preview reads.
   * https://core.telegram.org/bots/api#linkpreviewoptions
   * https://instantview.telegram.org/docs
   */
  telegram: {
    crawlerReady: false,
    unknownContract:
      "Telegram does not publish the page tags or image requirements its link previews use.",
  },
  /**
   * The Threads API documents that a link is "displayed as a link preview"
   * but not which page tags or image properties the preview reads.
   * https://developers.facebook.com/documentation/threads/posts
   */
  threads: {
    crawlerReady: false,
    unknownContract:
      "Threads does not publish the page tags or image requirements its link previews use.",
  },
  /**
   * Rich Pins read og:image as "a high-resolution image" (up to six), with
   * no published format, dimension, file-size, or URL requirement.
   * https://developers.pinterest.com/docs/web-features/article-rich-pins/
   * https://developers.pinterest.com/docs/web-features/product-rich-pins/
   */
  pinterest: {
    crawlerReady: false,
    unknownContract:
      "Pinterest Rich Pins read og:image as a high-resolution image but publish no format, size, or URL requirements for it.",
  },
} as const satisfies Record<SocialTarget, SocialCompatibilityProfile>;
