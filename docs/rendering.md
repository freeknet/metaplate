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

## Images and assets

A plate can draw logos, photos, and per-page images such as avatars or
covers. Metaplate embeds each one as a `data:` URI before Satori runs, so
nothing is fetched during layout, and checks the bytes first, so a broken
image fails the render with a reason instead of leaving an empty box.

### Async components

`component` may be `async` in every adapter (`createSvgOg`, `createNodeOg`,
`createEdgeOg`, and `createNextOg`), so it can load what a page needs before
returning the element tree:

```tsx
import { fileImageLoader, remoteImageLoader } from "metaplate/assets";
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

const logo = fileImageLoader("public/logo.svg");
const avatars = remoteImageLoader({ origins: ["https://avatars.example.com"] });

export const og = createNodeOg<{ title: string; avatar: string }>({
  alt: (copy) => copy.title,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  component: async (copy) => {
    const [mark, avatar] = await Promise.all([logo(), avatars(copy.avatar)]);
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 48, fontFamily: "Inter" }}>
        <img src={avatar.src} width={160} height={160} style={{ borderRadius: 80 }} />
        <img src={mark.src} width={mark.width} height={mark.height} />
        {copy.title}
      </div>
    );
  },
});
```

A synchronous component works as before and is not awaited. The component
runs after the fonts load. A component that throws or rejects fails the
render with that error. Define loaders once, at module scope, like the font
loaders: each one reads or fetches on first use, shares the result with every
later render, and retries after a failure instead of caching it.

### Embedding bytes with `imageAsset`

`imageAsset(bytes, options?)` from `metaplate/image` turns image bytes into
what `<img>` needs. It takes an `ArrayBuffer` or any view, including a Node
`Buffer`, and needs no peers and no Node built-ins, so it works on every
runtime:

```ts
import { imageAsset } from "metaplate/image";

const logo = imageAsset(bytes);
// { src: "data:image/png;base64,…", width: 512, height: 128,
//   format: "png", contentType: "image/png", byteLength: 20480 }
```

`width` and `height` are the image's intrinsic size, which Satori uses when
`<img>` sets neither. Setting them explicitly is clearer, and
`width={logo.width}` keeps the aspect ratio. The format comes from the bytes,
not the file name or `Content-Type`. Raster formats are walked by the same
structural detector as `imageDimensions`, so a truncated download or an HTML
error page served with status 200 throws. That detector is strict: it also
rejects a JPEG with bytes after its end marker, which some cameras write.
Re-encode such a file before embedding it.

An SVG needs a size Satori can use: pixel `width` and `height` attributes, or
a `viewBox`. A logo exported with only `viewBox="0 0 48 24"` is 48x24, and a
lone pixel `width` or `height` is scaled by the `viewBox` aspect ratio,
matching Satori's own sizing. DOCTYPE and entity declarations are refused,
as in `imageDimensions`.

Sources larger than `maxBytes` (default 4 MiB) are refused before decoding.
Every embedded image grows the SVG Satori produces by a third more than its
size, and the SVG is rendered on every request, so resize large photos before
embedding them.

`imageAssetLoader(source, options?)` memoizes one asset in any runtime. The
source is bytes, a `Response`, or a function returning either. A
`Response` that is not `ok` rejects, and a failed load is retried on the next
render rather than cached.

### Supported formats

Satori's `<img>` embeds PNG, JPEG, GIF, WebP, and SVG, and rejects anything
else, AVIF included.
The raster card is then drawn by Resvg, which does not decode every format
Satori embeds. An image Resvg cannot decode is drawn as nothing, and the
card keeps its size and format, so nothing reports the loss. `imageAsset`
accepts only the formats every Metaplate renderer draws unless you opt in:

| Format | `metaplate/node` and `metaplate/edge` (Resvg 2.6) | `metaplate/next` (`next/og`) | `imageAsset` |
| --- | --- | --- | --- |
| PNG, JPEG, SVG | Drawn | Drawn | Accepted |
| GIF | First frame drawn | Not drawn | Only with `formats: [..., "gif"]` |
| WebP | Not drawn | Not drawn | Only with `formats: [..., "webp"]` |
| AVIF, HEIC, JPEG XL, TIFF, BMP, ICO | Rejected by Satori | Rejected by Satori | Rejected, with the format named |

This was observed with Satori 0.63.2, `@resvg/resvg-js` 2.6.2,
`@resvg/resvg-wasm` 2.6.2, and Next.js 16.4.3. The test suite renders each
format and fails if a renderer starts drawing GIF or WebP, so the defaults
can be revisited then. Opt into `"gif"` only for plates rendered with
`metaplate/node` or `metaplate/edge`. Opt into `"webp"` only for
`createSvgOg` output that a browser displays. Otherwise, convert to PNG or
JPEG. `formats` also restricts: `formats: ["png"]` refuses everything else.

### Project files with `metaplate/assets`

`metaplate/assets` holds the Node readers. It loads no renderer peers, so a
Next.js route, an Astro endpoint, or a build script can import it without
loading Satori or Resvg.

```ts
import { fileImageLoader, readImageAsset } from "metaplate/assets";

const logo = fileImageLoader("public/logo.svg"); // memoized: () => Promise<ImageAsset>
const photo = await readImageAsset(new URL("./cover.jpg", import.meta.url));
```

Relative paths resolve against `cwd` (default `process.cwd()`), and a
`file:` URL is read as is. The file's size is checked against `maxBytes`
before it is read. Format and size errors name the file. On a serverless
host, include the file in the function bundle, as for
[fonts](fonts.md).

This replaces the boilerplate in Next's
[`opengraph-image` docs](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/opengraph-image#using-nodejs-runtime-with-local-assets),
which reads a file, base64-encodes it, and hard-codes its media type.
Passing an `ArrayBuffer` as `src` also works at run time, but React's types
reject it ([satori#606](https://github.com/vercel/satori/issues/606)), and
it is not checked before Resvg sees it.

### Remote images with an origin allowlist

Given an `http(s)` URL as `<img src>`, Satori fetches it during layout,
with no origin allowlist, byte cap, or timeout of your choosing. A URL from
request data therefore lets the image route reach whatever the server can
reach, which the [support matrix](support.md) warns against.
`remoteImageLoader` fetches instead, under an explicit policy:

```ts
import { remoteImageLoader } from "metaplate/assets";

const avatars = remoteImageLoader({
  origins: ["https://avatars.example.com", "https://cdn.example.com"],
});

const avatar = await avatars(`https://avatars.example.com/u/${user.id}.png`);
```

- **Only allowlisted origins.** `origins` is required, and entries are bare
  origins: a path, query, or credentials in an entry throws rather than
  being ignored. Every request and every redirect must stay on one of them;
  a URL or redirect elsewhere rejects with `RemoteImageError` code
  `"origin"` before any connection is made.
- **The `verify-url` fetcher.** Requests go through the same hardened fetcher
  as `fetchRemoteImage`. It fetches only `http:` and `https:` on default
  ports (others need `allowedPorts`). It refuses URLs with credentials,
  checks every resolved address and dials the checked one, so DNS rebinding
  cannot move a request. Loopback, private, link-local, and other non-public
  addresses are refused unless `allowPrivate` is set for local development.
  Each redirect (at most `maxRedirects`, default 3) is checked again. It
  sends a fixed identity with no cookies or credentials, and enforces
  `timeoutMs` and `connectionTimeoutMs` (10 s each by default).
- **A byte cap.** `maxBytes` (default 4 MiB) caps the body while it streams
  and is passed to `imageAsset`. The bytes must pass `imageAsset` and its
  `formats`, and errors name the URL.
- **A bounded cache.** Each loader memoizes up to `cacheSize` images by URL
  (default 64), evicting the oldest first, as the emoji loader does, and
  shares one request between concurrent renders. `cacheSize: 0` turns the
  cache off. Failures are never cached. Cached entries do not expire, so
  give a changed image a new URL (`/u/42.png?v=3`), or create a new loader
  to start empty.

### Edge runtimes

`metaplate/assets` needs Node. On an edge runtime, serve the image as a
static file of the same site and fetch it from your own origin, the pattern
the [edge guide](edge.md#edge-runtimes-with-metaplateedge) uses for fonts and
Wasm:

```ts
import { createEdgeOg } from "metaplate/edge";
import { imageAssetLoader } from "metaplate/image";

let origin = "";
const logo = imageAssetLoader(() => fetch(new URL("/images/logo.png", origin)));

const og = createEdgeOg({
  // fonts, resvg, and layout as in the edge guide
  component: async (copy: { title: string }) => {
    const { src, width, height } = await logo();
    return {
      type: "div",
      props: {
        style: { display: "flex", alignItems: "center", gap: 32 },
        children: [{ type: "img", props: { src, width, height } }, copy.title],
      },
    };
  },
});

const route = og.fetchableFrom((request: Request) => {
  origin ||= new URL(request.url).origin;
  return { title: new URL(request.url).pathname.slice(1, 81) };
});
```

The fetch goes to the deployment's own origin, never to a URL from request
data. To show per-page images from another host on the edge, fetch them from
that host with the runtime's `fetch` under your own allowlist, or render the
cards at build time with `metaplate/node`.

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
