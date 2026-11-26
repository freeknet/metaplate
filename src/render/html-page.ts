import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { socialMetaHtml, type SocialMetaInput } from "../metadata/meta-tags.js";
import type { SocialMetaOptions } from "../metadata/page-tags.js";
import { isAbsoluteUrl } from "../core/internal.js";
import { extractPageSocialMetadata, headEndTagOffset } from "../verify/html-metadata.js";

/**
 * Not an entry point: writes a render-module page's social `<meta>` tags into
 * the static HTML file it names, for `metaplate render`. See
 * docs/render-cli.md#writing-tags-into-static-html.
 */

/** The comment that opens the block `metaplate render` owns. */
export const SOCIAL_BLOCK_START = "<!-- metaplate:social -->";
/** The comment that closes it. */
export const SOCIAL_BLOCK_END = "<!-- /metaplate:social -->";

// Whitespace inside the comment is tolerated when reading; the block is
// always written back in the canonical form above.
const START = /<!--\s*metaplate:social\s*-->/g;
const END = /<!--\s*\/metaplate:social\s*-->/g;
const HEAD_END = /<\/head\s*>/i;
/** U+FEFF, the byte order mark. */
const BOM = String.fromCharCode(0xfeff);
const BLANK = /^[ \t]*$/;
const HTML_FILE = /\.html?$/i;

/** The `SocialMetaOptions` keys a page's `page` object may set. */
export const PAGE_META_KEYS = [
  "title",
  "description",
  "url",
  "siteName",
  "type",
  "locale",
  "alternateLocales",
  "article",
  "pubdate",
  "themeColor",
] as const;

/** The whitespace before `index` on its line, or `undefined` when other text precedes it. */
function lineIndent(html: string, index: number): string | undefined {
  const lineStart = html.lastIndexOf("\n", index - 1) + 1;
  const prefix = html.slice(lineStart, index);
  return BLANK.test(prefix) ? prefix : undefined;
}

/** The indentation of the last non-blank line that ends before `lineStart`. */
function previousLineIndent(html: string, lineStart: number): string | undefined {
  let end = lineStart - 1;
  while (end > 0) {
    const start = html.lastIndexOf("\n", end - 1) + 1;
    const line = html.slice(start, end).replace(/\r$/, "");
    if (!BLANK.test(line)) return /^[ \t]*/.exec(line)![0];
    end = start - 1;
  }
  return undefined;
}

function block(render: (indent: string) => string, indent: string, eol: string): string {
  const lines = render(indent).split("\n").join(eol);
  return `${SOCIAL_BLOCK_START}${eol}${lines}${eol}${indent}${SOCIAL_BLOCK_END}`;
}

function matches(html: string, pattern: RegExp): RegExpExecArray[] {
  return [...html.matchAll(pattern)];
}

/** Splits one leading byte order mark off `html`, which the HTML parser drops and the file keeps. */
function splitBom(html: string): [bom: string, text: string] {
  return html.startsWith(BOM) ? [BOM, html.slice(BOM.length)] : ["", html];
}

/**
 * Writes the social block into `html` and returns the new document.
 *
 * An existing `<!-- metaplate:social -->` ... `<!-- /metaplate:social -->`
 * block is replaced in place, keeping the start marker's indentation. Without
 * one, the block is inserted on its own lines just before the `</head>` that
 * ends the head as a parser reads it (never one inside a comment, a raw-text
 * element such as `<script>`, or `<template>`), indented like the line above
 * it. The document's line ending (CRLF when it has any) is used inside the
 * block, and a leading byte order mark is kept. The result depends only on
 * the document outside the block and on `render`, so writing it again yields
 * the same bytes.
 *
 * @throws When the markers are repeated, unpaired, or out of order, when the
 *   block sits after `</head>`, when there is no block and no `</head>`, or
 *   when there is no block and the head ends before its `</head>`.
 */
export function spliceSocialBlock(source: string, render: (indent: string) => string): string {
  const [bom, html] = splitBom(source);
  return bom + spliceText(html, render);
}

function spliceText(html: string, render: (indent: string) => string): string {
  const eol = html.includes("\r\n") ? "\r\n" : "\n";
  const starts = matches(html, START);
  const ends = matches(html, END);
  if (starts.length > 1 || ends.length > 1) {
    throw new Error(
      `the page has ${starts.length} ${SOCIAL_BLOCK_START} and ${ends.length} ${SOCIAL_BLOCK_END} markers; ` +
        "expected at most one block. Remove the extra markers",
    );
  }
  if (starts.length !== ends.length) {
    const [found, missing] = starts.length === 1
      ? [SOCIAL_BLOCK_START, SOCIAL_BLOCK_END]
      : [SOCIAL_BLOCK_END, SOCIAL_BLOCK_START];
    throw new Error(`the page has ${found} without ${missing}; add the missing marker or remove the other`);
  }
  // The `</head>` a parser acts on, not merely the first one in the text.
  const head = headEndTagOffset(html);
  if (starts.length === 1) {
    const start = starts[0]!;
    const end = ends[0]!;
    if (end.index < start.index) {
      throw new Error(`the page has ${SOCIAL_BLOCK_END} before ${SOCIAL_BLOCK_START}`);
    }
    if (head !== undefined && head < start.index) {
      throw new Error(`the page has its ${SOCIAL_BLOCK_START} block after </head>; move the markers into <head>`);
    }
    const indent = lineIndent(html, start.index) ?? "";
    return html.slice(0, start.index) + block(render, indent, eol) + html.slice(end.index + end[0].length);
  }
  if (head === undefined) {
    if (HEAD_END.test(html)) {
      throw new Error(
        `the page's <head> ends before a </head> a crawler would read (body text or a tag such as <div> ends it, ` +
          `and a </head> in a comment or <script> does not count); fix the head, or add the two marker comments ` +
          "where the tags belong",
      );
    }
    throw new Error(
      `the page has no </head> and no ${SOCIAL_BLOCK_START} block; add </head>, or the two marker comments ` +
        "where the tags belong",
    );
  }
  const closingIndent = lineIndent(html, head);
  if (closingIndent === undefined) {
    // `</head>` shares a line with other markup: give the block lines of its own.
    return `${html.slice(0, head)}${eol}${block(render, "", eol)}${eol}${html.slice(head)}`;
  }
  const lineStart = head - closingIndent.length;
  const above = previousLineIndent(html, lineStart);
  const indent = above !== undefined && above.length > closingIndent.length ? above : `${closingIndent}  `;
  return `${html.slice(0, lineStart)}${indent}${block(render, indent, eol)}${eol}${html.slice(lineStart)}`;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolves a page's `html` against the project root (the directory the
 * command runs in), refusing a path that leaves it or is not an HTML file.
 */
export function htmlTarget(root: string, file: string): { path: string; target: string } {
  const base = path.resolve(root);
  const target = path.resolve(base, file);
  if (target === base || !isInside(base, target)) {
    throw new Error(`html ${file} resolves outside the project directory ${base}`);
  }
  if (!HTML_FILE.test(target)) {
    throw new Error(`html ${file} must name an .html or .htm file`);
  }
  return { path: path.relative(base, target).split(path.sep).join("/"), target };
}

/**
 * Holds an HTML target to the project root: its directory's real path must
 * stay inside, and the target must be an existing regular file, never a
 * symbolic link.
 */
export async function assertSafeHtmlTarget(root: string, target: string): Promise<void> {
  const realRoot = await realpath(root);
  const directory = await realpath(path.dirname(target)).catch(() => undefined);
  if (directory === undefined) throw new Error("the file does not exist; metaplate render edits an existing page");
  if (!isInside(realRoot, directory)) {
    throw new Error("refusing to write it: its directory resolves outside the project directory");
  }
  const stat = await lstat(target).catch(() => undefined);
  if (stat === undefined) throw new Error("the file does not exist; metaplate render edits an existing page");
  if (stat.isSymbolicLink()) throw new Error("refusing to write it: it is a symbolic link");
  if (!stat.isFile()) throw new Error("it is not a file");
}

/** What one page's HTML write needs, gathered before any image renders. */
export type HtmlPageSource = {
  /** POSIX path relative to the project root. */
  path: string;
  /** Absolute path of the file. */
  target: string;
  route: string;
  /** The plate's metadata for the page, versioned as its images are. */
  metadata: SocialMetaInput;
  /** Page-level fields, emitted after the image tags. */
  page: SocialMetaOptions;
};

/** The image URLs `socialMetaHtml` emits as `og:image`, in order, after resolving against `page.url`. */
function emittedImageUrls(source: HtmlPageSource): string[] {
  const urls = (source.metadata.openGraph?.images ?? []).map((image) =>
    source.page.url === undefined || isAbsoluteUrl(image.url) ? image.url : new URL(image.url, source.page.url).href,
  );
  return [...new Set(urls)];
}

/**
 * Builds the page's new HTML from `html`, its current text, and proves it:
 * the tags come only from `socialMetaHtml` (which escapes every value), and
 * the result, read as a crawler reads `<head>`, must list exactly the block's
 * `og:image` URLs. That fails a block a crawler would not see (inside a
 * comment or `<script>`, or after the head has ended) and a hand-written
 * `og:image` left elsewhere in the page.
 */
export function buildHtmlPage(source: HtmlPageSource, text: string): string {
  // A parser drops one leading byte order mark, so the page is spliced and
  // scanned without it, and it is put back so the file keeps its bytes.
  const [bom, html] = splitBom(text);
  const images = source.metadata.openGraph?.images ?? [];
  const relative = images.find((image) => !isAbsoluteUrl(image.url));
  if (relative !== undefined && source.page.url === undefined) {
    throw new Error(
      `the page would get the relative image URL ${relative.url}, and crawlers need an absolute one; ` +
        "set page.url to the page's absolute URL, or give the plate an origin",
    );
  }
  const render = (indent: string) => socialMetaHtml(source.metadata, { ...source.page, indent });
  const next = spliceSocialBlock(html, render);
  const documentUrl = source.page.url ?? "https://metaplate.invalid/";
  const outside = extractPageSocialMetadata(spliceSocialBlock(html, () => ""), documentUrl);
  const stale = [
    ...outside.openGraph.images.map((image) => `og:image ${image.url}`),
    ...(outside.twitter.image === undefined ? [] : [`twitter:image ${outside.twitter.image}`]),
  ];
  if (stale.length > 0) {
    throw new Error(
      `the page has image tags outside the ${SOCIAL_BLOCK_START} block (${stale.join(", ")}); ` +
        "remove them, or crawlers may read a stale card",
    );
  }
  const expected = emittedImageUrls(source);
  const found = extractPageSocialMetadata(next, documentUrl).openGraph.images.map((image) => image.url);
  if (found.length !== expected.length || found.some((url, index) => url !== expected[index])) {
    throw new Error(
      `the page has its ${SOCIAL_BLOCK_START} block where a crawler would not read it (in a comment, a raw-text ` +
        "element such as <script>, or after <head> has ended)",
    );
  }
  return bom + next;
}

/**
 * Reads a page's HTML as UTF-8, refusing bytes that do not round-trip, so a
 * file in another encoding is never rewritten with replacement characters.
 * A leading byte order mark stays in `text`; `buildHtmlPage` keeps it.
 */
export async function readHtmlPage(target: string): Promise<{ bytes: Uint8Array; text: string }> {
  const bytes = await readFile(target);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error("the file is not valid UTF-8; metaplate render writes only UTF-8 pages");
  }
  return { bytes, text };
}
