# Plate size variants

**Status:** implemented on `feat/variants` (targets the release after 0.8.0)
**Closes:** "Square/landscape plate variants" in
[0.7.0 deferred items](../research/0.7.0-deferred-items-status.md)

## Problem

A plate renders one size. Sites that want a 1200x630 landscape card for Open
Graph and a 1080x1080 square for consumers that prefer it had to define two
plates, duplicating `alt`, fonts, paths, encoder, and headers, and nothing tied
the two metadata entries together. Cropping the landscape render loses content
and scaling distorts or letterboxes it; a square card needs its own layout.

## Decision

A definition keeps its default `size` and may add named `variants`:

```ts
variants?: { [name: string]: { size: ImageSize; imagePath?: string; alt?: (copy) => string } }
component: (copy: Copy, context: { variant: string | undefined; size: ImageSize }) => Node
```

- **Reflow, not crop.** Every render calls `component(copy, context)` with the
  exact canvas size, so the author lays out each size. Single-argument
  components still type-check and ignore the context; the default size gets
  `variant: undefined`.
- **Views, not a size parameter.** `plate.variant(name)` returns the same plate
  bound to one variant, with the identical surface (`size`, `render`,
  `renderSvg`, `renderPixels`, `response`, `handler`, `handlerFrom`,
  `fetchable`, `fetchableFrom`, `artifact`, `image`, `metadata`,
  `contentType`). `plate.variants` lists names in declaration order;
  `variantName` says which view you hold. Every existing route recipe works
  unchanged by swapping `og` for `og.variant("square")`.
- **Names** are lowercase kebab-case starting with a letter: they become path
  suffixes, and integer-like keys would be reordered by JavaScript.
- **Type inference.** A second type parameter carries the variant names. With
  no explicit type arguments they are inferred from `variants`; with an
  explicit `Copy` they fall back to `string` (runtime-checked), or callers pass
  `createNodeOg<Copy, "square">`.

## Paths and metadata

- `imagePath` per variant defaults to `variantImagePath(imagePath, name)`:
  `-<name>` inserted before the last segment's extension (`og-image.png` →
  `og-image-square.png`, `og-image` → `og-image-square`). An explicit
  `imagePath` overrides it. Paths that collide with the default or each other
  are rejected at definition.
- `socialImageMetadata(route, alt, { variants })` and the default view's
  `plate.metadata(route, copy)` emit one `og:image` per size, default first,
  each with its own url, width, height, type, and alt. `twitter:image` stays
  the default unless `twitter.variant` (core) or `{ twitter: { variant } }`
  (plate) selects another. An explicit `openGraph.images` still replaces the
  generated list.
- A variant view's `image`/`metadata`, and every view's `artifact().metadata`,
  describe only that view's own size, so an artifact's metadata always
  describes exactly its bytes.
- With no variants declared, every metadata object is byte-for-byte what 0.8.0
  produced (pinned by a JSON fixture generated from 0.8.0's source).

## The size invariant

Each view still renders exactly one size: its `size` is the Satori canvas, the
Resvg output (checked after rasterising), the encoder input, and the metadata
width/height. Dimension-changing Resvg options remain rejected, now checked
against every declared size, since a `fitTo` width matching the default would
rescale a square.

## Adapters

- `createSvgOg` and `createNodeOg`: full variant views as above; the Node
  encoder (`output`) is shared, so every size is encoded and signature-checked
  identically.
- `createNextOg`: the same `variants`, `variant(name)`, and context argument.
  Next routes stay one file per URL: `app/<route>/og-image-square/route.tsx`
  exporting `og.variant("square").handler(copy)`, or an `opengraph-image`-style
  file re-exporting a view's `size`/`contentType`. `generateImageMetadata` is
  not wrapped: it would couple the adapter to Next's metadata-file argument
  contract, which no release-gate fixture exercises, for no capability the
  route form lacks.

## Rejected

- **Automatic crop or fit** from the landscape render: loses or distorts
  content and breaks the rule that layout is authored, not inferred.
- **Separate plates per size:** works today but duplicates configuration and
  cannot emit one ordered `og:image` list or detect path collisions.
- **CSS-only scaling** (one layout, transformed): text that fits 1200x630
  rarely composes well at 1:1; authors need the size to choose the layout.
- **A `size` argument on `render`:** would let callers render sizes metadata
  never advertises, the exact drift the size invariant exists to prevent.
