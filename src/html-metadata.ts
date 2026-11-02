/**
 * Bounded extraction of social-preview metadata from an HTML document.
 *
 * The scanner is one forward pass built from `indexOf` and character-code
 * checks. No regular expression ever runs over document text, and every loop
 * advances the cursor, so the work is linear in the input length whatever
 * the markup looks like.
 *
 * It follows the parts of the HTML tokenizer that decide what a crawler sees
 * in `<head>`: comments, doctypes, and raw-text elements (`<script>`,
 * `<style>`, `<title>`, `<noscript>`, ...) are skipped; the head ends where
 * the tree builder would end it; attribute names are
 * ASCII-lowercased; values may be double-quoted, single-quoted, or unquoted;
 * the first of two same-named attributes wins; and character references in
 * attribute values are decoded. It is not a full HTML tree builder.
 */

/** One `og:image` and the structured properties that followed it. */
export type PageOpenGraphImage = Readonly<{
  /** `og:image` (or `og:image:url`) content, decoded and trimmed, as written. */
  url: string;
  /** `og:image:secure_url`. */
  secureUrl?: string;
  /** `og:image:type`. */
  type?: string;
  /** `og:image:width`, as written. */
  width?: string;
  /** `og:image:height`, as written. */
  height?: string;
  /** `og:image:alt`. */
  alt?: string;
}>;

/** One image URL found in a Schema.org JSON-LD block. */
export type PageJsonLdImage = Readonly<{
  /** `contentUrl` (or `url`) of an `ImageObject`, or a bare `image` URL, as written. */
  url: string;
  /** Pixel `width`, when declared as a number or a pixel `QuantitativeValue`. */
  width?: number;
  /** Pixel `height`, when declared as a number or a pixel `QuantitativeValue`. */
  height?: number;
  /** `encodingFormat`. */
  encodingFormat?: string;
  /** Zero-based position of the `<script type="application/ld+json">` element. */
  script: number;
}>;

export type PageMetadataIssueCode = "orphan-property" | "meta-outside-head" | "json-ld";

/** A markup problem found while extracting; never fatal. */
export type PageMetadataIssue = Readonly<{ code: PageMetadataIssueCode; message: string }>;

export type PageSocialMetadata = Readonly<{
  /** The document's URL: the final URL after redirects. */
  documentUrl: string;
  /** The document base URL every relative URL resolves against. */
  baseUrl: string;
  /** The first `<base href>`, as written, when the document has one. */
  baseHref?: string;
  openGraph: Readonly<{
    title?: string;
    description?: string;
    /** Every `og:image`, in document order; the first is preferred. */
    images: readonly PageOpenGraphImage[];
  }>;
  twitter: Readonly<{
    card?: string;
    title?: string;
    description?: string;
    image?: string;
    imageAlt?: string;
  }>;
  jsonLd: Readonly<{
    /** Number of `application/ld+json` script elements. */
    scripts: number;
    images: readonly PageJsonLdImage[];
  }>;
  issues: readonly PageMetadataIssue[];
}>;

// ---------------------------------------------------------------------------
// Character references

/**
 * Named references decoded in attribute values: the five XML predefined
 * names, their uppercase legacy forms, and common punctuation and symbols.
 * Any other named reference is left exactly as written.
 */
const NAMED_REFERENCES = new Map<string, string>([
  ["amp", "&"], ["AMP", "&"], ["lt", "<"], ["LT", "<"], ["gt", ">"], ["GT", ">"],
  ["quot", "\""], ["QUOT", "\""], ["apos", "'"], ["nbsp", " "],
  ["copy", "©"], ["COPY", "©"], ["reg", "®"], ["REG", "®"],
  ["trade", "™"], ["hellip", "…"], ["mdash", "—"], ["ndash", "–"],
  ["lsquo", "‘"], ["rsquo", "’"], ["ldquo", "“"], ["rdquo", "”"],
  ["laquo", "«"], ["raquo", "»"], ["middot", "·"], ["bull", "•"],
  ["euro", "€"], ["pound", "£"], ["yen", "¥"], ["cent", "¢"],
  ["sect", "§"], ["deg", "°"], ["times", "×"], ["divide", "÷"],
]);

/** Names the HTML tokenizer also recognizes without a trailing semicolon. */
const LEGACY_REFERENCES = new Set(["amp", "AMP", "lt", "LT", "gt", "GT", "quot", "QUOT", "nbsp", "copy", "COPY", "reg", "REG"]);

/** The HTML numeric-reference replacements for 0x80-0x9F (windows-1252). */
const C1_REPLACEMENTS = new Map<number, number>([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026],
  [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160],
  [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019],
  [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153],
  [0x9e, 0x017e], [0x9f, 0x0178],
]);

const MAX_REFERENCE_NAME = 32;

function isAsciiAlpha(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function hexValue(code: number): number {
  if (isAsciiDigit(code)) return code - 0x30;
  const lower = code | 0x20;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x61 + 10 : -1;
}

function isHtmlWhitespace(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
}

type Decoded = { text: string; end: number };

function numericReference(value: string, at: number): Decoded | undefined {
  const hex = value.charCodeAt(at) === 0x78 || value.charCodeAt(at) === 0x58;
  const base = hex ? 16 : 10;
  let index = hex ? at + 1 : at;
  const start = index;
  let code = 0;
  for (; index < value.length; index += 1) {
    const digit = hex ? hexValue(value.charCodeAt(index)) : (isAsciiDigit(value.charCodeAt(index)) ? value.charCodeAt(index) - 0x30 : -1);
    if (digit < 0) break;
    // Clamp rather than grow: anything past U+10FFFF is replaced anyway.
    code = Math.min(code * base + digit, 0x110000);
  }
  if (index === start) return undefined;
  if (value.charCodeAt(index) === 0x3b) index += 1;
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
  return { text: String.fromCodePoint(C1_REPLACEMENTS.get(code) ?? code), end: index };
}

function characterReference(value: string, at: number): Decoded | undefined {
  if (value.charCodeAt(at) === 0x23) return numericReference(value, at + 1);
  let end = at;
  while (end < value.length && end - at <= MAX_REFERENCE_NAME) {
    const code = value.charCodeAt(end);
    if (!isAsciiAlpha(code) && !isAsciiDigit(code)) break;
    end += 1;
  }
  const name = value.slice(at, end);
  const text = NAMED_REFERENCES.get(name);
  if (text === undefined) return undefined;
  if (value.charCodeAt(end) === 0x3b) return { text, end: end + 1 };
  // In an attribute value, a legacy reference followed by "=" or an
  // alphanumeric stays literal, which keeps query strings such as
  // "?a=1&copy=2" intact. The alphanumeric case cannot reach here.
  return LEGACY_REFERENCES.has(name) && value.charCodeAt(end) !== 0x3d ? { text, end } : undefined;
}

/**
 * Decodes character references in an HTML attribute value: every numeric
 * reference, and the named references listed in `NAMED_REFERENCES`.
 */
export function decodeAttributeValue(value: string): string {
  let index = value.indexOf("&");
  if (index === -1) return value;
  let decoded = value.slice(0, index);
  while (index !== -1) {
    const reference = characterReference(value, index + 1);
    const next = reference ? reference.end : index + 1;
    decoded += reference ? reference.text : "&";
    index = value.indexOf("&", next);
    decoded += value.slice(next, index === -1 ? value.length : index);
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// Tokenizer

type Tag =
  | { kind: "start"; name: string; attributes: ReadonlyMap<string, string>; text?: string }
  | { kind: "end"; name: string }
  /** Character data between `start` and `end`; the consumer inspects it only when it matters. */
  | { kind: "text"; start: number; end: number };

/**
 * Elements whose content the tokenizer reads as text up to their end tag.
 * `noscript` is raw text because browsers and crawlers that render parse
 * with scripting enabled; a `<noscript><img></noscript>` in the head (as in
 * analytics pixel snippets) therefore neither ends the head nor hides the
 * tags after it.
 */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes", "noscript"]);

function tagNameEnd(html: string, from: number): number {
  let index = from;
  while (index < html.length) {
    const code = html.charCodeAt(index);
    if (isHtmlWhitespace(code) || code === 0x2f || code === 0x3e) break;
    index += 1;
  }
  return index;
}

/** Strips leading and trailing ASCII whitespace only, never U+00A0 or other spaces. */
function asciiTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isHtmlWhitespace(value.charCodeAt(start))) start += 1;
  while (end > start && isHtmlWhitespace(value.charCodeAt(end - 1))) end -= 1;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

function hasNonWhitespace(html: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (!isHtmlWhitespace(html.charCodeAt(index))) return true;
  }
  return false;
}

function skipWhitespace(html: string, from: number): number {
  let index = from;
  while (index < html.length && isHtmlWhitespace(html.charCodeAt(index))) index += 1;
  return index;
}

type StartTag = { name: string; attributes: Map<string, string>; end: number };

/** Reads one attribute value starting at `from`, or `undefined` at end of input. */
function attributeValue(html: string, from: number): { value: string; end: number } | undefined {
  const quote = html.charCodeAt(from);
  if (quote === 0x22 || quote === 0x27) {
    const close = html.indexOf(quote === 0x22 ? "\"" : "'", from + 1);
    return close === -1 ? undefined : { value: html.slice(from + 1, close), end: close + 1 };
  }
  let index = from;
  while (index < html.length) {
    const code = html.charCodeAt(index);
    if (isHtmlWhitespace(code) || code === 0x3e) break;
    index += 1;
  }
  return { value: html.slice(from, index), end: index };
}

/**
 * Parses a start tag whose name begins at `at`. Returns `undefined` when the
 * input ends inside the tag, which the HTML tokenizer discards.
 */
function startTag(html: string, at: number): StartTag | undefined {
  let index = tagNameEnd(html, at);
  const name = html.slice(at, index).toLowerCase();
  const attributes = new Map<string, string>();
  for (;;) {
    while (index < html.length && (isHtmlWhitespace(html.charCodeAt(index)) || html.charCodeAt(index) === 0x2f)) {
      index += 1;
    }
    if (index >= html.length) return undefined;
    if (html.charCodeAt(index) === 0x3e) return { name, attributes, end: index + 1 };
    const nameStart = index;
    // The first character may be "=", which then belongs to the name.
    index += 1;
    while (index < html.length) {
      const code = html.charCodeAt(index);
      if (isHtmlWhitespace(code) || code === 0x2f || code === 0x3e || code === 0x3d) break;
      index += 1;
    }
    const attributeName = html.slice(nameStart, index).toLowerCase();
    index = skipWhitespace(html, index);
    let value = "";
    if (html.charCodeAt(index) === 0x3d) {
      const read = attributeValue(html, skipWhitespace(html, index + 1));
      if (!read) return undefined;
      value = read.value;
      index = read.end;
    }
    if (!attributes.has(attributeName)) attributes.set(attributeName, decodeAttributeValue(value));
  }
}

/** Finds `</name` (ASCII case-insensitive) that closes a raw-text element. */
function rawTextEnd(html: string, from: number, name: string): { textEnd: number; resume: number } {
  let index = html.indexOf("</", from);
  while (index !== -1) {
    const after = index + 2 + name.length;
    const terminator = html.charCodeAt(after);
    if (
      html.slice(index + 2, after).toLowerCase() === name &&
      (Number.isNaN(terminator) || isHtmlWhitespace(terminator) || terminator === 0x2f || terminator === 0x3e)
    ) {
      const close = html.indexOf(">", after);
      return { textEnd: index, resume: close === -1 ? html.length : close + 1 };
    }
    index = html.indexOf("</", index + 2);
  }
  return { textEnd: html.length, resume: html.length };
}

/**
 * Where a comment that opens at `from` (just after `<!--`) ends. As in the
 * tokenizer, `<!-->` and `<!--->` are complete (empty) comments, and both
 * `-->` and `--!>` close one; an unclosed comment runs to the end of input.
 */
function commentEnd(html: string, from: number): number {
  if (html.charCodeAt(from) === 0x3e) return from + 1;
  if (html.startsWith("->", from)) return from + 2;
  let dashes = html.indexOf("--", from);
  while (dashes !== -1) {
    if (html.charCodeAt(dashes + 2) === 0x3e) return dashes + 3;
    if (html.startsWith("!>", dashes + 2)) return dashes + 4;
    dashes = html.indexOf("--", dashes + 1);
  }
  return html.length;
}

/** Yields start tags, end tags, and the text between them, in document order. */
function* tags(html: string): Generator<Tag> {
  let index = html.indexOf("<");
  if (index !== 0) yield { kind: "text", start: 0, end: index === -1 ? html.length : index };
  while (index !== -1 && index < html.length) {
    const next = html.charCodeAt(index + 1);
    let resume: number;
    let textFrom: number | undefined;
    if (html.startsWith("<!--", index)) {
      resume = commentEnd(html, index + 4);
    } else if (next === 0x21 || next === 0x3f || (next === 0x2f && !isAsciiAlpha(html.charCodeAt(index + 2)))) {
      // Doctype, processing instruction, or bogus comment: skip to ">".
      const close = html.indexOf(">", index + 2);
      resume = close === -1 ? html.length : close + 1;
    } else if (next === 0x2f) {
      const nameEnd = tagNameEnd(html, index + 2);
      const close = html.indexOf(">", nameEnd);
      if (close === -1) return;
      yield { kind: "end", name: html.slice(index + 2, nameEnd).toLowerCase() };
      resume = close + 1;
    } else if (isAsciiAlpha(next)) {
      const tag = startTag(html, index + 1);
      if (!tag) return;
      resume = tag.end;
      if (RAW_TEXT_ELEMENTS.has(tag.name)) {
        const raw = rawTextEnd(html, tag.end, tag.name);
        resume = raw.resume;
        yield { kind: "start", name: tag.name, attributes: tag.attributes, text: html.slice(tag.end, raw.textEnd) };
      } else {
        yield { kind: "start", name: tag.name, attributes: tag.attributes };
      }
    } else {
      // A "<" that starts no markup is text.
      resume = index + 1;
      textFrom = index;
    }
    index = html.indexOf("<", resume);
    const textEnd = index === -1 ? html.length : index;
    if (textEnd > (textFrom ?? resume)) yield { kind: "text", start: textFrom ?? resume, end: textEnd };
  }
}

// ---------------------------------------------------------------------------
// Encoding

function charsetParameter(contentType: string): string | undefined {
  for (const parameter of contentType.split(";").slice(1)) {
    const separator = parameter.indexOf("=");
    if (separator === -1 || parameter.slice(0, separator).trim().toLowerCase() !== "charset") continue;
    const value = parameter.slice(separator + 1).trim();
    const unquoted = value.startsWith("\"") && value.endsWith("\"") && value.length >= 2 ? value.slice(1, -1) : value;
    if (unquoted !== "") return unquoted;
  }
  return undefined;
}

function decoderFor(label: string | undefined, fromMeta = false): TextDecoder | undefined {
  if (label === undefined) return undefined;
  try {
    const decoder = new TextDecoder(label);
    // The <meta> prescan cannot have read a UTF-16 document as ASCII, so a
    // UTF-16 label found there means UTF-8, and x-user-defined means
    // windows-1252. A transport-layer (Content-Type) label is used as given.
    if (fromMeta && decoder.encoding.startsWith("utf-16")) return new TextDecoder("utf-8");
    if (fromMeta && decoder.encoding === "x-user-defined") return new TextDecoder("windows-1252");
    return decoder;
  } catch {
    return undefined;
  }
}

/** Looks for `<meta charset>` or an `http-equiv` Content-Type in the first 1024 bytes. */
function prescanCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  for (const tag of tags(head)) {
    if (tag.kind !== "start" || tag.name !== "meta") continue;
    const charset = tag.attributes.get("charset")?.trim();
    if (charset) return charset;
    if (tag.attributes.get("http-equiv")?.trim().toLowerCase() === "content-type") {
      const declared = charsetParameter(`x;${tag.attributes.get("content") ?? ""}`);
      if (declared) return declared;
    }
  }
  return undefined;
}

/**
 * Decodes an HTML response body. A byte order mark wins, then the
 * Content-Type `charset`, then a `<meta>` declaration in the first 1024
 * bytes; anything else is read as UTF-8. Undecodable bytes become U+FFFD.
 */
export function decodeHtmlBytes(bytes: Uint8Array, contentType: string | undefined): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  const decoder =
    decoderFor(contentType === undefined ? undefined : charsetParameter(contentType)) ??
    decoderFor(prescanCharset(bytes), true) ??
    new TextDecoder("utf-8");
  return decoder.decode(bytes);
}

// ---------------------------------------------------------------------------
// JSON-LD

const MAX_JSON_LD_DEPTH = 32;
const MAX_JSON_LD_NODES = 10_000;
const IMAGE_OBJECT_TYPES = new Set([
  "ImageObject",
  "schema:ImageObject",
  "http://schema.org/ImageObject",
  "https://schema.org/ImageObject",
]);

type JsonObject = { [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageObject(node: JsonObject): boolean {
  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  return types.some((entry) => typeof entry === "string" && IMAGE_OBJECT_TYPES.has(entry));
}

function firstString(value: unknown): string | undefined {
  const candidate = Array.isArray(value) ? value.find((entry) => typeof entry === "string") : value;
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate.trim() : undefined;
}

/** A pixel length: a number, a digit string, or a `QuantitativeValue` in pixels (E37). */
function pixels(value: unknown): number | undefined {
  let amount = value;
  if (isObject(value)) {
    const unit = value.unitCode ?? value.unitText;
    if (unit !== undefined && unit !== "E37" && unit !== "px") return undefined;
    amount = value.value;
  }
  if (typeof amount === "string" && /^\d{1,6}$/.test(amount.trim())) amount = Number(amount.trim());
  return typeof amount === "number" && Number.isSafeInteger(amount) && amount > 0 ? amount : undefined;
}

type JsonLdCollector = {
  images: PageJsonLdImage[];
  /** Position of each URL in `images`, so a repeat merges in constant time. */
  positions: Map<string, number>;
  nodes: number;
  truncated: boolean;
  /** Script elements seen so far. */
  scripts: number;
  /** Index of the script being walked. */
  current: number;
};

function addJsonLdImage(collector: JsonLdCollector, image: PageJsonLdImage): void {
  const existing = collector.positions.get(image.url);
  if (existing === undefined) {
    collector.positions.set(image.url, collector.images.length);
    collector.images.push(Object.freeze(image));
    return;
  }
  // The same URL seen twice keeps one entry with every declared fact.
  collector.images[existing] = Object.freeze({ ...image, ...collector.images[existing] });
}

function imageObject(node: JsonObject, script: number): PageJsonLdImage | undefined {
  // contentUrl is "actual bytes of the media object"; url is the item's URL.
  const url = firstString(node.contentUrl) ?? firstString(node.url);
  if (url === undefined) return undefined;
  const width = pixels(node.width);
  const height = pixels(node.height);
  const encodingFormat = firstString(node.encodingFormat);
  return {
    url,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(encodingFormat !== undefined ? { encodingFormat } : {}),
    script,
  };
}

/**
 * Walks a parsed JSON-LD value. `asImage` marks a value of an `image`
 * property, whose Schema.org range is ImageObject or URL: a string there is
 * an image URL, and an untyped object there is read as an ImageObject.
 */
function walkJsonLd(value: unknown, depth: number, asImage: boolean, collector: JsonLdCollector): void {
  if (collector.nodes >= MAX_JSON_LD_NODES || depth > MAX_JSON_LD_DEPTH) {
    collector.truncated = true;
    return;
  }
  collector.nodes += 1;
  if (typeof value === "string") {
    if (asImage && value.trim() !== "") addJsonLdImage(collector, { url: value.trim(), script: collector.current });
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) walkJsonLd(entry, depth + 1, asImage, collector);
    return;
  }
  if (!isObject(value)) return;
  if (isImageObject(value) || (asImage && value["@type"] === undefined)) {
    const image = imageObject(value, collector.current);
    if (image) addJsonLdImage(collector, image);
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "object" || key === "image") walkJsonLd(child, depth + 1, key === "image", collector);
  }
}

function isJsonLdScript(attributes: ReadonlyMap<string, string>): boolean {
  const type = attributes.get("type");
  return type !== undefined && type.split(";", 1)[0]!.trim().toLowerCase() === "application/ld+json";
}

// ---------------------------------------------------------------------------
// Extraction

/**
 * Start tags the "in head" insertion mode keeps in the head. `html` and
 * `head` change nothing there; any other start tag ends the head.
 */
const HEAD_ELEMENTS = new Set([
  "html", "head", "meta", "link", "title", "base", "script", "style", "noscript", "noframes", "template", "basefont", "bgsound",
]);

/**
 * Start tags the "after head" insertion mode (after `</head>`, before the
 * body) still processes with the "in head" rules; `html` and `head` change
 * nothing; anything else starts the body.
 */
const AFTER_HEAD_ELEMENTS = new Set([
  "html", "head", "base", "basefont", "bgsound", "link", "meta", "noframes", "script", "style", "template", "title",
]);

/** End tags that, before the body, start it ("anything else" in the after-head mode). */
const BODY_STARTING_END_TAGS = new Set(["body", "html", "br"]);

type MutableImage = { -readonly [Key in keyof PageOpenGraphImage]: PageOpenGraphImage[Key] };
type TwitterFields = { -readonly [Key in keyof PageSocialMetadata["twitter"]]: PageSocialMetadata["twitter"][Key] };

const IMAGE_PROPERTIES = {
  "og:image:secure_url": "secureUrl",
  "og:image:type": "type",
  "og:image:width": "width",
  "og:image:height": "height",
  "og:image:alt": "alt",
} as const satisfies Record<string, keyof MutableImage>;

const TWITTER_PROPERTIES = {
  "twitter:card": "card",
  "twitter:title": "title",
  "twitter:description": "description",
  "twitter:image": "image",
  "twitter:image:alt": "imageAlt",
} as const satisfies Record<string, keyof TwitterFields>;

function isTagKey<Table extends object>(table: Table, key: string): key is Extract<keyof Table, string> {
  return Object.hasOwn(table, key);
}

/** Open Graph state: structured properties attach to the latest root `og:image`. */
class OpenGraphReader {
  readonly images: MutableImage[] = [];
  title: string | undefined;
  description: string | undefined;
  orphans: string[] = [];
  private current: MutableImage | undefined;
  private currentHasUrl = false;

  read(key: string, content: string): void {
    if (key === "og:title") this.title ??= content;
    else if (key === "og:description") this.description ??= content;
    else if (key === "og:image") this.start(content, false);
    else if (key === "og:image:url") {
      // Identical to og:image: it names the current image unless that image
      // already had one, in which case it starts the next image.
      if (!this.current || this.currentHasUrl) this.start(content, true);
      else this.currentHasUrl = true;
    } else if (isTagKey(IMAGE_PROPERTIES, key)) {
      const field = IMAGE_PROPERTIES[key];
      if (!this.current) this.orphans.push(key);
      // The first value wins, as Open Graph gives the first tag preference.
      else this.current[field] ??= content;
    }
  }

  private start(url: string, fromUrlProperty: boolean): void {
    this.current = { url };
    this.currentHasUrl = fromUrlProperty;
    this.images.push(this.current);
  }
}

/**
 * Resolves the document base URL from the first `<base href>` (HTML "frozen
 * base URL"). The HTML algorithm falls back for `data:` and `javascript:`
 * bases; this keeps only http(s) bases, because only http(s) image URLs can be
 * fetched and any other scheme (`vbscript:`, `file:`, ...) would resolve every
 * relative image to something unfetchable.
 */
function frozenBaseUrl(href: string, fallback: URL): URL {
  try {
    const parsed = new URL(href.trim(), fallback);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function metaKeys(attributes: ReadonlyMap<string, string>): string[] {
  const keys = new Set<string>();
  for (const attribute of ["property", "name"]) {
    const value = attributes.get(attribute);
    const key = value === undefined ? undefined : asciiTrim(value).toLowerCase();
    if (key && (key.startsWith("og:") || key.startsWith("twitter:"))) keys.add(key);
  }
  return [...keys];
}

type InsertionMode = "head" | "after-head" | "body";

/** What one pass over a document found, including where its head ended. */
export type PageScan = {
  metadata: PageSocialMetadata;
  /** The head ended (`</head>`, `<body>`, or body content) within the input. */
  headEnded: boolean;
};

/**
 * Tracks the HTML tree builder's head/body decision closely enough to say
 * whether a `<meta>` lands in the head: "in head" until `</head>` (then
 * "after head", where head-only elements still go to the head) or until
 * body content: another start tag, a body-starting end tag, or text that is
 * not whitespace. `<template>` contents are inert and skipped.
 */
class HeadTracker {
  mode: InsertionMode = "head";
  private templateDepth = 0;

  /** Whether the token is inert template content, which is never read. */
  inert(tag: Tag): boolean {
    if (tag.kind !== "text" && tag.name === "template") {
      if (tag.kind === "start") {
        this.templateDepth += 1;
        // The template element itself is head content where it opens.
        return this.templateDepth > 1;
      }
      if (this.templateDepth > 0) {
        this.templateDepth -= 1;
        return true;
      }
    }
    return this.templateDepth > 0;
  }

  /** Advances the insertion mode for one token; returns whether a start tag lands in the head. */
  advance(tag: Tag, html: string): boolean {
    if (this.mode === "body") return false;
    if (tag.kind === "text") {
      if (hasNonWhitespace(html, tag.start, tag.end)) this.mode = "body";
      return false;
    }
    if (tag.kind === "end") {
      if (tag.name === "head" && this.mode === "head") this.mode = "after-head";
      else if (BODY_STARTING_END_TAGS.has(tag.name)) this.mode = "body";
      return false;
    }
    const allowed = this.mode === "head" ? HEAD_ELEMENTS : AFTER_HEAD_ELEMENTS;
    if (!allowed.has(tag.name)) {
      this.mode = "body";
      return false;
    }
    return true;
  }
}

/**
 * Extracts Open Graph, X Card, and Schema.org JSON-LD image metadata from an
 * HTML document. `documentUrl` is the URL the document was served from
 * (after redirects); together with the first `<base href>` it fixes the base
 * URL reported for resolving relative values. Values are returned as
 * written, with character references decoded and ASCII whitespace trimmed.
 */
export function extractPageSocialMetadata(html: string, documentUrl: string | URL): PageSocialMetadata {
  return scanPageSocialMetadata(html, documentUrl).metadata;
}

/** `extractPageSocialMetadata`, also reporting whether the head ended. */
export function scanPageSocialMetadata(html: string, documentUrl: string | URL): PageScan {
  const documentBase = new URL(String(documentUrl));
  const openGraph = new OpenGraphReader();
  const twitter: TwitterFields = {};
  const issues: PageMetadataIssue[] = [];
  const outsideHead: string[] = [];
  const jsonLd: JsonLdCollector = { images: [], positions: new Map(), nodes: 0, truncated: false, scripts: 0, current: 0 };
  let baseHref: string | undefined;
  const head = new HeadTracker();

  for (const tag of tags(html)) {
    if (head.inert(tag)) continue;
    const inHead = head.advance(tag, html);
    if (tag.kind !== "start") continue;
    if (tag.name === "base" && baseHref === undefined && tag.attributes.has("href")) {
      baseHref = tag.attributes.get("href");
    } else if (tag.name === "script" && isJsonLdScript(tag.attributes)) {
      readJsonLdScript(tag.text ?? "", jsonLd, issues);
    } else if (tag.name === "meta" && tag.attributes.has("content")) {
      const content = asciiTrim(tag.attributes.get("content")!);
      for (const key of metaKeys(tag.attributes)) {
        if (!inHead) outsideHead.push(key);
        else if (isTagKey(TWITTER_PROPERTIES, key)) twitter[TWITTER_PROPERTIES[key]] ??= content;
        else openGraph.read(key, content);
      }
    }
  }

  if (openGraph.orphans.length > 0) {
    issues.unshift(Object.freeze({
      code: "orphan-property",
      message: `${openGraph.orphans.join(", ")} appeared before any og:image and ${openGraph.orphans.length === 1 ? "was" : "were"} ignored; Open Graph structured properties follow their root tag.`,
    }));
  }
  if (outsideHead.length > 0) {
    issues.unshift(Object.freeze({
      code: "meta-outside-head",
      message: `${outsideHead.length} social meta tag${outsideHead.length === 1 ? "" : "s"} (first: ${outsideHead[0]}) appeared after <head> ended and ${outsideHead.length === 1 ? "was" : "were"} ignored.`,
    }));
  }
  if (jsonLd.truncated) {
    issues.push(Object.freeze({
      code: "json-ld",
      message: `JSON-LD deeper than ${MAX_JSON_LD_DEPTH} levels or larger than ${MAX_JSON_LD_NODES} values was not fully read.`,
    }));
  }

  const base = baseHref === undefined ? documentBase : frozenBaseUrl(baseHref, documentBase);
  const metadata: PageSocialMetadata = Object.freeze({
    documentUrl: documentBase.href,
    baseUrl: base.href,
    ...(baseHref !== undefined ? { baseHref } : {}),
    openGraph: Object.freeze({
      ...(openGraph.title !== undefined ? { title: openGraph.title } : {}),
      ...(openGraph.description !== undefined ? { description: openGraph.description } : {}),
      images: Object.freeze(openGraph.images.map((image) => Object.freeze({ ...image }))),
    }),
    twitter: Object.freeze({ ...twitter }),
    jsonLd: Object.freeze({ scripts: jsonLd.scripts, images: Object.freeze([...jsonLd.images]) }),
    issues: Object.freeze(issues),
  });
  return { metadata, headEnded: head.mode !== "head" };
}

function readJsonLdScript(text: string, collector: JsonLdCollector, issues: PageMetadataIssue[]): void {
  const script = collector.scripts;
  collector.scripts += 1;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    issues.push(Object.freeze({ code: "json-ld", message: `JSON-LD script ${script} is not valid JSON: ${reason}` }));
    return;
  }
  collector.current = script;
  walkJsonLd(parsed, 0, false, collector);
}
