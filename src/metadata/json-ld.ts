import { present } from "../core/internal.js";
import {
  canonicalBase,
  dimension,
  imageUrl,
  type SocialMetaInput,
} from "./meta-tags.js";

/**
 * Schema.org JSON-LD for social images.
 *
 * Field names and types follow schema.org's ImageObject definition
 * (https://schema.org/ImageObject) and Google's image metadata guidance
 * (https://developers.google.com/search/docs/appearance/structured-data/image-license-metadata).
 * Google requires `contentUrl` plus at least one of `creator`, `creditText`,
 * `copyrightNotice`, or `license`; once one is present the other three, and
 * `acquireLicensePage`, are recommended. The image fields come from the
 * metadata, so the licensing fields are what a page supplies through options.
 */

/** The JSON-LD context every document from this module declares. */
const SCHEMA_ORG = "https://schema.org";

/** UN/CEFACT Recommendation 20 common code for "pixel". */
const PIXEL_UNIT_CODE = "E37";

/**
 * A creator as Google's image metadata guidance describes it: an
 * `Organization` or `Person` with a `name`. `url` is optional.
 */
export type SocialImageCreator = {
  "@type": "Person" | "Organization";
  name: string;
  url?: string | undefined;
};

/**
 * Optional fields for `socialImageJsonLd`. An undefined or empty string emits
 * no property. Every emitted property except `url` is copied onto each image
 * node, because Google reads licensing metadata per image.
 */
export type SocialImageJsonLdOptions = {
  /**
   * Absolute, credential-free http(s) canonical page URL, validated exactly as
   * `socialMetaTags` validates its `url` option. When supplied, relative image
   * URLs and the URL-valued fields (`license`, `acquireLicensePage`,
   * `creator.url`) resolve against it; absolute URLs are never changed.
   * Without it, URLs are emitted exactly as given. It is not itself emitted:
   * an ImageObject's `url` is the image, not the page.
   */
  url?: string | undefined;
  /** schema.org `name` (Thing): a title for the image. */
  name?: string | undefined;
  /** schema.org `creditText` (CreativeWork); one of Google's required four. */
  creditText?: string | undefined;
  /** schema.org `creator` (CreativeWork); one of Google's required four. */
  creator?: SocialImageCreator | undefined;
  /** schema.org `copyrightNotice` (CreativeWork); one of Google's required four. */
  copyrightNotice?: string | undefined;
  /**
   * schema.org `license` (CreativeWork): URL of the license page. One of
   * Google's required four, and required for Google Images' Licensable badge.
   */
  license?: string | undefined;
  /** schema.org `acquireLicensePage` (CreativeWork): URL explaining how to license the image. */
  acquireLicensePage?: string | undefined;
  /** schema.org `representativeOfPage` (ImageObject). Emitted whenever it is a boolean. */
  representativeOfPage?: boolean | undefined;
};

/**
 * A pixel dimension as a schema.org `QuantitativeValue`. schema.org types
 * MediaObject `width` and `height` as `Distance` or `QuantitativeValue`, and
 * Google's image metadata guidance does not use either property, so there is
 * no Google-documented form to follow. A bare number matches neither expected
 * type and a `Distance` takes a length unit, which pixels are not; a
 * `QuantitativeValue` with the UN/CEFACT pixel code `E37` is the conforming
 * form that states the unit.
 */
export type SchemaOrgPixels = {
  "@type": "QuantitativeValue";
  value: number;
  unitCode: typeof PIXEL_UNIT_CODE;
};

/** One schema.org `ImageObject` node, keys in emitted order. */
export type SocialImageObject = {
  "@type": "ImageObject";
  contentUrl: string;
  url: string;
  name?: string;
  caption?: string;
  encodingFormat?: string;
  width?: SchemaOrgPixels;
  height?: SchemaOrgPixels;
  representativeOfPage?: boolean;
  creditText?: string;
  creator?: SocialImageCreator;
  copyrightNotice?: string;
  license?: string;
  acquireLicensePage?: string;
};

/**
 * A JSON-LD document: one `ImageObject` with its `@context` when the metadata
 * holds one distinct image, otherwise an `@graph` of `ImageObject` nodes in
 * metadata order under a single `@context`.
 */
export type SocialImageJsonLd =
  | ({ "@context": typeof SCHEMA_ORG } & SocialImageObject)
  | { "@context": typeof SCHEMA_ORG; "@graph": SocialImageObject[] };

/** Metadata as `socialImageJsonLd` reads it; every `SocialImageMetadata` fits. */
export type SocialImageJsonLdInput = Pick<SocialMetaInput, "openGraph">;

function pixels(value: number | undefined, axis: string): SchemaOrgPixels | undefined {
  if (value === undefined) return undefined;
  return {
    "@type": "QuantitativeValue",
    value: Number(dimension(value, axis)),
    unitCode: PIXEL_UNIT_CODE,
  };
}

function creatorNode(
  creator: SocialImageCreator | undefined,
  resolve: (url: string) => string,
): SocialImageCreator | undefined {
  if (creator === undefined) return undefined;
  if (creator["@type"] !== "Person" && creator["@type"] !== "Organization") {
    throw new Error(`Invalid creator: @type must be "Person" or "Organization"`);
  }
  if (!present(creator.name)) throw new Error("Invalid creator: name must not be empty");
  const node: SocialImageCreator = { "@type": creator["@type"], name: creator.name };
  if (present(creator.url)) node.url = resolve(creator.url);
  return node;
}

/** Page-level properties in emitted order, already resolved. */
function pageFields(
  options: SocialImageJsonLdOptions,
  resolve: (url: string) => string,
): Partial<SocialImageObject> {
  const fields: Partial<SocialImageObject> = {};
  if (typeof options.representativeOfPage === "boolean") {
    fields.representativeOfPage = options.representativeOfPage;
  }
  if (present(options.creditText)) fields.creditText = options.creditText;
  const creator = creatorNode(options.creator, resolve);
  if (creator) fields.creator = creator;
  if (present(options.copyrightNotice)) fields.copyrightNotice = options.copyrightNotice;
  if (present(options.license)) fields.license = resolve(options.license);
  if (present(options.acquireLicensePage)) {
    fields.acquireLicensePage = resolve(options.acquireLicensePage);
  }
  return fields;
}

/**
 * Describes the metadata's Open Graph images as schema.org `ImageObject`
 * JSON-LD, returned as a plain object ready for `JSON.stringify`.
 *
 * Shape: with one distinct image, a single node carrying `@context`; with
 * several, `{ "@context", "@graph": [...] }`, one node per image in metadata
 * order. A later image whose resolved URL repeats an earlier one is dropped,
 * as in `socialMetaTags`. Only `openGraph.images` is read: X Card images
 * duplicate or subset them.
 *
 * Each node's keys appear in this fixed order, and any whose value is
 * undefined or empty is left out:
 * `@type`, `contentUrl`, `url` (both the image URL; Google prefers
 * `contentUrl` and also supports `url`), `name`, `caption` (the image's alt
 * text), `encodingFormat` (the image's media type), `width`, `height` (as
 * `SchemaOrgPixels`), `representativeOfPage`, `creditText`, `creator`,
 * `copyrightNotice`, `license`, `acquireLicensePage`.
 *
 * References: https://schema.org/ImageObject and
 * https://developers.google.com/search/docs/appearance/structured-data/image-license-metadata
 *
 * @throws When `options.url` is not an absolute, credential-free http(s) URL
 *   (the same rule and message as `socialMetaTags`), when there is no Open
 *   Graph image, when an image URL is empty, when a dimension is not an
 *   integer from 1 to 65535, or when `creator` lacks a valid `@type` or name.
 */
export function socialImageJsonLd(
  metadata: SocialImageJsonLdInput,
  options: SocialImageJsonLdOptions = {},
): SocialImageJsonLd {
  const base = present(options.url) ? canonicalBase(options.url) : undefined;
  const resolve = (url: string) => imageUrl({ url }, base, "JSON-LD");
  const page = pageFields(options, resolve);
  const nodes: SocialImageObject[] = [];
  const seen = new Set<string>();
  for (const image of metadata.openGraph?.images ?? []) {
    const url = imageUrl(image, base, "Open Graph");
    if (seen.has(url)) continue;
    seen.add(url);
    const node: SocialImageObject = { "@type": "ImageObject", contentUrl: url, url };
    if (present(options.name)) node.name = options.name;
    if (present(image.alt)) node.caption = image.alt;
    if (present(image.type)) node.encodingFormat = image.type;
    const width = pixels(image.width, "width");
    if (width) node.width = width;
    const height = pixels(image.height, "height");
    if (height) node.height = height;
    nodes.push({ ...node, ...page });
  }
  const [first] = nodes;
  if (!first) throw new Error("socialImageJsonLd requires at least one Open Graph image");
  if (nodes.length === 1) return { "@context": SCHEMA_ORG, ...first };
  return { "@context": SCHEMA_ORG, "@graph": nodes };
}

/**
 * Characters that could end a script element, open a comment, or break a
 * line: `<`, `>`, `&`, U+2028, U+2029. Built from code points so the source
 * stays ASCII.
 */
const SCRIPT_UNSAFE = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, "g");

/**
 * `JSON.stringify(value)` with `<`, `>`, `&`, U+2028, and U+2029 replaced by
 * their `\uXXXX` escapes. JSON only allows these characters inside strings,
 * where the escape decodes to the same character, so `JSON.parse` of the
 * result equals `JSON.parse(JSON.stringify(value))`. The result contains no
 * `<`, so it cannot close a `<script>` element, open one, or start an HTML
 * comment, and no raw line separators. It is safe as the text of a
 * `<script type="application/ld+json">` element, for example through React's
 * `dangerouslySetInnerHTML`.
 *
 * @throws When `JSON.stringify` produces no JSON text for `value`.
 */
export function serializeJsonLd(value: object): string {
  const json: string | undefined = JSON.stringify(value);
  if (typeof json !== "string") throw new Error("serializeJsonLd: value has no JSON form");
  return json.replace(
    SCRIPT_UNSAFE,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Renders `socialImageJsonLd(metadata, options)` as one
 * `<script type="application/ld+json">` element with no surrounding
 * whitespace. The payload is `serializeJsonLd` output, so no value in the
 * metadata or options can end the element early or inject markup; the only
 * `</script` in the result is its own closing tag.
 *
 * @throws For the same inputs as `socialImageJsonLd`.
 */
export function socialImageJsonLdScript(
  metadata: SocialImageJsonLdInput,
  options: SocialImageJsonLdOptions = {},
): string {
  return `<script type="application/ld+json">${serializeJsonLd(socialImageJsonLd(metadata, options))}</script>`;
}
