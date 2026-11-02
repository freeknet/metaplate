# Square and landscape variants

One plate that renders several sizes, each laid out by the component.

One plate can render several sizes of the same card, such as the 1200x630
landscape image Open Graph readers expect and a 1080x1080 square. Each size is
laid out by the component, not cropped or scaled from another render: every
render passes a second argument, `{ variant, size }`, so the layout can reflow
for the canvas it is drawn on. `variant` is `undefined` for the default size.

```tsx
import { createNodeOg, type PlateContext } from "metaplate/node";

function Card(copy: Copy, { size }: PlateContext<"square">) {
  const square = size.width === size.height;
  return (
    <div
      style={{
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: square ? "column" : "row",
        justifyContent: square ? "flex-end" : "space-between",
        padding: square ? 96 : 72,
        background: "#111",
        color: "#fff",
        fontFamily: "Inter",
      }}
    >
      <span style={{ fontSize: square ? 36 : 28 }}>{copy.eyebrow}</span>
      <span style={{ fontSize: square ? 112 : 72 }}>{copy.title}</span>
    </div>
  );
}

export const og = createNodeOg<Copy, "square">({
  alt: (copy) => copy.alt,
  fonts,
  imagePath: "og-image.png",
  variants: {
    square: { size: { width: 1080, height: 1080 } },
  },
  component: Card,
});
```

Existing one-argument components keep working; they ignore the context.
Variant names are lowercase kebab-case (`square`, `story-tall`). Without
explicit type arguments the names are inferred from `variants`; with an
explicit `Copy`, pass them as the second type argument as above, or they are
checked only at runtime.

`og.variant("square")` is the same plate bound to that size. It has the whole
plate surface (`size`, `render`, `renderSvg`, `renderPixels`, `response`,
`handler`, `handlerFrom`, `fetchable`, `fetchableFrom`, `artifact`, `image`,
`metadata`, `sitePath`, `contentType`) and renders, encodes with the plate's `output`
encoder if one is set, and serves only the square size. `og.variants` lists the
declared names in order, and `variantName` tells a view which size it is.

Each variant's `imagePath` defaults to the plate's `imagePath` with `-<name>`
inserted before the extension: `og-image.png` becomes `og-image-square.png`,
and the extension-free `og-image` becomes `og-image-square`.
`variantImagePath(imagePath, name)` from `metaplate` applies the same rule.
Set `imagePath` on a variant to choose another path, and `alt` to describe it
differently. Paths that collide with another size are rejected at definition.

The default plate's metadata lists every size, default first:

```ts
og.metadata("/roadmap", copy);
// openGraph.images:
//   { url: "/roadmap/og-image.png",        width: 1200, height: 630,  alt, type: "image/png" }
//   { url: "/roadmap/og-image-square.png", width: 1080, height: 1080, alt, type: "image/png" }
// twitter.images:
//   { url: "/roadmap/og-image.png",        width: 1200, height: 630,  alt, type: "image/png" }

og.metadata("/roadmap", copy, { twitter: { variant: "square" } });
// twitter.images: the square card instead
```

`socialImageMetadata` accepts the same shape for images rendered elsewhere:
`variants: { square: { size, imagePath?, alt?, type? } }`, plus
`twitter: { variant: "square" }`. An explicit `openGraph.images` still
replaces the generated list. A variant view's `image` and `metadata`, and
every `artifact().metadata`, describe only that view's own size, so an
artifact's metadata always describes exactly its bytes.

Serve each size from its own route, one per URL in the metadata:

| Framework | Default | Square |
| --- | --- | --- |
| Next.js | `app/roadmap/og-image/route.tsx`: `export const GET = og.handler(copy)` | `app/roadmap/og-image-square/route.tsx`: `export const GET = og.variant("square").handler(copy)` |
| React Router | `route(":slug/og-image.png", "routes/og.ts")` | `route(":slug/og-image-square.png", "routes/og-square.ts")` exporting `loader = og.variant("square").handlerFrom(...)` |
| Astro | `src/pages/og-image.png.ts`: `export const GET = og.handler(copy)` | `src/pages/og-image-square.png.ts`: `export const GET = og.variant("square").handler(copy)` |
| SvelteKit | `src/routes/[slug]/og-image.png/+server.ts` | `src/routes/[slug]/og-image-square.png/+server.ts` with `og.variant("square").handlerFrom(...)` |

`createEdgeOg` from `metaplate/edge` also takes the same `variants` and
returns the same views, rendered through `@resvg/resvg-wasm`, minus the
copy-bound `handler`: serve each size through its view's `fetchable`,
`fetchableFrom`, or `handlerFrom`, as in
[Edge runtimes with `metaplate/edge`](edge.md#edge-runtimes-with-metaplateedge).

`createNextOg` takes the same `variants` and returns the same views, so the
Next route form above works with the `next/og` renderer too. For Next's
`opengraph-image` convention, write one metadata file per size and re-export
the view's `size` and `contentType`; Metaplate does not wrap
`generateImageMetadata`. A build script writes one file per view, or
[`metaplate render`](render-cli.md) writes every view of every page for you:

```ts
for (const view of [og, ...og.variants.map((name) => og.variant(name))]) {
  const { bytes, metadata } = await view.artifact("/roadmap", copy);
  await writeFile(`public${metadata.openGraph.images[0]!.url}`, bytes);
}
```

The single-size rule holds per view: a view's `size` is the canvas Satori lays
out, the dimensions Resvg must return, the pixels the encoder receives, and the
width and height its metadata advertises. Dimension-changing Resvg options are
checked against every declared size, so a `fitTo` that preserves the landscape
width but would rescale the square is rejected at definition.
[`examples/size-variants.tsx`](../examples/size-variants.tsx) type-checks the
whole pattern against the sources.
