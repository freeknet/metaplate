import type { Metadata, Viewport } from "next";
import { socialImageMetadata, socialMetaHtml, type SocialMetaOptions } from "metaplate";
import { nextPageMetadata, nextPageViewport } from "metaplate/next";

const social = socialImageMetadata("/blog/launch", "Launch card", {
  origin: "https://example.com",
  type: "image/png",
});

/**
 * Page-level fields for an article. `article` makes `og:type` default to
 * `article`; `pubdate` feeds Discord's embed timestamp and `themeColor` its
 * accent color.
 */
const page = {
  title: "Launch notes",
  description: "What shipped this week.",
  url: "https://example.com/blog/launch",
  siteName: "Example",
  locale: "en_US",
  alternateLocales: ["fr_FR"],
  article: {
    publishedTime: new Date("2026-11-01T09:30:00Z"),
    modifiedTime: "2026-11-02T08:00:00-05:00",
    authors: ["https://example.com/authors/ada"],
    section: "Releases",
    tags: ["metaplate", "open-graph"],
  },
  pubdate: "2026-11-01T09:30:00Z",
  themeColor: "#0b7285",
} satisfies SocialMetaOptions;

/** A plain HTML `<head>`: every tag, escaped, in the documented order. */
export const head = socialMetaHtml(social, { ...page, indent: "    " });

/**
 * Next.js: Open Graph fields under Next's own names, combined with the images
 * in one `openGraph` object because Next shallow-merges it. `og:pubdate` has
 * no Next field and travels through `other`.
 */
const pageMetadata = nextPageMetadata(page);

export const metadata: Metadata = {
  title: page.title,
  description: page.description,
  ...pageMetadata,
  openGraph: { ...pageMetadata.openGraph, images: social.openGraph.images },
  twitter: social.twitter,
};

/** Next.js reads `theme-color` from the `viewport` export, not `metadata`. */
export const viewport: Viewport = nextPageViewport(page);
