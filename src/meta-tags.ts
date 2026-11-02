import { MAX_IMAGE_DIMENSION, type XCard } from "./core.js";
import { xCardTags, type XAppCard, type XPlayerCard } from "./x-cards.js";

/**
 * One `<meta>` tag as a plain object. Open Graph tags carry `property`, X Card
 * tags carry `name`; exactly one of the two is set. The shape is what React
 * Router `meta` descriptors and Astro/Svelte `{#each}` loops consume directly.
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
  openGraph?: { images?: readonly SocialMetaImageInput[] | undefined } | undefined;
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

/**
 * Optional page-level Open Graph fields. An undefined or empty value emits no
 * tag. `<title>` and `<link rel="canonical">` are not meta tags and remain the
 * page's responsibility.
 */
export type SocialMetaOptions = {
  /** Emitted as `og:title`. */
  title?: string | undefined;
  /** Emitted as `og:description`. */
  description?: string | undefined;
  /**
   * Absolute http(s) canonical page URL, emitted as `og:url`. When supplied,
   * relative image URLs are resolved against it; absolute image URLs are
   * never changed. Without it, image URLs are emitted exactly as given.
   */
  url?: string | undefined;
  /** Emitted as `og:site_name`. */
  siteName?: string | undefined;
  /**
   * Emitted as `og:type`. Defaults to `website` only when `title` or `url` is
   * supplied, so metadata-only calls never gain page-level tags.
   */
  type?: string | undefined;
};

/** `socialMetaHtml` options: the page-level fields plus line indentation. */
export type SocialMetaHtmlOptions = SocialMetaOptions & {
  /** Prefix for every line. Only spaces and tabs are accepted. */
  indent?: string | undefined;
};

/**
 * Every tag key this module can emit matches this pattern: an `og` or
 * `twitter` namespace followed by lowercase segments. Rendering re-checks it,
 * so a key can never carry quotes, spaces, or `>` into an attribute.
 */
const TAG_KEY = /^(?:og|twitter)(?::[a-z]+(?:_[a-z]+)*)+$/;
const INDENT = /^[ \t]*$/;

function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function dimension(value: number, axis: string): string {
  if (!Number.isInteger(value) || value < 1 || value > MAX_IMAGE_DIMENSION) {
    throw new Error(
      `Invalid size: ${axis} must be an integer from 1 to ${MAX_IMAGE_DIMENSION}; received ${value}`,
    );
  }
  return String(value);
}

function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Parses the canonical URL, accepting only credential-free http(s) URLs. */
function canonicalBase(url: string): URL {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error(`Invalid url: expected an absolute http(s) URL; received ${url}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Invalid url: must not contain credentials; received ${url}`);
  }
  return parsed;
}

function imageUrl(image: SocialMetaImageInput, base: URL | undefined, label: string): string {
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

function pageTags(options: SocialMetaOptions): SocialMetaTag[] {
  const tags: SocialMetaTag[] = [];
  const add = (property: string, content: string | undefined) => {
    if (present(content)) tags.push({ property, content });
  };
  add("og:title", options.title);
  add("og:description", options.description);
  add("og:url", options.url);
  add("og:site_name", options.siteName);
  const defaultType = present(options.title) || present(options.url) ? "website" : undefined;
  add("og:type", present(options.type) ? options.type : defaultType);
  return tags;
}

/**
 * Describes the `<meta>` tags for social image metadata, in a fixed order:
 *
 * 1. For each Open Graph image, in order: `og:image`, `og:image:width`,
 *    `og:image:height`, `og:image:type`, `og:image:alt`. Repeating the group
 *    is how Open Graph expresses multiple images; a group whose URL repeats an
 *    earlier one is dropped.
 * 2. `twitter:card`, `twitter:image`, `twitter:image:alt`, `twitter:site`,
 *    `twitter:site:id`, `twitter:creator`, `twitter:creator:id`, then the
 *    card-specific tags: for `player`, `twitter:description`,
 *    `twitter:player`, `twitter:player:width`, `twitter:player:height`,
 *    `twitter:player:stream`; for `app`, `twitter:description`, then
 *    `twitter:app:name:<p>`, `twitter:app:id:<p>`, `twitter:app:url:<p>` for
 *    `iphone`, `ipad`, and `googleplay` in that order, then
 *    `twitter:app:country`.
 * 3. Page-level fields from `options`: `og:title`, `og:description`,
 *    `og:url`, `og:site_name`, `og:type`.
 *
 * Any tag whose value is undefined or empty is omitted. Dimensions are
 * stringified integers. When `options.url` is supplied, relative image URLs
 * are resolved against it with standard URL resolution; absolute image URLs
 * are emitted unchanged.
 *
 * @throws When `options.url` is not an absolute, credential-free http(s) URL,
 *   when an image URL is empty, when a dimension is not an integer from 1
 *   to 65535, or when a player or app payload is missing, mismatched with its
 *   card, or invalid (see `xCardFields`).
 */
export function socialMetaTags(
  metadata: SocialMetaInput,
  options: SocialMetaOptions = {},
): SocialMetaTag[] {
  const base = present(options.url) ? canonicalBase(options.url) : undefined;
  return [
    ...openGraphImageTags(metadata.openGraph?.images ?? [], base),
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
 * `og:`/`twitter:` pattern, and the content is escaped for a double-quoted
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
