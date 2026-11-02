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

### Caching renders

A dynamic route renders on every request: a crawler fetching the same card
twice pays for Satori and Resvg twice, and a CDN that revalidates gets the
full bytes back each time. `plate.cached()` puts a render cache in front of
one size of a plate and answers conditional requests:

```ts
const cached = og.cached();

export const GET = cached.handlerFrom(({ params }) => ({
  title: titleFor(params.slug),
  alt: `${params.slug} card`,
}));
```

The cached view has the same route forms as the plate (`render`, `response`,
`handler`, `handlerFrom`, `fetchable`, `fetchableFrom`; `metaplate/edge`
omits `handler`, as its plates do), plus `entry(copy)` and `key(copy)`.

- **Keys.** Each entry is keyed by the SHA-256 of the plate size's
  `fingerprint()` and the copy, serialized with object keys sorted. The
  fingerprint covers the Metaplate version, the renderer, `revision`, size,
  output format, font bytes, the source text of `component` and the
  definition's other functions, and the `satori`, `emoji`, and `resvg`
  options. Different copy can never share an entry, and a changed design
  misses rather than serving the old card. Copy must be plain data (objects,
  arrays, strings, numbers, booleans, `Date`, `URL`, byte arrays); anything
  else rejects the request with a `TypeError` naming the field.
- **What the key cannot see.** A function's source text excludes what it
  imports or closes over, and images fetched during the render are not
  hashed. Set the plate's `revision` and change it when such a dependency
  changes; deploying new code usually starts a fresh process anyway. For the
  same reason, two plates made by one factory that differ only in a
  closed-over value (a theme, say) fingerprint alike; attaching both to one
  store throws on the first request rather than letting them serve each
  other's cards. Give each a distinct `revision`.
- **ETags and 304s.** Every cached response carries a strong `ETag`, the
  quoted SHA-256 of the bytes, whatever the plate's `etag` option. When the
  handler is given the request (the argument itself, as in a Next.js route
  handler or `fetch(request)`, or its `request` property, as in Astro,
  SvelteKit, and React Router), a matching `If-None-Match` is answered with
  `304 Not Modified` and no body for `GET` and `HEAD`, and `412` for other
  methods, as [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#name-if-none-match)
  requires. Matching uses the weak comparison, so `W/"…"` from a proxy that
  recompressed the image still matches, and `*` matches any card. A 304
  keeps the 200's headers, such as `Cache-Control` and `Vary`, and drops
  `Content-Type` and `Content-Length`.
- **Concurrent requests** for one uncached card share a single render.
- **Expiry.** Entries do not expire by default, because the key changes with
  every known input. `ttl` (seconds) bounds how long one is served, for
  example to pick up a changed remote image.
- **Stores.** The default store is `memoryRenderCache()`: an in-process LRU
  holding at most 32 MiB of encoded images and 1000 entries
  (`og.cached({ maxBytes, maxEntries })`). Pass one store to several sizes or
  plates to share the budget. Any object with `get(key)` and `set(key, entry)`,
  synchronous or asynchronous, works as a store, so a shared key-value
  service fits in a few lines. Here `kv` stands for any client that stores
  bytes with a little metadata:

  ```ts
  import type { RenderCacheStore } from "metaplate/node";

  const store: RenderCacheStore = {
    async get(key) {
      const found = await kv.get(key);
      return found && { bytes: found.value, ...found.metadata };
    },
    set: (key, { bytes, ...metadata }) => kv.put(key, bytes, metadata),
  };

  export const cached = og.cached({ store, ttl: 7 * 24 * 60 * 60 });
  ```

  An entry a store returns is used only if it is fresh, has the plate's
  content type, and its bytes still hash to its ETag; otherwise the card is
  rendered again. A store that throws is treated as a miss (or a skipped
  write) and reported to `onStoreError`, so an outage slows responses rather
  than failing them.

A cache in the process does not replace a CDN: keep a `Cache-Control` header
on the plate so the edge serves repeats without reaching the function, and let
`cached()` absorb the requests that do.

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
