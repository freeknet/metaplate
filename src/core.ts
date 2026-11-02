import { xCardFields, type XAppCard, type XPlayerCard } from "./x-cards.js";
import {
  openGraphMedia,
  type OpenGraphAudio,
  type OpenGraphMediaOptions,
  type OpenGraphVideo,
} from "./og-media.js";

/** The standard 1.91:1 social-card canvas. */
export const OG_SIZE = Object.freeze({ width: 1200, height: 630 });

export const OG_CONTENT_TYPE = "image/png" as const;

/**
 * Largest dimension any verified format can declare. JPEG frame headers are
 * 16-bit, so a card larger than this could not be checked as JPEG regardless
 * of what PNG or WebP would allow.
 */
export const MAX_IMAGE_DIMENSION = 65_535;

export type ImageSize = {
  width: number;
  height: number;
};

export type SocialImageDescriptor = ImageSize & {
  url: string;
  alt: string;
  /** Media type of the image, for fields such as `og:image:type`. */
  type?: string;
};

/** Descriptor accepted by byte verification before dimensions are known. */
export type SocialImageVerificationDescriptor = {
  url?: string;
  alt?: string;
  width?: number;
  height?: number;
  /** Media type of the image, for fields such as `og:image:type`. */
  type?: string;
};

/**
 * X Card presentation. The emitted HTML protocol still uses `twitter:*`.
 * `player` and `app` carry a card-specific payload; see `XImageOptions`.
 */
export type XCard = "summary" | "summary_large_image" | "player" | "app";

/** Wire-format alias retained for Next.js and existing consumers. */
export type TwitterCard = XCard;

/**
 * The card-specific metadata fields for one card: `player` or `app`, each
 * with an optional `description`, and none for the summary cards.
 * Distributes over a union of cards.
 */
export type XCardMetadataFields<Card extends XCard> = Card extends "player"
  ? { player: XPlayerCard; description?: string }
  : Card extends "app"
    ? { app: XAppCard; description?: string }
    : unknown;

/** X Card metadata for one card, discriminated by `card` when `Card` is a union. */
export type XCardMetadata<Card extends XCard = XCard> = Card extends XCard
  ? {
      card: Card;
      images: SocialImageDescriptor[];
      site?: string;
      siteId?: string;
      creator?: string;
      creatorId?: string;
    } & XCardMetadataFields<Card>
  : never;

export type SocialImageMetadata<
  Card extends XCard = "summary_large_image",
> = {
  openGraph: {
    images: SocialImageDescriptor[];
    /** `og:video` groups; present only when `media.videos` is non-empty. */
    videos?: OpenGraphVideo[];
    /** `og:audio` groups; present only when `media.audio` is non-empty. */
    audio?: OpenGraphAudio[];
  };
  twitter: XCardMetadata<Card>;
};

export type OpenGraphImageOptions = {
  /** Ordered descriptors. Open Graph consumers prefer the first image. */
  images: readonly SocialImageDescriptor[];
};

/**
 * Card-specific X options, discriminated by `card`: a summary card (or an
 * omitted `card`) takes no payload; `card: "player"` requires `player` and
 * `site` or `siteId`; `card: "app"` requires `app` with at least one platform
 * listing and `site`. Both accept a `description` of up to 200 characters.
 */
export type XCardOptions<Card extends XCard = XCard> = Card extends "player"
  ? {
      card: Card;
      player: XPlayerCard;
      /** Emitted as `twitter:description`; at most 200 characters. */
      description?: string;
      app?: never;
    } & ({ site: string } | { siteId: string })
  : Card extends "app"
    ? {
        card: Card;
        app: XAppCard;
        site: string;
        /** Emitted as `twitter:description`; at most 200 characters. */
        description?: string;
        player?: never;
      }
    : { card?: Card; player?: never; app?: never; description?: never };

export type XImageOptions<Card extends XCard = XCard> = {
  /** A channel-specific image. Omit it to reuse the default social image. */
  image?: SocialImageDescriptor;
  /**
   * Names a declared size variant to use as the X Card image instead of the
   * default. Mutually exclusive with `image`.
   */
  variant?: string;
  site?: string;
  siteId?: string;
  creator?: string;
  creatorId?: string;
} & XCardOptions<Card>;

/** Wire-format alias retained for Next.js and existing consumers. */
export type TwitterImageOptions<Card extends XCard = XCard> =
  XImageOptions<Card>;

/**
 * One additional size of the same card, such as a 1080x1080 square beside the
 * 1200x630 default. Its `imagePath` defaults to the default `imagePath` with
 * `-<name>` inserted before the extension (see `variantImagePath`).
 */
export type SocialImageVariantOptions = {
  size: ImageSize;
  imagePath?: string;
  /** Alternative text for this variant; defaults to the card's `alt`. */
  alt?: string;
  /** Media type of this variant; defaults to the card's `type`. */
  type?: string;
};

export type SocialImageOptions<Card extends XCard = XCard> = {
  size?: ImageSize;
  imagePath?: string;
  /** Deployment prefix such as a GitHub Pages repository path. */
  basePath?: string;
  /**
   * Scheme and host, such as `https://example.com`, for crawler-ready
   * absolute image URLs. Untouched relative paths remain the default.
   */
  origin?: string;
  /** Media type of the image, carried into `og:image:type` where used. */
  type?: string;
  /**
   * Named size variants. Each adds one `og:image` descriptor after the
   * default, in declaration order. Names are lowercase kebab-case.
   */
  variants?: Readonly<Record<string, SocialImageVariantOptions>>;
  /** Replaces the default Open Graph image while preserving caller order. */
  openGraph?: OpenGraphImageOptions;
  /** Overrides X Card image, card style, and account identity. */
  twitter?: XImageOptions<Card>;
  /**
   * Open Graph video and audio, carried onto `metadata.openGraph.videos` and
   * `metadata.openGraph.audio` and emitted by `socialMetaTags` after the
   * `og:image` groups. See https://ogp.me/#structured.
   */
  media?: OpenGraphMediaOptions;
};

/** Enforces the image-dimension contract at every public boundary. */
export function assertImageSize(size: ImageSize): void {
  for (const axis of ["width", "height"] as const) {
    const value = size[axis];
    if (!Number.isInteger(value) || value < 1 || value > MAX_IMAGE_DIMENSION) {
      throw new Error(
        `Invalid size: ${axis} must be an integer from 1 to ${MAX_IMAGE_DIMENSION}; received ${value}`,
      );
    }
  }
}

/**
 * Rejects anything that would change the effective path after normalization.
 * Backslashes are path separators in HTTP(S) URLs, percent-encoded dot
 * segments decode to `.`/`..`, and WHATWG URL parsing strips ASCII tab and
 * newline characters, so those are rejected alongside the literal forms
 * rather than emitted for `new URL()` to resolve elsewhere.
 */
function assertPathname(value: string, label: string): void {
  if (value.includes("?") || value.includes("#")) {
    throw new Error(`${label} must be a pathname without a query or fragment: ${value}`);
  }
  if (value.includes("\\")) {
    throw new Error(`${label} must not contain backslashes: ${value}`);
  }
  // WHATWG URL parsing strips ASCII tab and newline (0x09, 0x0A, 0x0D) before
  // normalization, so `.\n.` becomes `..` once `new URL()` runs.
  if (/[\t\n\r]/.test(value)) {
    throw new Error(`${label} must not contain tab or newline characters: ${value}`);
  }
  // Percent-encoded dot segments decode to traversal once `new URL()` runs.
  // Each segment is decoded independently so a malformed escape in one cannot
  // disable dot detection for the rest of the path.
  for (const segment of value.split(/[\\/]/)) {
    if (isDotSegment(segment)) {
      throw new Error(`${label} must not contain "." or ".." segments: ${value}`);
    }
  }
}

/** True when a segment is a WHATWG dot segment, literally or percent-encoded. */
function isDotSegment(segment: string): boolean {
  if (segment === "." || segment === "..") return true;
  if (!segment.includes("%")) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape only disables this one segment's dot check; sibling
    // segments are decoded independently.
    return false;
  }
  return decoded === "." || decoded === "..";
}
function cleanPathPart(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value[start] === "/") {
    start += 1;
  }
  while (end > start && value[end - 1] === "/") {
    end -= 1;
  }

  return value.slice(start, end);
}

function absoluteImageUrl(origin: string, path: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`Invalid origin: expected an http(s) URL; received ${origin}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid origin: expected an http(s) URL; received ${origin}`);
  }
  if (url.username || url.password) {
    throw new Error(`Invalid origin: must not contain credentials; received ${origin}`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      `Invalid origin: must be a scheme and host without a path, query, or fragment; received ${origin}`,
    );
  }
  return new URL(path, url).href;
}

/**
 * Returns a stable pathname suitable for a route handler and the metadata
 * that points at it. `route`, `imagePath`, and `basePath` must be pathnames:
 * query strings, fragments, and `.`/`..` segments change the URL a crawler
 * resolves, so they are rejected rather than silently emitted.
 */
export function socialImagePath(
  route: string,
  imagePath = "og-image",
  basePath = "",
  origin = "",
): string {
  assertPathname(route, "route");
  assertPathname(basePath, "basePath");
  assertPathname(imagePath, "imagePath");

  const basePart = cleanPathPart(basePath);
  const routePart = cleanPathPart(route);
  const imagePart = cleanPathPart(imagePath);

  if (!imagePart) {
    throw new Error("imagePath must contain at least one non-slash character");
  }

  const path = `/${[basePart, routePart, imagePart].filter(Boolean).join("/")}`;
  return origin ? absoluteImageUrl(origin, path) : path;
}

const VARIANT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Variant names become path suffixes and object keys, so they are restricted
 * to lowercase kebab-case starting with a letter: URL-safe, and never an
 * integer-like key that JavaScript would reorder ahead of declaration order.
 */
export function assertVariantName(name: string): void {
  if (!VARIANT_NAME.test(name)) {
    throw new Error(
      `Invalid variant name: expected lowercase kebab-case starting with a letter; received ${JSON.stringify(name)}`,
    );
  }
}

/**
 * Derives a variant's image path by inserting `-<variant>` before the last
 * segment's extension: `og-image.png` becomes `og-image-square.png`, and an
 * extension-free `og-image` becomes `og-image-square`.
 */
export function variantImagePath(imagePath: string, variant: string): string {
  assertVariantName(variant);
  let end = imagePath.length;
  while (end > 0 && imagePath[end - 1] === "/") end -= 1;
  const path = imagePath.slice(0, end);
  const segmentStart = path.lastIndexOf("/") + 1;
  if (segmentStart === path.length) {
    throw new Error("imagePath must contain at least one non-slash character");
  }
  const dot = path.lastIndexOf(".");
  return dot > segmentStart
    ? `${path.slice(0, dot)}-${variant}${path.slice(dot)}`
    : `${path}-${variant}`;
}

/** Builds the image object shared by Open Graph and Twitter metadata. */
export function socialImage(
  route: string,
  alt: string,
  options: SocialImageOptions = {},
): SocialImageDescriptor {
  const size = options.size ?? OG_SIZE;
  if (options.size) assertImageSize(size);
  return {
    url: socialImagePath(route, options.imagePath, options.basePath, options.origin),
    width: size.width,
    height: size.height,
    alt,
    ...(options.type ? { type: options.type } : {}),
  };
}

function copyDescriptor(image: SocialImageDescriptor, label: string): SocialImageDescriptor {
  assertImageSize(image);
  if (!image.url) throw new Error(`${label} image URL must not be empty`);
  if (!image.alt) throw new Error(`${label} image alt text must not be empty`);
  return { ...image };
}

function copyImages(
  images: readonly SocialImageDescriptor[],
  label: string,
): SocialImageDescriptor[] {
  if (images.length === 0) throw new Error(`${label} images must not be empty`);
  return images.map((image) => copyDescriptor(image, label));
}

/**
 * Builds one descriptor per declared variant, keyed by name in declaration
 * order. Every variant URL must differ from the default and from each other,
 * because two sizes served from one URL cannot both match their metadata.
 */
function variantImages(
  route: string,
  alt: string,
  defaultImage: SocialImageDescriptor,
  options: SocialImageOptions,
): Map<string, SocialImageDescriptor> {
  const images = new Map<string, SocialImageDescriptor>();
  const urls = new Set([defaultImage.url]);
  const imagePath = options.imagePath ?? "og-image";
  for (const [name, variant] of Object.entries(options.variants ?? {})) {
    assertVariantName(name);
    const image = socialImage(route, variant.alt ?? alt, {
      size: variant.size,
      imagePath: variant.imagePath ?? variantImagePath(imagePath, name),
      ...(options.basePath === undefined ? {} : { basePath: options.basePath }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...((variant.type ?? options.type) ? { type: variant.type ?? options.type } : {}),
    });
    if (urls.has(image.url)) {
      throw new Error(`Variant "${name}" image URL ${image.url} is already used by another size`);
    }
    urls.add(image.url);
    images.set(name, image);
  }
  return images;
}

function selectTwitterImage(
  twitter: XImageOptions<XCard> | undefined,
  defaultImage: SocialImageDescriptor,
  variants: Map<string, SocialImageDescriptor>,
): SocialImageDescriptor {
  if (twitter?.variant === undefined) return twitter?.image ?? defaultImage;
  if (twitter.image) {
    throw new Error("twitter.image and twitter.variant are mutually exclusive");
  }
  const image = variants.get(twitter.variant);
  if (!image) throw new Error(`Unknown twitter.variant: ${twitter.variant}`);
  return image;
}

/**
 * Builds Open Graph and X Card image metadata. With no overrides it preserves
 * the original one-image, large-card behavior; channel overrides are copied
 * so later caller mutation cannot change the generated metadata. Declared
 * `variants` add one `og:image` each after the default; the X Card image stays
 * the default unless `twitter.variant` or `twitter.image` selects another.
 */
export function socialImageMetadata<
  Card extends XCard = "summary_large_image",
>(
  route: string,
  alt: string,
  options: SocialImageOptions<Card> = {},
): SocialImageMetadata<Card> {
  const image = socialImage(route, alt, options);
  const variants = variantImages(route, alt, image, options);
  const openGraphImages = options.openGraph
    ? copyImages(options.openGraph.images, "Open Graph")
    : [image, ...variants.values()].map((entry) => copyDescriptor(entry, "Open Graph"));
  const twitterImage = selectTwitterImage(options.twitter, image, variants);
  const twitter: XImageOptions<XCard> | undefined = options.twitter;
  const card = twitter?.card ?? "summary_large_image";
  const cardFields = xCardFields({ ...twitter, card, images: [twitterImage] });
  return {
    openGraph: { images: openGraphImages, ...openGraphMedia(options.media) },
    twitter: {
      card,
      images: [copyDescriptor(twitterImage, "Twitter")],
      ...(twitter?.site ? { site: twitter.site } : {}),
      ...(twitter?.siteId ? { siteId: twitter.siteId } : {}),
      ...(twitter?.creator ? { creator: twitter.creator } : {}),
      ...(twitter?.creatorId ? { creatorId: twitter.creatorId } : {}),
      ...cardFields,
    } as XCardMetadata<Card>,
  };
}
