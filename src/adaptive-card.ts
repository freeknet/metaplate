import { canonicalBase, imageUrl, type SocialMetaInput } from "./meta-tags.js";

/**
 * The Adaptive Card JSON schema identifier, as declared by the schema's own
 * `id` (https://adaptivecards.io/schemas/adaptive-card.json).
 */
export const ADAPTIVE_CARD_SCHEMA = "https://adaptivecards.io/schemas/adaptive-card.json" as const;

/** Attachment `contentType` for an Adaptive Card in a Bot Framework or webhook message. */
export const ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive" as const;

/**
 * Adaptive Card schema versions the Teams platform documents as supported:
 * "v1.6 or earlier" for bot-sent cards, message extensions, link unfurling,
 * and dialogs.
 * https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-reference#support-for-adaptive-cards
 */
export const ADAPTIVE_CARD_VERSIONS = ["1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6"] as const;

export type AdaptiveCardVersion = (typeof ADAPTIVE_CARD_VERSIONS)[number];

/** The highest Adaptive Card version Teams documents as supported. */
export const ADAPTIVE_CARD_VERSION: AdaptiveCardVersion = "1.6";

/**
 * Documented Teams limits the card builder enforces.
 *
 * - `imageMaxDimension`, `imageMaxBytes`, `imageTypes`: inline card images
 *   "must be at most 1024 x 1024 pixels and in PNG, JPEG, or GIF format",
 *   with a "file size less than 1 MB"; animated GIF and SVG are unsupported.
 *   https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-reference#inline-card-images
 *   https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-format
 * - `webhookMessageBytes`: a Workflows (incoming) webhook message is limited
 *   to 28 KB, the smallest documented message limit; bot messages allow
 *   100 KB.
 *   https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook
 *   https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/format-your-bot-messages#message-size-limits
 */
export const TEAMS_ADAPTIVE_CARD_LIMITS = Object.freeze({
  imageMaxDimension: 1024,
  imageMaxBytes: 1_000_000,
  imageTypes: Object.freeze(["image/png", "image/jpeg", "image/gif"] as const),
  webhookMessageBytes: 28_000,
});

/** `Image` element carrying the social card image. */
export type AdaptiveCardImage = {
  type: "Image";
  url: string;
  altText: string;
  size: "stretch";
};

/** `TextBlock` element; text is rendered with the Adaptive Card Markdown subset. */
export type AdaptiveCardTextBlock = {
  type: "TextBlock";
  text: string;
  wrap: true;
  size?: "medium";
  weight?: "bolder";
  isSubtle?: true;
};

/** `Action.OpenUrl` button that opens the page. */
export type AdaptiveCardOpenUrlAction = {
  type: "Action.OpenUrl";
  title: string;
  url: string;
};

/**
 * The Adaptive Card returned by `socialImageAdaptiveCard`: the image, a title
 * `TextBlock`, an optional description `TextBlock`, and one `Action.OpenUrl`.
 * It is a plain JSON-serializable object.
 */
export type SocialImageAdaptiveCard = {
  $schema: typeof ADAPTIVE_CARD_SCHEMA;
  type: "AdaptiveCard";
  version: AdaptiveCardVersion;
  body:
    | [AdaptiveCardImage, AdaptiveCardTextBlock]
    | [AdaptiveCardImage, AdaptiveCardTextBlock, AdaptiveCardTextBlock];
  actions: [AdaptiveCardOpenUrlAction];
};

/** Metadata as `socialImageAdaptiveCard` reads it: only Open Graph images. */
export type SocialImageAdaptiveCardInput = Pick<SocialMetaInput, "openGraph">;

export type SocialImageAdaptiveCardOptions = {
  /** Card title, rendered as a bold `TextBlock`. Required. */
  title: string;
  /**
   * Absolute, credential-free http(s) page URL. It is the `Action.OpenUrl`
   * target, and relative image URLs resolve against it.
   */
  url: string;
  /** Optional subtle `TextBlock` under the title. */
  description?: string | undefined;
  /** Button label for the `Action.OpenUrl`. Defaults to `"Open"`. */
  actionTitle?: string | undefined;
  /** Encoded size of the chosen image in bytes, when known; Teams requires under 1 MB. */
  fileSize?: number | undefined;
  /** Card schema version. Defaults to `ADAPTIVE_CARD_VERSION` (`"1.6"`). */
  version?: AdaptiveCardVersion | undefined;
};

/** Extensions that name formats Teams does not support for card images. */
const UNSUPPORTED_EXTENSION = /\.(?:svg|svgz|webp|avif)$/i;

function requiredText(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Adaptive Card ${label} must be a non-empty string`);
  }
  return value;
}

function fitsTeams(dimension: number | undefined): boolean {
  return dimension === undefined || dimension <= TEAMS_ADAPTIVE_CARD_LIMITS.imageMaxDimension;
}

function cardImage(
  metadata: SocialImageAdaptiveCardInput,
  base: URL,
  fileSize: number | undefined,
): AdaptiveCardImage {
  const images = metadata.openGraph?.images ?? [];
  if (images.length === 0) {
    throw new Error("Adaptive Card requires at least one Open Graph image");
  }
  const limit = TEAMS_ADAPTIVE_CARD_LIMITS.imageMaxDimension;
  const image = images.find(({ width, height }) => fitsTeams(width) && fitsTeams(height));
  if (!image) {
    throw new Error(
      `Teams card images must be at most ${limit}x${limit} pixels and no Open Graph image fits; ` +
        `declare a variant such as { size: { width: 1024, height: 536 } }`,
    );
  }

  const url = new URL(imageUrl(image, base, "Adaptive Card"));
  if (url.protocol !== "https:") {
    throw new Error(`Teams card images require an HTTPS URL; received ${url.href}`);
  }
  if (url.username || url.password) {
    throw new Error(`Adaptive Card image URL must not contain credentials; received ${url.href}`);
  }

  const supported: readonly string[] = TEAMS_ADAPTIVE_CARD_LIMITS.imageTypes;
  const type = image.type?.toLowerCase();
  if (type ? !supported.includes(type) : UNSUPPORTED_EXTENSION.test(url.pathname)) {
    throw new Error(
      `Teams card images must be PNG, JPEG, or GIF; received ${type ?? url.pathname}`,
    );
  }

  if (fileSize !== undefined) {
    if (!Number.isInteger(fileSize) || fileSize < 0) {
      throw new Error(`fileSize must be a non-negative integer; received ${fileSize}`);
    }
    if (fileSize >= TEAMS_ADAPTIVE_CARD_LIMITS.imageMaxBytes) {
      throw new Error(`Teams card images must be smaller than 1 MB; received ${fileSize} bytes`);
    }
  }

  return {
    type: "Image",
    url: url.href,
    altText: requiredText(image.alt, "image alt text"),
    size: "stretch",
  };
}

/**
 * Builds a Microsoft Teams Adaptive Card for a page's social image: an
 * `Image` (with `altText` from the image's alt text), a bold title
 * `TextBlock`, an optional description `TextBlock`, and an `Action.OpenUrl`
 * to the page.
 *
 * This is for bots, Workflows webhooks, and message extensions that post
 * cards. Ordinary link previews in Teams, Slack, and Discord come from the
 * page's meta tags, which `socialMetaTags` already emits.
 *
 * The image is the first Open Graph image whose declared dimensions fit
 * Teams' 1024x1024 limit; undeclared dimensions are not rejected, because
 * Teams scales images to the card. Its URL is resolved against `options.url`
 * and must be HTTPS. A declared `type` must be PNG, JPEG, or GIF; without
 * one, an `.svg`, `.webp`, or `.avif` path is rejected. Teams also rejects
 * animated GIFs and redirected image URLs, which cannot be checked locally.
 *
 * @throws When no Open Graph image fits, the image URL is not credential-free
 *   HTTPS, the format or `fileSize` is outside Teams' limits, alt text or
 *   `title` is empty, `url` is not an absolute credential-free http(s) URL,
 *   `version` is not a version Teams supports, or the serialized card exceeds
 *   the 28 KB Workflows webhook message limit.
 */
export function socialImageAdaptiveCard(
  metadata: SocialImageAdaptiveCardInput,
  options: SocialImageAdaptiveCardOptions,
): SocialImageAdaptiveCard {
  const page = canonicalBase(options.url);
  const version = options.version ?? ADAPTIVE_CARD_VERSION;
  if (!(ADAPTIVE_CARD_VERSIONS as readonly string[]).includes(version)) {
    throw new Error(
      `Adaptive Card version must be one of ${ADAPTIVE_CARD_VERSIONS.join(", ")}; received ${version}`,
    );
  }

  const image = cardImage(metadata, page, options.fileSize);
  const title: AdaptiveCardTextBlock = {
    type: "TextBlock",
    text: requiredText(options.title, "title"),
    wrap: true,
    size: "medium",
    weight: "bolder",
  };
  const description = options.description;
  const card: SocialImageAdaptiveCard = {
    $schema: ADAPTIVE_CARD_SCHEMA,
    type: "AdaptiveCard",
    version,
    body:
      description === undefined || description === ""
        ? [image, title]
        : [image, title, { type: "TextBlock", text: description, wrap: true, isSubtle: true }],
    actions: [
      {
        type: "Action.OpenUrl",
        title: requiredText(options.actionTitle ?? "Open", "action title"),
        url: page.href,
      },
    ],
  };

  const bytes = new TextEncoder().encode(JSON.stringify(card)).byteLength;
  if (bytes > TEAMS_ADAPTIVE_CARD_LIMITS.webhookMessageBytes) {
    throw new Error(
      `Adaptive Card is ${bytes} bytes; Teams webhook messages are limited to 28 KB`,
    );
  }
  return card;
}
