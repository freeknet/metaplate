// A render module for `metaplate render`: run `npx metaplate render og.render.ts`
// and every page below is written into public/ at both sizes, verified on
// disk, and listed in public/metaplate-manifest.json.
//
// It loads without a build step wherever Node strips TypeScript types (22.18+
// and 23.6+ by default), because it uses only erasable syntax: `import type`,
// annotations, and `satisfies`. The plate is plain `{ type, props }` objects,
// since Node does not transform JSX.
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg, type RenderJob, type RenderModule } from "metaplate/node";

type Copy = { title: string; section: string };

export const og = createNodeOg<Copy, "square">({
  alt: (copy) => `${copy.section}: ${copy.title}`,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  imagePath: "og-image.png",
  // Metadata URLs carry basePath and origin; the files land under public/
  // without them, which is where a project site serves /docs/ from.
  basePath: "/docs",
  origin: "https://example.github.io",
  variants: { square: { size: { width: 1080, height: 1080 } } },
  component: (copy, { size }) => ({
    type: "div",
    props: {
      style: {
        // Padding inside a full-size root needs border-box, or the card
        // overflows and is clipped.
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: size.width === size.height ? "column" : "row",
        justifyContent: "space-between",
        padding: 72,
        background: "#111",
        color: "#fff",
        fontFamily: "Inter",
      },
      children: [
        { type: "span", props: { style: { fontSize: 32 }, children: copy.section } },
        { type: "span", props: { style: { fontSize: 72 }, children: copy.title } },
      ],
    },
  }),
});

const posts = [
  { slug: "hello-world", title: "Hello, world" },
  { slug: "static-cards", title: "Static social cards" },
];

// public/og-image.png, public/og-image-square.png,
// public/posts/hello-world/og-image.png, public/posts/hello-world/og-image-square.png, ...
const site = {
  plate: og,
  pages: [
    { copy: { title: "Project guide", section: "Home" } },
    ...posts.map((post) => ({ route: `/posts/${post.slug}`, copy: { title: post.title, section: "Blog" } })),
  ],
} satisfies RenderJob<Copy>;

// A variant view renders only its own size: here, one extra square for /about.
const about = {
  plate: og.variant("square"),
  pages: [{ route: "/about", copy: { title: "About", section: "Project" } }],
} satisfies RenderJob<Copy>;

// The default export may also be a single job or an async function, for
// pages read from a CMS or the file system at build time.
export default [site, about] satisfies RenderModule;
