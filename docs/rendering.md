# Rendering

Define a plate once and render it to SVG, PNG, JPEG, or WebP, then serve it from a framework route, a build script, or Express.
## Framework-neutral renderer

Define the design once with `createNodeOg`. The component is Satori-compatible
JSX, not browser DOM, so containers with multiple children should use flex.

```tsx
// src/lib/og.tsx
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

export const og = createNodeOg<{ title: string; alt: string }>({
  alt: (copy) => copy.alt,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  headers: { "Cache-Control": "public, max-age=86400" },
  component: (copy) => (
    <div
      style={{
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        background: "#111",
        color: "#fff",
        fontFamily: "Inter",
        fontSize: 72,
        padding: 72,
      }}
    >
      {copy.title}
    </div>
  ),
});
```

The resulting plate supports rendering, a complete artifact, and Fetchable route forms:

```ts
const png: Uint8Array = await og.render(copy);
const svg: string = await og.renderSvg(copy);
const artifact = await og.artifact("/posts/hello", copy);
const response: Response = await og.response(copy);
const fetchable = og.fetchableFrom((request: Request) => ({
  title: new URL(request.url).pathname,
  alt: "Social card",
}));
```

`artifact` renders the bytes and matching descriptor metadata from the same copy.
Node responses own `Content-Type`, `Content-Length`, and `Content-Encoding`; pass
only unrelated headers such as `Cache-Control`; configuring one of the owned
headers throws at definition time. Set `etag: "sha256"` (or `etag: true`) on the
plate when responses and artifacts should carry a deterministic strong ETag
based on the final encoded bytes. While automatic ETags are on, a caller
`ETag` header is rejected too; with `etag` off, a caller `ETag` passes through.

Responses are buffered, not streamed: every response renders the whole image
first, then sends it with `Content-Length` and, when enabled, a strong `ETag`
computed from the final bytes. That is deliberate. Social cards are small
(typically 15 to 30 KB), so streaming would save almost nothing, and it would
give up the exact length and content hash that CDNs use for caching and that
`verifyImage`, `verify`, and `verify-url` rely on to prove the bytes match the
metadata.

Rendering is safe to call concurrently. Satori is a pure call, each render
builds its own Resvg instance, and the font loaders memoize one shared copy
of the font bytes, so a pool over `render` is the expected way to build many
cards at once.

### Other output formats

PNG suits a flat vector plate and is what `render` returns by default. A card
that composites a photograph is a different problem: the same 1200x630 card
measures roughly 60 KB flat, 253 KB with a photo in it, and about 35 KB as JPEG
at quality 80. Across a per-item card set that difference decides whether the
set is publishable at all.

Metaplate ships no image encoder. Declare one and the plate carries the format
end to end — `render` returns the encoded bytes, `response` and `handler` serve
the media type that follows from it, and the metadata points at the declared
`imagePath`:

```ts
import sharp from "sharp";

export const og = createNodeOg<Copy>({
  alt: (copy) => copy.alt,
  fonts,
  component,
  imagePath: "og-image.jpg",
  output: {
    format: "jpeg",
    encode: ({ pixels, width, height }) =>
      sharp(pixels, { raw: { width, height, channels: 4 } })
        .jpeg({ quality: 80 })
        .toBuffer(),
  },
});
```

The encoder receives row-major RGBA, `width * height * 4` long — the shape
`sharp`, `@jsquash/jpeg`, and `@jsquash/webp` all accept. `format` names the
bytes the encoder produces: `contentType` (and `og:image:type`) derive from
it, and every render verifies the encoded bytes' signature against it, so a
plate cannot report one format while emitting another. A JPEG encoder that
starts returning WebP bytes fails the render it was changed in, rather than
silently mislabelling the card on the site.

For a format Metaplate does not recognize, keep `contentType` and opt out of
the check explicitly:

```ts
output: {
  contentType: "image/avif",
  checkSignature: false,
  encode: ({ pixels, width, height }) => avifEncoder(pixels, width, height),
}
```

For a build script that writes files rather than serving them, `renderPixels`
hands back the same pixmap without going through an encoder at all:

```ts
const { pixels, width, height } = await og.renderPixels(copy);
```

Point `imagePath` at the extension actually written, so `socialImage` and
`socialImageMetadata` describe the real file. `metaplate verify` reads PNG,
JPEG, WebP, or structurally walked GIF files, so the build check follows the
card whichever format it takes.

### Fetch-based framework routes

`handler` returns a zero-argument Fetch API handler for fixed copy. This Astro
[static endpoint](https://docs.astro.build/en/guides/endpoints/#static-file-endpoints)
is typechecked as an `APIRoute`; Astro calls its `GET` export during the build:

```ts
// src/pages/og-image.png.ts
import type { APIRoute } from "astro";
import { og } from "../lib/og";

export const prerender = true;
export const GET = og.handler({
  title: "An Astro site",
  alt: "Astro card",
}) satisfies APIRoute;
```

For dynamic copy, `handlerFrom` forwards every framework argument to a sync or
async resolver. For example, a SvelteKit
[`+server` route](https://svelte.dev/docs/kit/routing#server) deployed with the
official [Node adapter](https://svelte.dev/docs/kit/adapter-node) can use its
typed params without a wrapper around every plate. SvelteKit 3 configures the
adapter through `sveltekit({ adapter: adapter() })` in `vite.config.js` and
resolves [`#lib`](https://svelte.dev/docs/kit/$lib) through the `imports`
field of `package.json` (`"#lib/*": "./src/lib/*"`):

```ts
import type { RequestHandler } from "./$types";
import { og } from "#lib/og.js";

export const GET: RequestHandler = og.handlerFrom(({ params }) => ({
  title: titleFor(params.slug),
  alt: `${params.slug} card`,
}));
```

Current React Router framework-mode
[resource routes](https://reactrouter.com/how-to/resource-routes) use
`loader(args)`, not a `GET` export. Return the same Web `Response` from a
resolver:

```ts
export const loader = og.handlerFrom(({ params }: Route.LoaderArgs) => ({
  title: titleFor(params.slug),
  alt: `${params.slug} card`,
}));
```

These routes require a Node-compatible deployment adapter because
`metaplate/node` loads Resvg's native Node binding. A framework implementing
Web `Response` does not by itself make its edge runtime compatible; on a
Deno-based edge such as Netlify Edge Functions, use
[`metaplate/edge`](edge.md#edge-runtimes-with-metaplateedge), which does not run on
Cloudflare Workers.

### Express and build scripts

Express can send the bytes returned by `render` — PNG by default, or whatever
`output` encodes. Convert the `Uint8Array` to a `Buffer`, set the plate's exact
media type with [`res.type`](https://expressjs.com/en/5x/api/#res.type), send it
with [`res.send`](https://expressjs.com/en/5x/api/#res.send), and preserve
Express error handling:

```ts
app.get("/og-image.png", async (_request, response, next) => {
  try {
    response.type(og.contentType);
    response.set("Cache-Control", "public, max-age=86400");
    response.send(Buffer.from(await og.render(copy)));
  } catch (error) {
    next(error);
  }
});
```

Static generators can write the same bytes into `public/` during a build:

```ts
import { writeFile } from "node:fs/promises";
import { og } from "./og.js";

await writeFile("public/og-image.jpg", await og.render(copy));
```

### Authoring without a JSX toolchain

A plain `.mjs` build script has no JSX transform, and adding one to render a
social card is rarely worth it. `component` accepts the element tree Satori
walks, so `createElement` is enough:

```js
// scripts/build-og.mjs
import { writeFile } from "node:fs/promises";
import { createElement as h } from "react";
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

const og = createNodeOg({
  alt: (copy) => copy.alt,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  component: (copy) =>
    h(
      "div",
      {
        style: {
          boxSizing: "border-box",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background: "#111",
          color: "#fff",
          fontFamily: "Inter",
          padding: 72,
        },
      },
      h("div", { style: { fontSize: 32 } }, copy.eyebrow),
      h("div", { style: { fontSize: 72 } }, copy.title),
    ),
});

const copy = {
  eyebrow: "Project guide",
  title: "Build-time social image",
  alt: "Project guide social card",
};

await writeFile("public/og-image.png", await og.render(copy));
```

Satori requires an explicit `display` on any element whose `children` is an
array, including a single-element array. Pass a lone text child as a string,
`h("div", style, "Roadmap")`, not `h("div", style, ["Roadmap"])`. The array
form fails with:

```
Expected <div> to have explicit "display: flex", "display: contents",
or "display: none" if it has more than one child node.
```

That message names the containing element and its child count, but the element
to fix is the leaf holding the array. Scripts that build children
programmatically should either spread the array into `createElement` or give
that element an explicit `display`.

The same tree can be written as plain `{ type, props }` objects without
importing React or relying on its types. That path is typed, not just
runtime-supported: `createSvgOg` and
`createNodeOg` declare `component` as returning a local `SatoriNode` element
tree rather than React's `ReactNode`, so a TypeScript consumer does not need
React types to author a plain-object plate. The Next adapter keeps React's own
types because Next itself is intrinsic to it.

### SVG-only rendering

Use `createSvgOg` from `metaplate/render` when the consumer only needs SVG. It
does not load or execute Resvg's native Node binding.

## Plate constraints

A plate is a Satori layout that rasterises to an image, not a DOM tree. Six
differences bite in practice:

- **Size a padded root as `border-box`.** Satori sizes boxes as
  `content-box`, so a root with `width: "100%"`, `height: "100%"`, and
  `padding` grows past the canvas by twice the padding. Content aligned to the
  bottom or right is then drawn partly or wholly off the image, and a one-line
  title can vanish, leaving a blank card that still has the right format and
  size. Set `boxSizing: "border-box"` on that root.
- **Inline SVG `<title>` renders as visible text.** Satori supports a subset of
  SVG and lays out an unsupported element's children as text, so a `<title>`
  inside an inlined logo prints the word across the mark. Leave it out: the
  accessible name for a social card is the `alt` the plate already derives, and
  an element inside a PNG is unreachable to assistive technology anyway.
- **React accessibility lint rules do not apply.** Rules such as Biome's
  `lint/a11y/noSvgWithoutTitle` or `jsx-a11y/*` are written for DOM SVG and will
  ask for exactly the `<title>` above. Suppress them in the plate file rather
  than satisfying them.
- **Layout rules are Satori's, not the browser's.** Elements with more than one
  child need an explicit `display`, as does any element whose `children` is an
  array; see
  [Authoring without a JSX toolchain](#authoring-without-a-jsx-toolchain).
- **A fragment is laid out as a box on Satori older than 0.38.2.** In the
  DOM, `<>…</>` adds nothing to layout. Satori 0.38.2 and newer flatten it the
  same way, but earlier releases inside the supported peer range give it a box
  of its own, positioned by the parent's flex rules like any other child. Absolutely positioned children of a fragment
  therefore resolve `left`/`top` against that box rather than against the
  nearest positioned ancestor. Inside a parent that centers its children, the
  fragment's box is zero-sized and sits at the parent's center, so a
  full-bleed background placed with `left: 0, top: 0` starts from the middle
  of the panel and is clipped to a quarter. Nothing errors. Unless every
  deployment pins Satori 0.38.2 or newer, render such children directly, as
  separate conditionals or a keyed array, rather than wrapped in a fragment:

  ```tsx
  // Clipped: the photo and its overlay anchor to the fragment's box.
  {photo ? (
    <>
      <img src={photo} style={{ position: "absolute", left: 0, top: 0 }} />
      <div style={{ position: "absolute", left: 0, top: 0, width: 160, height: "100%" }} />
    </>
  ) : null}

  // Anchored to the panel.
  {photo ? <img src={photo} style={{ position: "absolute", left: 0, top: 0 }} /> : null}
  {photo ? <div style={{ position: "absolute", left: 0, top: 0, width: 160, height: "100%" }} /> : null}
  ```
- **Resvg may not resize the raster behind the plate's back.** Dimension-changing
  `fitTo` values and `crop` are rejected because metadata, `plate.size`, raw
  pixels, and encoded output must agree. Define the intended `size` on the
  plate, or declare another size as a
  [variant](variants.md), instead.

## Render guards

The constraints above fail silently: a card with its title drawn off the
canvas, or with text no font covers, still has the right format and size, so
`verifyImage` and `metaplate verify` accept it. This project's own Netlify Edge
deployment served exactly such blank cards (see the CHANGELOG), and
missing-glyph boxes from absent CJK or other-script fonts are a common Satori
complaint ([vercel/satori#367](https://github.com/vercel/satori/issues/367)).
Render guards check each render and fail it, or report it, instead of
returning the broken card:

```ts
import { createNodeOg, RenderGuardError } from "metaplate/node";

export const og = createNodeOg<Copy>({
  alt: (copy) => copy.alt,
  fonts,
  component,
  guards: { missingGlyphs: "error", overflow: "error", blank: "error" },
});

try {
  await og.render(copy);
} catch (error) {
  if (error instanceof RenderGuardError) console.error(error.issues);
  throw error;
}
```

Each guard takes `"error"`, `"warn"`, or `"off"`:

| Guard | Reports | Renderers |
| --- | --- | --- |
| `missingGlyphs` | Text that no plate font covers and that nothing resolved to a font or image | `createSvgOg`, `createNodeOg`, `createEdgeOg` |
| `overflow` | An element holding text whose laid-out box reaches outside the canvas | `createSvgOg`, `createNodeOg`, `createEdgeOg` |
| `blank` | A rasterised image in which every pixel is the same color | `createNodeOg`, `createEdgeOg` |

`"error"` rejects the render (and so `render`, `renderPixels`, `artifact`,
`response`, the route handlers, and `metaplate render`, which then exits `1`)
with a `RenderGuardError`. Its `issues` lists every error-level problem the
render step found, each with `guard`, `message`, the `variant` and `size`
being rendered, and the guard's own details: `languageCode` and `segment`
for missing glyphs, `element`, `text`, and `box` for overflow, `color` for a
blank image. Its `name` is `"RenderGuardError"`; `instanceof` works when the
class is imported from the same entry as the plate factory, because each
entry is bundled separately.

`"warn"` returns the image and passes each issue to `guards.onWarning`. Without
`onWarning`, warnings go to `console.warn`, so a `"warn"` guard is never
silent; pass `onWarning` to route them to the application's logger or
metrics instead. Warnings are reported before an error is thrown, so a render
with both reports all of them.

### How each guard decides

- **`missingGlyphs`** wraps Satori's `loadAdditionalAsset`. Satori calls it
  for text that none of the plate's fonts covers, once per language code and
  segment in a render, with the code it detected (such as
  `ja-JP|zh-CN|zh-TW|zh-HK`, `emoji`, or `unknown`). The plate's `emoji`
  loader and any `satori.loadAdditionalAsset` of its own still run first;
  when the whole chain answers with no font and no image, Satori draws the
  text from fonts that lack it, as missing-glyph boxes or nothing, and the
  guard reports the segment and code. Graphemes listed in
  `satori.graphemeImages` are drawn as images and are not reported. A font
  that a loader returns is trusted: if it does not cover the segment either,
  Satori still draws missing glyphs, and the guard cannot see that. Emoji
  count, so an emoji with no image fails the guard; set the
  [`emoji`](emoji.md) option. Recent Satori releases (0.63.2 checked) also
  treat any character followed by U+FE0F as emoji, so a text symbol written
  with that selector (such as `©️`) needs an emoji image or the selector
  removed.
- **`overflow`** composes with Satori's `onNodeDetected`, which reports every
  laid-out element with its box in canvas pixels; a caller's own
  `satori.onNodeDetected` still receives every node. Only elements holding
  their own text are checked (a string or number child, or such children in
  an array), so decorative shapes and images may bleed off the edge on
  purpose. An element is reported when its box starts before the canvas or
  ends past it by more than half a pixel. The box is the element's, before
  any CSS `transform`, and includes its padding: a text element with padding
  reaching outside is reported even when the glyphs themselves are visible.
  Text deliberately set off the edge needs `"warn"` or `"off"`.
- **`blank`** reads the raw RGBA pixels after Resvg rasterises them and
  before any `output` encoder runs, stopping at the first pixel that differs
  from the first; fully transparent pixels count as one color whatever their
  RGB. It catches a solid-background card whose text never appeared. It does
  not catch a gradient or photograph whose text is missing; `overflow` and
  `missingGlyphs` cover those causes.

Both Satori hooks have the same contract across the supported peer range:
`loadAdditionalAsset(code, segment)` and `onNodeDetected` with
`{ left, top, width, height, type, props, textContent }` behave identically in
Satori 0.33.3, 0.38.2, 0.48.1, 0.55.5, and 0.63.2 (each probed with the same
layout). The guards report what the installed Satori lays out: the
content-box root above grows past the canvas from 0.48.1 in that probe, while
0.33.3 and 0.38.2 lay it out at the canvas size, so the same plate can pass
`overflow` on an older Satori and fail on a newer one.

### Why guards are off by default

Every guard defaults to `"off"`, and with every guard off the Satori options
are passed through exactly as before, so upgrading changes no output.
Turning them on by default would break renders that work today: a title
with an emoji and no `emoji` loader, a CJK name rendered with the boxes a site
has accepted, or a watermark deliberately set off the edge would start
failing, and a `"warn"` default would log on every request of a live route.
Fail loudly where a broken card would be published: set every guard to
`"error"` in the plate a build (`metaplate render`) or a test renders, and use
`"warn"` with `onWarning` on live routes that should keep serving while the
problem is reported.

`metaplate/next` cannot run guards: `next/og`'s `ImageResponse` exposes
neither Satori's callbacks nor the pixels, so `createNextOg` rejects a
`guards` option. Render through `createNodeOg` in a route handler when a Next
card must be guarded (see [Render guards in Next.js](nextjs.md#render-guards-in-nextjs)
for that route shape). `createSvgOg` has no pixels either, so it rejects
`blank`. For images that already exist, `metaplate verify --require-content`
runs the blank check on PNG files and URLs; see
[the verification guide](verification.md#require-visible-content).

[`examples/render-guards.ts`](../examples/render-guards.ts) is a type-checked
version of a strict build plate and a lenient live one.
