/**
 * Runtime-neutral emoji images for Satori. No peers and no Node built-ins, so
 * `metaplate/edge` bundles it unchanged; the Node package reader lives in
 * `metaplate/fonts`.
 *
 * Satori asks `loadAdditionalAsset("emoji", grapheme)` for every emoji
 * grapheme cluster no font covers and draws the returned image URL in place of
 * the glyph. A Metaplate emoji loader answers with a `data:` URI, because
 * Resvg rasterises the SVG offline and never fetches a remote `href`.
 */

import { base64, bytesOf } from "../core/bytes.js";

/**
 * The image for one emoji: SVG markup, an existing `data:image/svg+xml` or
 * `data:image/png` URI, or the bytes of an SVG or PNG file.
 */
export type EmojiImage = string | ArrayBuffer | ArrayBufferView;

/** One emoji grapheme cluster Satori could not draw with the plate's fonts. */
export type EmojiRequest = Readonly<{
  /** The grapheme cluster exactly as it appears in the copy, such as `"👋🏽"`. */
  grapheme: string;
  /** Its Unicode code points, variation selectors (U+FE0F) included. */
  codepoints: readonly number[];
}>;

/**
 * Supplies the image for one emoji. Return `undefined` when the set has no
 * image for it; Satori then draws the grapheme with the plate's fonts.
 * Throwing (a network or read failure) fails the render and is not memoized.
 */
export type EmojiSource = (
  emoji: EmojiRequest,
) => EmojiImage | undefined | Promise<EmojiImage | undefined>;

/**
 * A memoized emoji resolver for a plate's `emoji` option: resolves a grapheme
 * cluster to a `data:` image URI, or `undefined` when there is no image.
 */
export type EmojiLoader = (grapheme: string) => Promise<string | undefined>;

const VARIATION_SELECTOR_16 = 0xfe0f;
const ZERO_WIDTH_JOINER = 0x200d;

/**
 * The longest fully-qualified RGI emoji sequence is ten code points (a kiss
 * with two skin tones); subdivision flags are seven. Anything far longer is
 * not an emoji any set draws, so it is never looked up or cached.
 */
const MAX_EMOJI_CODEPOINTS = 16;

/**
 * Bounds the per-loader memo: copy can be user-supplied, and arbitrary
 * ZWJ-joined pictographs would otherwise grow the cache without limit. The
 * full RGI set is under 4,000 sequences, so real plates never evict.
 */
const MAX_CACHED_EMOJI = 4096;

/**
 * What Satori may hand to the `emoji` language code: a pictograph, a regional
 * indicator (flags), or a keycap. Satori classifies whole words, so a word
 * such as `"hi🎉"` can also send `"h"` and `"i"`; those never reach a source.
 */
const EMOJI_GRAPHEME = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;

/** The code points of a grapheme cluster, variation selectors included. */
export function emojiCodepoints(grapheme: string): number[] {
  return Array.from(grapheme, (character) => character.codePointAt(0)!);
}

function hex(codepoints: readonly number[]): string {
  return codepoints.map((codepoint) => codepoint.toString(16)).join("-");
}

/**
 * The Twemoji file stem for a grapheme cluster, such as `1f44b-1f3fd` for
 * `"👋🏽"`: lowercase hex without zero padding, joined by `-`. Following
 * Twemoji's own parser (and `@vercel/og`), U+FE0F is removed from sequences
 * without a zero-width joiner (`"❤️"` is `2764`, `"#️⃣"` is `23-20e3`) and kept
 * in ZWJ sequences (`"❤️‍🔥"` is `2764-fe0f-200d-1f525`).
 */
export function twemojiName(grapheme: string): string {
  const codepoints = emojiCodepoints(grapheme);
  return hex(
    codepoints.includes(ZERO_WIDTH_JOINER)
      ? codepoints
      : codepoints.filter((codepoint) => codepoint !== VARIATION_SELECTOR_16),
  );
}

/**
 * A qualification-insensitive key: lowercase hex with every U+FE0F removed.
 * Emoji sets disagree on where U+FE0F appears in file names, and copy may be
 * fully qualified or not; with the selector removed, no two images in
 * Twemoji or OpenMoji share a key, so the key identifies the image.
 */
export function emojiKey(codepoints: readonly number[]): string {
  return hex(codepoints.filter((codepoint) => codepoint !== VARIATION_SELECTOR_16));
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isSvgMarkup(text: string): boolean {
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  return trimmed.startsWith("<") && /<svg[\s>]/.test(trimmed);
}

function describe(image: EmojiImage): string {
  if (typeof image === "string") return JSON.stringify(image.slice(0, 32));
  const bytes = bytesOf(image);
  const head = [...bytes.subarray(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
  return `${bytes.byteLength} bytes starting ${head || "(empty)"}`;
}

/**
 * Normalizes an emoji image to a `data:` URI Resvg can draw. Anything that is
 * not SVG or PNG (an HTML error page served with status 200, an empty body)
 * is rejected rather than embedded, because Satori would draw it as nothing
 * and a cached card would silently lose the emoji.
 */
function emojiDataUri(grapheme: string, image: EmojiImage): string {
  if (typeof image === "string") {
    if (/^data:image\/(?:svg\+xml|png)[;,]/i.test(image)) return image;
    if (isSvgMarkup(image)) {
      return `data:image/svg+xml;base64,${base64(new TextEncoder().encode(image))}`;
    }
  } else {
    const bytes = bytesOf(image);
    if (bytes.length >= 8 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
      return `data:image/png;base64,${base64(bytes)}`;
    }
    if (isSvgMarkup(new TextDecoder().decode(bytes.subarray(0, 4096)))) {
      return `data:image/svg+xml;base64,${base64(bytes)}`;
    }
  }
  throw new TypeError(
    `Emoji image for ${JSON.stringify(grapheme)} is not SVG or PNG: received ${describe(image)}`,
  );
}

/**
 * Wraps an emoji source in a memoized loader for a plate's `emoji` option.
 * Each grapheme is resolved once per loader, including "no image" answers;
 * a source that throws is not memoized, so the next render retries.
 */
export function emojiLoader(source: EmojiSource): EmojiLoader {
  const cache = new Map<string, Promise<string | undefined>>();

  return (grapheme) => {
    const cached = cache.get(grapheme);
    if (cached) return cached;

    const codepoints = emojiCodepoints(grapheme);
    if (codepoints.length > MAX_EMOJI_CODEPOINTS || !EMOJI_GRAPHEME.test(grapheme)) {
      return Promise.resolve(undefined);
    }

    const loaded = (async () => {
      const image = await source(Object.freeze({ grapheme, codepoints: Object.freeze(codepoints) }));
      return image === undefined ? undefined : emojiDataUri(grapheme, image);
    })();
    loaded.catch(() => {
      if (cache.get(grapheme) === loaded) cache.delete(grapheme);
    });
    if (cache.size >= MAX_CACHED_EMOJI) cache.delete(cache.keys().next().value!);
    cache.set(grapheme, loaded);
    return loaded;
  };
}
