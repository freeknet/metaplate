// Cache-busting image URLs: crawlers cache an image by its URL, so a card
// whose pixels change needs a new URL. Metaplate appends `?v=<token>` to the
// image URLs it publishes in metadata and never to the file path.
import { socialImageMetadata, socialImageVersion, socialMetaHtml } from "metaplate";
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg, type RenderJob } from "metaplate/node";

type Copy = { title: string; section: string };

// Without a renderer: version a pre-rendered image by its copy, or by any
// token you already have, such as a content hash or a release number.
const copy: Copy = { title: "Launch notes", section: "Blog" };
export const social = socialImageMetadata("/blog/launch", "Launch notes card", {
  origin: "https://example.com",
  imagePath: "og-image.png",
  version: socialImageVersion(copy),
});
// og:image https://example.com/blog/launch/og-image.png?v=<8 hex digits>
export const head = socialMetaHtml(social, { url: "https://example.com/blog/launch" });

// A plate: `version: "copy"` derives each page's token from its copy, and
// `revision` re-versions every card when the design changes.
export const og = createNodeOg<Copy>({
  alt: (value) => `${value.section}: ${value.title}`,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  imagePath: "og-image.png",
  origin: "https://example.com",
  version: "copy",
  revision: "2026-11",
  component: (value) => ({
    type: "div",
    props: {
      style: { width: "100%", height: "100%", display: "flex", fontFamily: "Inter", fontSize: 72 },
      children: value.title,
    },
  }),
});

// https://example.com/blog/launch/og-image.png?v=<token>
export const metadata = og.metadata("/blog/launch", copy);
// "blog/launch/og-image.png": where the file lives, with no query.
export const file = og.sitePath("/blog/launch");
// A per-call token overrides the derived one.
export const pinned = og.metadata("/blog/launch", copy, { version: "release-12" });

// `metaplate render` writes the same unversioned path and records the
// versioned URL in the manifest; a page may name its own token.
export const job = {
  plate: og,
  pages: [
    { route: "/blog/launch", copy },
    { route: "/about", copy: { title: "About", section: "Project" }, version: "release-12" },
  ],
} satisfies RenderJob<Copy>;
