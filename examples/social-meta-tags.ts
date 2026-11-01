import type { Metadata } from "next";
import type { MetaFunction } from "react-router";
import { socialImageMetadata, socialMetaHtml, socialMetaTags } from "metaplate";

const page = {
  title: `Release notes: "metaplate" & friends`,
  description: "What changed in the latest release.",
  url: "https://example.com/blog/release-notes",
  siteName: "Example",
};

// Relative image URLs resolve against `url`, so crawler-ready tags do not need
// a separate `origin` here.
const social = socialImageMetadata("/blog/release-notes", "Release notes card", {
  type: "image/png",
});

/**
 * A plain HTML template. `socialMetaHtml` emits only escaped `<meta>`
 * elements; `<title>` and the canonical `<link>` stay with the page, which
 * escapes its own text.
 */
export function renderHead(escapeText: (value: string) => string): string {
  return [
    "<head>",
    `  <title>${escapeText(page.title)}</title>`,
    `  <link rel="canonical" href="${escapeText(page.url)}">`,
    socialMetaHtml(social, { ...page, indent: "  " }),
    "</head>",
  ].join("\n");
}

/**
 * Next.js `generateMetadata` through `other`. Next renders every `other` entry
 * as `<meta name=...>` and groups repeated keys, so this is faithful for one
 * Open Graph image. With several images, or to let Next merge with layout
 * metadata, pass `social.openGraph` and `social.twitter` to Next's own fields.
 */
export async function generateMetadata(): Promise<Metadata> {
  const other: Record<string, string[]> = {};
  for (const tag of socialMetaTags(social, page)) {
    const key = tag.property !== undefined ? tag.property : tag.name;
    (other[key] ??= []).push(tag.content);
  }
  return { title: page.title, other };
}

/** React Router `meta` accepts the tag objects unchanged. */
export const meta: MetaFunction = () => [
  { title: page.title },
  ...socialMetaTags(social, page),
];
