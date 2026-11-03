# Rendering

Define a plate once and render it to SVG, PNG, JPEG, or WebP, then serve it from a framework route, a build script, or Express.
## Framework-neutral renderer

Define the design once with `createNodeOg`. The component is Satori-compatible
JSX, not browser DOM, so containers with multiple children should use flex.
The examples load Inter from Fontsource: `npm install @fontsource/inter` (see
the [fonts guide](fonts.md)).

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
`socialImageMetadata` describe the real file. `metaplate verify` reads SVG,
PNG, JPEG, WebP, or structurally walked GIF files, so the build check follows
the card whichever format it takes.

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
  output format, guard levels, font bytes, the source text of `component` and the
  definition's other functions, and the `satori`, `emoji`, `languageFonts`,
  and `resvg` options. Different copy can never share an entry, and a changed design
  misses rather than serving the old card. Copy must be plain data (objects,
  arrays, strings, numbers, booleans, `Date`, `URL`, byte arrays); anything
  else rejects the request with a `TypeError` naming the field.
- **What the key cannot see.** A function's source text excludes what it
  imports or closes over, and images fetched during the render are not
  hashed. Set the plate's `revision` and change it when such a dependency
  changes (it needs no `version: "copy"`; with it, the bump also gives every
  card a new [URL version](metadata.md#versioned-image-urls)); deploying new code usually starts a fresh process anyway. For the
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

Static generators can write the same bytes into `public/` during a build, at
the extension of the plate's format (PNG for this plate). For many pages and
sizes, [`metaplate render`](render-cli.md) writes every file, verifies it, and
records a manifest:

```ts
import { writeFile } from "node:fs/promises";
import { og } from "./og.js";

await writeFile("public/og-image.png", await og.render(copy));
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

### Layout debug boxes

`renderSvg` takes an optional second argument. `{ debug: true }` turns on
Satori's `debug` option for that call only, outlining every element's layout
box in red and every line of text in blue, without changing the plate's own
`satori` options:

```ts
const outlined: string = await og.renderSvg(copy, { debug: true });
```

[`metaplate preview`](preview.md#satori-debug-boxes) shows the same view for
every page and size behind a switch.

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

A plate is a Satori layout that rasterises to an image, not a DOM tree. Five
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
Satori 0.38.2, 0.48.1, 0.55.5, and 0.63.2 (each probed with the same
layout). The guards report what the installed Satori lays out: the
content-box root above grows past the canvas from 0.48.1 in that probe, while
0.38.2 lays it out at the canvas size, so the same plate can pass
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

[`examples/api/render-guards.ts`](https://github.com/lnorton89/metaplate/blob/main/examples/api/render-guards.ts) is a type-checked
version of a strict build plate and a lenient live one.
