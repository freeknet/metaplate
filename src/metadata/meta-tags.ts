import { MAX_IMAGE_DIMENSION, type XCard } from "../core/social-image.js";
import { xCardTags, type XAppCard, type XPlayerCard } from "./x-cards.js";
import { openGraphMediaTags, type SocialMetaMediaInput } from "./og-media.js";
import { isAbsoluteUrl, present } from "../core/internal.js";
import { canonicalBase, pageTags, type SocialMetaOptions } from "./page-tags.js";

export { canonicalBase };
export type { SocialMetaArticle, SocialMetaDateTime, SocialMetaOptions } from "./page-tags.js";

/**
 * One `<meta>` tag as a plain object. Open Graph and `article:` tags carry
 * `property`; X Card tags and `theme-color` carry `name`. Exactly one of the
 * two is set. The shape is what React Router `meta` descriptors and
 * Astro/Svelte `{#each}` loops consume directly.
 */
export type SocialMetaTag =
  | { property: string; name?: never; content: string }
  | { name: string; property?: never; content: string };

/**
 * An image as `socialMetaTags` reads it. `SocialImageDescriptor` satisfies
 * this shape; the optional fields let hand-authored metadata describe an image
 * whose dimensions, media type, or alt text are not known.
 */
export type SocialMetaImageInput = {
  url: string;
  width?: number | undefined;
  height?: number | undefined;
  type?: string | undefined;
  alt?: string | undefined;
};

/**
 * Metadata as `socialMetaTags` reads it. Every `SocialImageMetadata` is
 * assignable to this type; either channel may be omitted from hand-authored
 * metadata, and an omitted channel emits no tags.
 */
export type SocialMetaInput = {
  openGraph?:
    | ({ images?: readonly SocialMetaImageInput[] | undefined } & SocialMetaMediaInput)
    | undefined;
  twitter?:
    | {
        card?: XCard | undefined;
        images?: readonly SocialMetaImageInput[] | undefined;
        site?: string | undefined;
        siteId?: string | undefined;
        creator?: string | undefined;
        creatorId?: string | undefined;
        /** Required with, and only with, `card: "player"`. */
        player?: XPlayerCard | undefined;
        /** Required with, and only with, `card: "app"`. */
        app?: XAppCard | undefined;
        /** Player or App Card description, emitted as `twitter:description`. */
        description?: string | undefined;
      }
    | undefined;
};

/** `socialMetaHtml` options: the page-level fields plus line indentation. */
export type SocialMetaHtmlOptions = SocialMetaOptions & {
  /** Prefix for every line. Only spaces and tabs are accepted. */
  indent?: string | undefined;
};

/**
 * Every tag key this module can emit matches this pattern: an `og`,
 * `twitter`, or `article` namespace followed by lowercase segments, or exactly
 * `theme-color`. Rendering re-checks it, so a key can never carry quotes,
 * spaces, or `>` into an attribute.
 */
const TAG_KEY = /^(?:(?:og|twitter|article)(?::[a-z]+(?:_[a-z]+)*)+|theme-color)$/;
const INDENT = /^[ \t]*$/;

export function dimension(value: number, axis: string): string {
  if (!Number.isInteger(value) || value < 1 || value > MAX_IMAGE_DIMENSION) {
    throw new Error(
      `Invalid size: ${axis} must be an integer from 1 to ${MAX_IMAGE_DIMENSION}; received ${value}`,
    );
  }
  return String(value);
}

export function imageUrl(image: SocialMetaImageInput, base: URL | undefined, label: string): string {
  if (!image.url) throw new Error(`${label} image URL must not be empty`);
  if (!base || isAbsoluteUrl(image.url)) return image.url;
  return new URL(image.url, base).href;
}

function openGraphImageTags(
  images: readonly SocialMetaImageInput[],
  base: URL | undefined,
): SocialMetaTag[] {
  const tags: SocialMetaTag[] = [];
  const seen = new Set<string>();
  for (const image of images) {
    const url = imageUrl(image, base, "Open Graph");
    // A crawler cannot tell two groups with one URL apart; the first wins.
    if (seen.has(url)) continue;
    seen.add(url);
    tags.push({ property: "og:image", content: url });
    if (image.width !== undefined) {
      tags.push({ property: "og:image:width", content: dimension(image.width, "width") });
    }
    if (image.height !== undefined) {
      tags.push({ property: "og:image:height", content: dimension(image.height, "height") });
    }
    if (present(image.type)) tags.push({ property: "og:image:type", content: image.type });
    if (present(image.alt)) tags.push({ property: "og:image:alt", content: image.alt });
  }
  return tags;
}

function twitterTags(
  twitter: NonNullable<SocialMetaInput["twitter"]>,
  base: URL | undefined,
): SocialMetaTag[] {
  const tags: SocialMetaTag[] = [];
  const named = (name: string, content: string | undefined) => {
    if (present(content)) tags.push({ name, content });
  };
  named("twitter:card", twitter.card);
  // X Cards read a single image; further entries have no wire representation.
  const image = twitter.images?.[0];
  if (image) {
    named("twitter:image", imageUrl(image, base, "Twitter"));
    named("twitter:image:alt", image.alt);
  }
  named("twitter:site", twitter.site);
  named("twitter:site:id", twitter.siteId);
  named("twitter:creator", twitter.creator);
  named("twitter:creator:id", twitter.creatorId);
  tags.push(...xCardTags(twitter));
  return tags;
}

/**
 * Describes the `<meta>` tags for social image metadata, in a fixed order:
 *
 * 1. For each Open Graph image, in order: `og:image`, `og:image:width`,
 *    `og:image:height`, `og:image:type`, `og:image:alt`. Repeating the group
 *    is how Open Graph expresses multiple images; a group whose URL repeats an
 *    earlier one is dropped.
 *    Then each Open Graph video (`og:video`, `og:video:secure_url`,
 *    `og:video:type`, `og:video:width`, `og:video:height`) and each audio
 *    item (`og:audio`, `og:audio:secure_url`, `og:audio:type`), resolved and
 *    deduplicated by URL like images; see `openGraphMediaTags`.
 * 2. `twitter:card`, `twitter:image`, `twitter:image:alt`, `twitter:site`,
 *    `twitter:site:id`, `twitter:creator`, `twitter:creator:id`, then the
 *    card-specific tags: for `player`, `twitter:description`,
 *    `twitter:player`, `twitter:player:width`, `twitter:player:height`,
 *    `twitter:player:stream`; for `app`, `twitter:description`, then
 *    `twitter:app:name:<p>`, `twitter:app:id:<p>`, `twitter:app:url:<p>` for
 *    `iphone`, `ipad`, and `googleplay` in that order, then
 *    `twitter:app:country`.
 * 3. Page-level fields from `options`: `og:title`, `og:description`,
 *    `og:url`, `og:site_name`, `og:type`, `og:locale`, each
 *    `og:locale:alternate`, `article:published_time`,
 *    `article:modified_time`, `article:expiration_time`, each
 *    `article:author`, `article:section`, each `article:tag`, `og:pubdate`,
 *    and last `<meta name="theme-color">`.
 *
 * Any tag whose value is undefined or empty is omitted. Dimensions are
 * stringified integers. When `options.url` is supplied, relative image URLs
 * are resolved against it with standard URL resolution; absolute image URLs
 * are emitted unchanged.
 *
 * @throws When `options.url` is not an absolute, credential-free http(s) URL,
 *   when a page field breaks its rule (see `SocialMetaOptions`: locales in
 *   `language_TERRITORY` form, RFC 3339 dates, `#RRGGBB`/`#RRGGBBAA` theme
 *   colors, and `type: "article"` with article fields), when an image URL is
 *   empty, when a dimension is not an integer from 1
 *   to 65535, when a video or audio item fails the `openGraphMedia` checks,
 *   or when a player or app payload is missing, mismatched with its card, or
 *   invalid (see `xCardFields`).
 */
export function socialMetaTags(
  metadata: SocialMetaInput,
  options: SocialMetaOptions = {},
): SocialMetaTag[] {
  const base = present(options.url) ? canonicalBase(options.url) : undefined;
  return [
    ...openGraphImageTags(metadata.openGraph?.images ?? [], base),
    // Open Graph video and audio groups (src/metadata/og-media.ts).
    ...openGraphMediaTags(metadata.openGraph, base),
    ...(metadata.twitter ? twitterTags(metadata.twitter, base) : []),
    ...pageTags(options),
  ];
}

/** Escapes a value for a double-quoted HTML attribute, keeping it on one line. */
export function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\r", "&#13;");
}

/**
 * Renders tags as `<meta>` elements, one per line. Exported for tests; the
 * public entry is `socialMetaHtml`.
 */
export function renderMetaTags(tags: readonly SocialMetaTag[], indent = ""): string {
  if (!INDENT.test(indent)) {
    throw new Error("indent must contain only spaces and tabs");
  }
  return tags
    .map((tag) => {
      const [attribute, key] =
        tag.property !== undefined ? ["property", tag.property] : ["name", tag.name];
      if (typeof key !== "string" || !TAG_KEY.test(key)) {
        throw new Error(`Refusing to render an unrecognized meta tag key: ${String(key)}`);
      }
      return `${indent}<meta ${attribute}="${key}" content="${escapeAttribute(tag.content)}">`;
    })
    .join("\n");
}

/**
 * Serializes `socialMetaTags(metadata, options)` as HTML: one `<meta>` element
 * per line, in the same order, with no trailing newline. The output contains
 * only `<meta>` elements. Each element has exactly two attributes, `property`
 * or `name` followed by `content`; the key is checked against a strict
 * pattern (an `og:`, `twitter:`, or `article:` key, or exactly `theme-color`),
 * and the content is escaped for a double-quoted
 * attribute (`&`, `<`, `>`, `"`, `'`, plus CR and LF so each element stays on
 * its own line). `<title>` and `<link rel="canonical">` are not emitted;
 * those belong to the page.
 *
 * @throws For the same inputs as `socialMetaTags`, or when `indent` contains
 *   anything other than spaces and tabs.
 */
export function socialMetaHtml(
  metadata: SocialMetaInput,
  options: SocialMetaHtmlOptions = {},
): string {
  const { indent, ...page } = options;
  return renderMetaTags(socialMetaTags(metadata, page), indent ?? "");
}
