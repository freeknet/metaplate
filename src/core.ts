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

/** X Card presentation. The emitted HTML protocol still uses `twitter:*`. */
export type XCard = "summary" | "summary_large_image";

/** Wire-format alias retained for Next.js and existing consumers. */
export type TwitterCard = XCard;

export type SocialImageMetadata<
  Card extends XCard = "summary_large_image",
> = {
  openGraph: { images: SocialImageDescriptor[] };
  twitter: {
    card: Card;
    images: SocialImageDescriptor[];
    site?: string;
    siteId?: string;
    creator?: string;
    creatorId?: string;
  };
};

export type OpenGraphImageOptions = {
  /** Ordered descriptors. Open Graph consumers prefer the first image. */
  images: readonly SocialImageDescriptor[];
};

export type XImageOptions<Card extends XCard = XCard> = {
  card?: Card;
  /** A channel-specific image. Omit it to reuse the default social image. */
  image?: SocialImageDescriptor;
  site?: string;
  siteId?: string;
  creator?: string;
  creatorId?: string;
};

/** Wire-format alias retained for Next.js and existing consumers. */
export type TwitterImageOptions<Card extends XCard = XCard> =
  XImageOptions<Card>;

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
  /** Replaces the default Open Graph image while preserving caller order. */
  openGraph?: OpenGraphImageOptions;
  /** Overrides X Card image, card style, and account identity. */
  twitter?: XImageOptions<Card>;
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
 * Builds Open Graph and X Card image metadata. With no overrides it preserves
 * the original one-image, large-card behavior; channel overrides are copied
 * so later caller mutation cannot change the generated metadata.
 */
export function socialImageMetadata<
  Card extends XCard = "summary_large_image",
>(
  route: string,
  alt: string,
  options: SocialImageOptions<Card> = {},
): SocialImageMetadata<Card> {
  const image = socialImage(route, alt, options);
  const openGraphImages = options.openGraph
    ? copyImages(options.openGraph.images, "Open Graph")
    : [copyDescriptor(image, "Open Graph")];
  const twitterImage = options.twitter?.image ?? image;
  const twitter = options.twitter;
  return {
    openGraph: { images: openGraphImages },
    twitter: {
      card: (twitter?.card ?? "summary_large_image") as Card,
      images: [copyDescriptor(twitterImage, "Twitter")],
      ...(twitter?.site ? { site: twitter.site } : {}),
      ...(twitter?.siteId ? { siteId: twitter.siteId } : {}),
      ...(twitter?.creator ? { creator: twitter.creator } : {}),
      ...(twitter?.creatorId ? { creatorId: twitter.creatorId } : {}),
    },
  };
}
