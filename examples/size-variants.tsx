// One plate, two sizes: a 1200x630 landscape card and a 1080x1080 square,
// laid out separately from the same copy rather than cropped from one image.
import type { APIRoute } from "astro";
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNextOg } from "metaplate/next";
import { createNodeOg, type PlateContext } from "metaplate/node";

type Copy = { title: string; eyebrow: string; alt: string };

/** Row on landscape canvases, stacked column with larger type on square ones. */
function Card(copy: Copy, { size }: PlateContext<"square">) {
  const square = size.width === size.height;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: square ? "column" : "row",
        alignItems: square ? "flex-start" : "center",
        justifyContent: square ? "flex-end" : "space-between",
        gap: square ? 24 : 48,
        padding: square ? 96 : 72,
        background: "#111",
        color: "#fff",
        fontFamily: "Inter",
      }}
    >
      <span style={{ fontSize: square ? 36 : 28 }}>{copy.eyebrow}</span>
      <span style={{ fontSize: square ? 112 : 72, fontWeight: 700 }}>{copy.title}</span>
    </div>
  );
}

export const og = createNodeOg<Copy, "square">({
  alt: (copy) => copy.alt,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  imagePath: "og-image.png",
  // imagePath defaults to "og-image-square.png"; set it to override.
  variants: { square: { size: { width: 1080, height: 1080 } } },
  component: Card,
});

const copy: Copy = { title: "Roadmap", eyebrow: "What comes next", alt: "Project roadmap" };

/** og:image lists the landscape card first, then the square one. */
export const metadata = og.metadata("/roadmap", copy);
/** Same list, with the square card as twitter:image. */
export const squareXCard = og.metadata("/roadmap", copy, { twitter: { variant: "square" } });

// Astro: src/pages/og-image.png.ts and src/pages/og-image-square.png.ts
export const astroLandscape = og.handler(copy) satisfies APIRoute;
export const astroSquare = og.variant("square").handler(copy) satisfies APIRoute;

// React Router: route(":slug/og-image-square.png", "routes/og-square.ts")
export const reactRouterSquareLoader = og
  .variant("square")
  .handlerFrom(({ params }: { params: { slug?: string } }) => ({
    title: params.slug ?? "home",
    eyebrow: "Post",
    alt: `${params.slug ?? "home"} card`,
  }));

// SvelteKit: src/routes/[slug]/og-image-square.png/+server.ts
export const svelteKitSquare = og.variant("square").handlerFrom(
  ({ params }: { params: { slug: string } }) => ({
    title: params.slug,
    eyebrow: "Post",
    alt: `${params.slug} card`,
  }),
);

// Build script: one artifact per size, each with metadata for its own bytes.
export async function writeCards(write: (path: string, bytes: Uint8Array) => Promise<void>) {
  for (const view of [og, ...og.variants.map((name) => og.variant(name))]) {
    const artifact = await view.artifact("/roadmap", copy);
    const [image] = artifact.metadata.openGraph.images;
    if (image) await write(`public${image.url}`, artifact.bytes);
  }
}

// Next.js: app/roadmap/og-image/route.tsx and app/roadmap/og-image-square/route.tsx
const nextOg = createNextOg<Copy, "square">({
  alt: (copy) => copy.alt,
  variants: { square: { size: { width: 1080, height: 1080 } } },
  component: Card,
});
export const nextLandscapeGET = nextOg.handler(copy);
export const nextSquareGET = nextOg.variant("square").handler(copy);
export const nextSquareSize = nextOg.variant("square").size;
