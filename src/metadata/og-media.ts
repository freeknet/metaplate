/**
 * Open Graph video and audio: typed inputs, validation, and the `og:video` /
 * `og:audio` tag groups `socialMetaTags` emits after the `og:image` groups.
 *
 * The Open Graph protocol defines both as optional properties with
 * structured properties: `og:video` has the same structured properties as
 * `og:image` (`url`, `secure_url`, `type`, `width`, `height`), and `og:audio`
 * has only the first three (`url`, `secure_url`, `type`), "since size doesn't
 * make sense for sound". Structured properties follow their root tag, and a
 * repeated root tag starts the next item.
 *
 * @see https://ogp.me/#optional
 * @see https://ogp.me/#structured
 * @see https://ogp.me/#array
 */
import { MAX_IMAGE_DIMENSION } from "../core/social-image.js";
import { present } from "../core/internal.js";
import type { SocialMetaTag } from "./meta-tags.js";

/**
 * One `og:video` group. Field names match Next.js `openGraph.videos`
 * descriptors, so `metadata.openGraph` passes to Next's `Metadata` unchanged.
 *
 * @see https://ogp.me/#structured
 */
export type OpenGraphVideo = {
  /**
   * `og:video`. An absolute http(s) URL, or a relative URL that
   * `socialMetaTags` resolves against the canonical page `url` exactly as it
   * resolves relative image URLs. `metaplate/next` requires an absolute URL,
   * because Next.js emits video URLs verbatim.
   */
  url: string;
  /** `og:video:secure_url`. An absolute https URL. */
  secureUrl?: string;
  /** `og:video:type`: a media type such as `video/mp4`. */
  type?: string;
  /** `og:video:width`: an integer from 1 to 65535 pixels. */
  width?: number;
  /** `og:video:height`: an integer from 1 to 65535 pixels. */
  height?: number;
};

/**
 * One `og:audio` group. Open Graph gives audio no dimensions. Field names
 * match Next.js `openGraph.audio` descriptors.
 *
 * @see https://ogp.me/#structured
 */
export type OpenGraphAudio = {
  /** `og:audio`. The same URL rule as `OpenGraphVideo.url`. */
  url: string;
  /** `og:audio:secure_url`. An absolute https URL. */
  secureUrl?: string;
  /** `og:audio:type`: a media type such as `audio/mpeg`. */
  type?: string;
};

/**
 * Video and audio accepted by `socialImageMetadata` (`media`) and plate
 * `metadata()` calls. Order is preserved; Open Graph consumers prefer the
 * first item of each kind.
 */
export type OpenGraphMediaOptions = {
  videos?: readonly OpenGraphVideo[] | undefined;
  audio?: readonly OpenGraphAudio[] | undefined;
};

/**
 * The fields `socialImageMetadata` adds to `metadata.openGraph`. Each key is
 * present only when at least one item was supplied, so metadata without media
 * is unchanged.
 */
export type OpenGraphMedia = {
  videos?: OpenGraphVideo[];
  audio?: OpenGraphAudio[];
};

/** A video as `socialMetaTags` reads it from hand-authored metadata. */
export type SocialMetaVideoInput = {
  url: string;
  secureUrl?: string | undefined;
  type?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
};

/** An audio item as `socialMetaTags` reads it from hand-authored metadata. */
export type SocialMetaAudioInput = {
  url: string;
  secureUrl?: string | undefined;
  type?: string | undefined;
};

/** The media fields of `SocialMetaInput["openGraph"]`. */
export type SocialMetaMediaInput = {
  videos?: readonly SocialMetaVideoInput[] | undefined;
  audio?: readonly SocialMetaAudioInput[] | undefined;
};

type MediaKind = "video" | "audio";

const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const MEDIA_TYPE = new RegExp(
  `^${TOKEN}/${TOKEN}(?:\\s*;\\s*${TOKEN}=(?:${TOKEN}|"[^"\\\\\\r\\n]*"))*$`,
);

/**
 * True for an RFC 9110 media type: `type/subtype` tokens with optional
 * `;name=value` parameters. Shared with renderer `output.contentType` checks.
 */
export function isMediaType(value: string): boolean {
  return MEDIA_TYPE.test(value);
}

function parseAbsolute(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function assertMediaUrl(url: string, label: string): void {
  if (typeof url !== "string" || url === "") {
    throw new Error(`${label} URL must not be empty`);
  }
  const parsed = parseAbsolute(url);
  if (!parsed) return;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid ${label} URL: expected http(s) or a relative URL; received ${url}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Invalid ${label} URL: must not contain credentials; received ${url}`);
  }
}

function assertSecureUrl(url: string, label: string): void {
  const parsed = parseAbsolute(url);
  if (!parsed || parsed.protocol !== "https:") {
    throw new Error(`Invalid ${label} secure_url: expected an absolute https URL; received ${url}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Invalid ${label} secure_url: must not contain credentials; received ${url}`);
  }
}

function assertDimension(value: number, axis: string, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_IMAGE_DIMENSION) {
    throw new Error(
      `Invalid ${label} ${axis}: must be an integer from 1 to ${MAX_IMAGE_DIMENSION}; received ${value}`,
    );
  }
}

/** Validates the fields video and audio share; returns only present fields. */
function checkedMedia(item: SocialMetaAudioInput, kind: MediaKind): OpenGraphAudio {
  const label = `Open Graph ${kind}`;
  assertMediaUrl(item.url, label);
  const copy: OpenGraphAudio = { url: item.url };
  if (present(item.secureUrl)) {
    assertSecureUrl(item.secureUrl, label);
    copy.secureUrl = item.secureUrl;
  }
  if (present(item.type)) {
    if (!isMediaType(item.type)) {
      throw new Error(
        `Invalid ${label} type: expected a media type such as ${kind === "video" ? "video/mp4" : "audio/mpeg"}; received ${item.type}`,
      );
    }
    copy.type = item.type;
  }
  return copy;
}

function checkedVideo(item: SocialMetaVideoInput): OpenGraphVideo {
  const copy: OpenGraphVideo = checkedMedia(item, "video");
  for (const axis of ["width", "height"] as const) {
    const value = item[axis];
    if (value === undefined) continue;
    assertDimension(value, axis, "Open Graph video");
    copy[axis] = value;
  }
  return copy;
}

function checkedAudio(item: SocialMetaAudioInput): OpenGraphAudio {
  return checkedMedia(item, "audio");
}

/**
 * Validates and copies caller media for `metadata.openGraph`, so later caller
 * mutation cannot change generated metadata. Empty lists add no key.
 *
 * @throws When a URL is empty, an absolute URL is not credential-free
 *   http(s), a `secureUrl` is not an absolute https URL, a `type` is not a
 *   media type, or a video dimension is not an integer from 1 to 65535.
 */
export function openGraphMedia(options: OpenGraphMediaOptions | undefined): OpenGraphMedia {
  const videos = (options?.videos ?? []).map(checkedVideo);
  const audio = (options?.audio ?? []).map(checkedAudio);
  return {
    ...(videos.length > 0 ? { videos } : {}),
    ...(audio.length > 0 ? { audio } : {}),
  };
}

/**
 * Rejects relative media URLs. Next.js resolves `openGraph.images` against
 * `metadataBase` but emits `openGraph.videos` and `openGraph.audio` URLs
 * verbatim, and documents both as "Must be an absolute URL".
 *
 * @see https://nextjs.org/docs/app/api-reference/functions/generate-metadata#opengraph
 */
export function assertAbsoluteMedia(media: OpenGraphMedia, entry: string): void {
  for (const item of [...(media.videos ?? []), ...(media.audio ?? [])]) {
    if (!parseAbsolute(item.url)) {
      throw new Error(
        `${entry} requires absolute Open Graph video and audio URLs because Next.js emits them without resolving metadataBase; received ${item.url}`,
      );
    }
  }
}

function resolveUrl(url: string, base: URL | undefined): string {
  if (!base || parseAbsolute(url)) return url;
  return new URL(url, base).href;
}

function groupTags(kind: MediaKind, items: readonly OpenGraphVideo[], base: URL | undefined): SocialMetaTag[] {
  const tags: SocialMetaTag[] = [];
  const seen = new Set<string>();
  const root = `og:${kind}`;
  const add = (suffix: string, content: string | number | undefined) => {
    if (content !== undefined) tags.push({ property: `${root}:${suffix}`, content: String(content) });
  };
  for (const item of items) {
    const url = resolveUrl(item.url, base);
    // As with images, a crawler cannot tell two groups with one URL apart.
    if (seen.has(url)) continue;
    seen.add(url);
    tags.push({ property: root, content: url });
    add("secure_url", item.secureUrl);
    add("type", item.type);
    add("width", item.width);
    add("height", item.height);
  }
  return tags;
}

/**
 * The tags `socialMetaTags` emits between the `og:image` groups and the
 * `twitter:*` tags: for each video, in order, `og:video`,
 * `og:video:secure_url`, `og:video:type`, `og:video:width`,
 * `og:video:height`; then for each audio item `og:audio`,
 * `og:audio:secure_url`, `og:audio:type`. Absent fields emit no tag, relative
 * URLs resolve against the canonical `base` when one is given, and a group
 * whose resolved URL repeats an earlier one of the same kind is dropped.
 */
export function openGraphMediaTags(
  openGraph: SocialMetaMediaInput | undefined,
  base: URL | undefined,
): SocialMetaTag[] {
  return [
    ...groupTags("video", (openGraph?.videos ?? []).map(checkedVideo), base),
    ...groupTags("audio", (openGraph?.audio ?? []).map(checkedAudio), base),
  ];
}
