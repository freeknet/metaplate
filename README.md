# Metaplate

[![CI](https://github.com/lnorton89/metaplate/actions/workflows/ci.yml/badge.svg)](https://github.com/lnorton89/metaplate/actions/workflows/ci.yml)
[![CodeQL](https://github.com/lnorton89/metaplate/actions/workflows/codeql.yml/badge.svg)](https://github.com/lnorton89/metaplate/actions/workflows/codeql.yml)
[![npm](https://img.shields.io/npm/v/metaplate)](https://www.npmjs.com/package/metaplate)
[![Socket Badge](https://badge.socket.dev/npm/package/metaplate/0.7.0)](https://socket.dev/npm/package/metaplate/overview/0.7.0)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Composable, framework-neutral Open Graph image tooling for TypeScript.

Define your social images once. Render, serve, and publish them consistently across your TypeScript app.

Metaplate turns a single branded JSX plate into the complete Open Graph image pipeline. Use the same definition to render SVG or raster images, serve them from Node-compatible routes, generate matching Open Graph and X metadata, manage fonts, produce predictable image URLs, and verify the files you ship.

It works with plain Node, static build scripts, Next.js, and Node-compatible framework adapters, without tying your image design to a single framework.

## Contents

- [Install](#install)
  - [Dependency behavior](#dependency-behavior)
- [Framework-neutral renderer](#framework-neutral-renderer)
  - [Other output formats](#other-output-formats)
  - [Fetch-based framework routes](#fetch-based-framework-routes)
  - [Express and build scripts](#express-and-build-scripts)
  - [Runtime and dynamic-route safety](#runtime-and-dynamic-route-safety)
  - [Edge runtimes with `metaplate/edge`](#edge-runtimes-with-metaplateedge)
  - [Authoring without a JSX toolchain](#authoring-without-a-jsx-toolchain)
  - [SVG-only rendering](#svg-only-rendering)
- [Next.js adapter](#nextjs-adapter)
- [Square and landscape variants](#square-and-landscape-variants)
- [Metadata without a renderer](#metadata-without-a-renderer)
  - [Channel-specific images and X Cards](#channel-specific-images-and-x-cards)
  - [Social compatibility profiles](#social-compatibility-profiles)
  - [Emitting the meta tags yourself](#emitting-the-meta-tags-yourself)
  - [Next.js static export and `basePath`](#nextjs-static-export-and-basepath)
  - [JPEG or WebP cards in Next.js](#jpeg-or-webp-cards-in-nextjs)
- [Fonts](#fonts)
- [Plate constraints](#plate-constraints)
- [Static hosts](#static-hosts)
- [Deployment routes](#deployment-routes)
- [Verify generated files](#verify-generated-files)
  - [Verify a deployed URL](#verify-a-deployed-url)
- [Entry points](#entry-points)
- [Design lineage](#design-lineage)
- [License](#license)

## Install

One command installs Metaplate's complete framework-neutral renderer stack:

```sh
npm install metaplate
```

That installs compatible versions of `satori`, `@resvg/resvg-js`, and `react`
automatically. You do not need to discover or install renderer packages
separately. npm deduplicates these peer dependencies against compatible
versions already present in an application.

### Dependency behavior

`next` and `@resvg/resvg-wasm` are the optional peers: Next applications
already own their framework version, non-Next applications should not download
it, and only `metaplate/edge` needs the WebAssembly renderer. The
renderer peers are bounded to the release-tested major/minor lines instead of
silently accepting unknown breaking releases.

Dependencies load only when their entry point renders, so importing metadata
helpers does not initialize Satori or Resvg's native binding. Plain
`{ type, props }` authoring also remains independent of React APIs and React
types; the React runtime is included by the install so JSX works immediately.

`metaplate/next` no longer re-exports `ImageResponse`. Import it from `next/og`
directly if a plate needs it:

```ts
import { ImageResponse } from "next/og";
```

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
Web `Response` does not by itself make its edge runtime compatible; use
[`metaplate/edge`](#edge-runtimes-with-metaplateedge) there.

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

### Runtime and dynamic-route safety

The upstream links below define each framework's routing and deployment
contract; this guide documents the Metaplate-specific mapping and the narrower
set actually exercised by the release gate.

| Integration | Official framework reference | Supported runtime | Release evidence |
| --- | --- | --- | --- |
| `metaplate/next` | [Metadata and OG images](https://nextjs.org/docs/app/getting-started/metadata-and-og-images), [metadata files](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/opengraph-image), and [static exports](https://nextjs.org/docs/app/guides/static-exports) | Next.js 16.3.2–16.x Node/build pipeline | Exact packed artifact is built through a real Next static export in the release gate. Next 15 is not claimed because its remaining dependency advisories fail this project's release audit. |
| Astro static endpoints | [Static and server endpoints](https://docs.astro.build/en/guides/endpoints/) | Astro 7 build on Node 24 | Exact packed artifact produces the endpoint, PNG bytes, dimensions, and separately tested page metadata. |
| React Router resource routes | [Resource routes](https://reactrouter.com/how-to/resource-routes) | React Router 8 framework mode on Node 22.22+ | Exact packed artifact is type-generated, typechecked, built, served, and fetched through a dynamic `loader(args)` route. |
| SvelteKit `+server` routes | [`+server` routing](https://svelte.dev/docs/kit/routing#server) and [`adapter-node`](https://svelte.dev/docs/kit/adapter-node) | SvelteKit 3 with `adapter-node` 6 on Node 22.17+ | Exact packed artifact is synced, typechecked against the generated `RequestHandler`, built with `adapter-node`, served, and fetched through a dynamic `handlerFrom` `GET` route and a page emitting its social metadata. |
| Express | [Express 5 response API](https://expressjs.com/en/5x/api/#res.send) | Express 5 on Node | Exact packed artifact is served over an ephemeral HTTP server and checked for headers, bytes, and dimensions. |
| Bun and Deno (Node-compatible runtimes) | [Bun Node-API](https://bun.com/docs/runtime/node-api) and [Deno Node and npm compatibility](https://docs.deno.com/runtime/fundamentals/node/) | Evidence in progress: CI runtime matrix runs the built-package render smoke on Bun and Deno; not certified until it passes consistently | `scripts/verify-runtime.mjs` runs on Bun (latest 1.x) and Deno 2.x against the built `dist/` entries and an npm-installed `node_modules`, failing by step name: `metaplate` imports alone and produces metadata; `metaplate/render`, `metaplate/node`, `metaplate/fonts`, and `metaplate/image` import; Inter 700 loads through `fontsourceFontLoader`; Satori emits a 1200x630 SVG with glyph paths; native Resvg rasterizes it through `createNodeOg(...).artifact`; `handlerFrom` returns a Web `Response` with matching `Content-Type` and `Content-Length`; and `verifyImage` confirms a 1200x630 PNG identical to the artifact. It does not exercise a packed tarball, a framework adapter, or a hosted Bun or Deno deployment. |
| Workers and other edge isolates (Cloudflare Workers, Vercel Edge, Netlify Edge) | [Workers Fetch handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/) and [Wasm modules](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/); consult other runtimes' documentation | `metaplate/edge` renders PNG through `@resvg/resvg-wasm`; `metaplate/node` remains unsupported there | Tested in Node against the Wasm renderer and from the packed tarball; no hosted edge platform is certified. See [Edge runtimes with `metaplate/edge`](#edge-runtimes-with-metaplateedge). |

Public dynamic image routes are CPU- and memory-intensive. Bound copy length
and component complexity, use stable path params rather than arbitrary query
strings, set an explicit cache policy, and apply deployment-level concurrency
and timeout limits. Never pass a request-controlled remote image URL into a
Satori component: allowlist asset origins so server-side rendering cannot be
used to reach private or link-local services.

### Edge runtimes with `metaplate/edge`

`metaplate/edge` renders the same plates to PNG through
[`@resvg/resvg-wasm`](https://www.npmjs.com/package/@resvg/resvg-wasm), the
WebAssembly build of the Resvg release behind `@resvg/resvg-js`. It imports no
Node built-ins, so it can run where `metaplate/node` cannot: Cloudflare
Workers, Deno, and other Fetch-shaped runtimes. `@resvg/resvg-wasm` is an
optional peer that `npm install metaplate` does not add; install it for this
entry:

```sh
npm install @resvg/resvg-wasm
```

Edge runtimes cannot locate a package's `.wasm` file on their own, so the
caller supplies it. In a Cloudflare Worker, Wrangler
[bundles `.wasm` imports as `WebAssembly.Module` values](https://developers.cloudflare.com/workers/wrangler/bundling/)
([Wasm in JavaScript](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/)),
and `fetchableFrom` returns the `{ fetch }` object a Worker exports as its
[Fetch handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/):

```ts
// src/index.ts
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import layoutWasm from "satori/layout.wasm";
import { createEdgeOg } from "metaplate/edge";
import { fontLoader } from "metaplate/font-data";

const titles: Record<string, string> = { "/": "Home", "/guide": "Guide" };

const og = createEdgeOg({
  alt: (copy: { title: string }) => `${copy.title} social card`,
  resvg: { wasm: resvgWasm },
  layout: { wasm: layoutWasm },
  fonts: fontLoader([
    {
      name: "Inter",
      weight: 700,
      data: async () => {
        const response = await fetch("https://example.com/fonts/inter-700.woff");
        if (!response.ok) throw new Error(`Unable to load font: ${response.status}`);
        return response.arrayBuffer();
      },
    },
  ]),
  headers: { "Cache-Control": "public, max-age=86400" },
  component: (copy: { title: string }) => ({
    type: "div",
    props: {
      style: { width: "100%", height: "100%", display: "flex", fontFamily: "Inter", fontSize: 64 },
      children: copy.title,
    },
  }),
});

export default og.fetchableFrom((request: Request) => ({
  title: titles[new URL(request.url).pathname] ?? "Metaplate",
}));
```

`layout` supplies Satori's Yoga layout engine. Satori's default build compiles
an embedded copy from bytes at runtime, which Workers rejects because its
[`WebAssembly.instantiate()` only supports pre-compiled modules](https://developers.cloudflare.com/workers/runtime-apis/webassembly/);
with `layout`, Metaplate uses `satori/standalone` instead (the audited Satori
0.63.2 exports both `satori/standalone` and `satori/layout.wasm`). Runtimes
that allow compiling Wasm from bytes, such as Deno, can omit `layout`, and
can fetch the Resvg module instead of importing it:

```ts
const og = createEdgeOg({
  ...plate,
  resvg: {
    wasm: () => fetch(new URL("./vendor/resvg/index_bg.wasm", import.meta.url)),
  },
});
```

`resvg.wasm` and `layout.wasm` accept a `WebAssembly.Module`, bytes, a
`Response`, a `URL`, a promise of one, or a function returning one; a function
runs on the first render. Each Wasm module is a single instance per isolate,
so the first source supplied wins. To supply them once for every plate, call
`initEdgeRenderer(resvgWasm, { layout: layoutWasm })` at module scope instead.

The boundary is deliberately narrow:

- **PNG only.** `@resvg/resvg-wasm` has no JPEG or WebP encoder, so
  `metaplate/edge` rejects `output` encoders. `renderPixels` still returns raw
  RGBA for a Wasm encoder of your own.
- **The caller supplies the Wasm.** Nothing is fetched from `node_modules` or a
  CDN on your behalf.
- **Fonts arrive as bytes**, through `metaplate/font-data` loaders, never file
  paths; `resvg.font` is not available because Satori outlines text first.
- **Fetch-shaped API.** `fetchable`, `fetchableFrom`, `handlerFrom`,
  `response`, `render`, `renderPixels`, and `artifact` behave as in
  `metaplate/node`, with the same owned headers and ETags (computed with Web
  Crypto). The copy-bound `handler` is not provided.
- **Tested in Node against the Wasm renderer, not yet on a hosted edge
  platform.** The test suite renders through `@resvg/resvg-wasm` and
  `satori/standalone` in Node and checks dimensions, media type, headers, and
  ETags against `metaplate/node`, and the package gate renders from the packed
  tarball. No Workers or Deno Deploy deployment is certified yet.

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

## Next.js adapter

Next applications can use the native `next/og` pipeline while keeping the same
route and metadata pattern. Read this alongside Next's official
[Metadata and OG images](https://nextjs.org/docs/app/getting-started/metadata-and-og-images)
and
[`opengraph-image` file convention](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/opengraph-image):

```tsx
// src/lib/og.tsx
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNextOg } from "metaplate/next";

export type OgCopy = {
  eyebrow: string;
  title: string;
  description: string;
  alt: string;
};

export const og = createNextOg<OgCopy>({
  alt: (copy) => copy.alt,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  component: (copy) => (
    <div style={{ width: "100%", height: "100%", display: "flex" }}>
      {copy.title}
    </div>
  ),
});
```

Next [shallow-merges metadata](https://nextjs.org/docs/app/api-reference/functions/generate-metadata):
a page that sets `openGraph` **replaces** the root layout's rather than extending
it. Spreading `og.metadata()` straight into
a page therefore drops every other Open Graph field the layout contributed —
`siteName`, `type`, `locale`, `url` — from that page's tags. Nothing errors and
the build stays green; the loss shows only in the emitted HTML.

Write the composition once, next to the plate, and call it from each page:

```tsx
// src/lib/metadata.ts
import type { Metadata } from "next";
import { og, type OgCopy } from "./og";

/** Site-level fields the root layout spreads into its own `openGraph`. */
export const openGraph = {
  siteName: "Example",
  type: "website",
  locale: "en_US",
};

export function pageMetadata(route: string, copy: OgCopy): Metadata {
  const social = og.metadata(route, copy);

  return {
    title: copy.title,
    description: copy.description,
    openGraph: {
      ...openGraph,
      // `url` is per-route, so it cannot live in the shared constant, and the
      // layout's own `url` is replaced along with everything else.
      url: route,
      // Without this, Next fills `og:title` from the document title, including
      // any `title.template` suffix the layout defines.
      title: copy.title,
      description: copy.description,
      images: social.openGraph.images,
    },
    twitter: social.twitter,
  };
}
```

Keep the copy next to the page it describes:

```tsx
// src/app/roadmap/page.tsx
import { pageMetadata } from "@/lib/metadata";

export const copy = {
  eyebrow: "What comes next",
  title: "Roadmap",
  description: "A dependency-ordered view of the work ahead.",
  alt: "Project roadmap",
};

export const metadata = pageMetadata("/roadmap", copy);
```

One function rather than a spread per page is deliberate: the fields above have
to be restated on every route that sets `openGraph` at all, and a route that
forgets one loses it silently.

If the layout sets no Open Graph fields and neither does the page, spreading
the whole result stays correct:

```tsx
export const metadata = { title: copy.title, ...og.metadata("/roadmap", copy) };
```

Then expose the predictable route:

```tsx
// src/app/roadmap/og-image/route.tsx
import { og } from "@/lib/og";
import { copy } from "../page";

export const dynamic = "force-static";
export const GET = og.handler(copy);
```

For Next's `opengraph-image.tsx` convention, call `og.render(copy)` from the
default export and re-export `og.size` and `og.contentType` as its constants.
That convention assumes a root-deployed app; see
[Next.js static export and `basePath`](#nextjs-static-export-and-basepath)
before using it behind a deployment prefix.

Each view of a plate renders exactly one size. `plate.size` is both the
definition size and the size `render`/`renderSvg`/`response` use, so the bytes
Metaplate produces and the dimensions it advertises (`og:image:width`/`height`)
can never disagree. A plate that needs a second size declares it as a
[variant](#square-and-landscape-variants), whose view keeps the same rule. Size values must be integers between 1 and 65535; `socialImage`,
`socialImageMetadata`, and every plate definition reject anything else at the
boundary.

## Square and landscape variants

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
`metadata`, `contentType`) and renders, encodes with the plate's `output`
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
[Edge runtimes with `metaplate/edge`](#edge-runtimes-with-metaplateedge).

`createNextOg` takes the same `variants` and returns the same views, so the
Next route form above works with the `next/og` renderer too. For Next's
`opengraph-image` convention, write one metadata file per size and re-export
the view's `size` and `contentType`; Metaplate does not wrap
`generateImageMetadata`. A build script writes one file per view:

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
[`examples/size-variants.tsx`](examples/size-variants.tsx) type-checks the
whole pattern against the sources.

## Metadata without a renderer

The root `metaplate` entry has no framework dependency. It can describe a
hand-authored or pre-rendered image, like a conventional `public/og.png`:

```ts
import { socialImageMetadata } from "metaplate";

const metadata = socialImageMetadata("/", "Project home card", {
  imagePath: "og.png",
  size: { width: 1200, height: 630 },
});
```

Relative paths are the default because Next's Metadata API resolves them against
`metadataBase`. A framework-neutral consumer that writes tags directly can pass
an `origin` for crawler-ready absolute URLs; `basePath`, route, and `imagePath`
compose beneath it:

```ts
const metadata = socialImageMetadata("/docs", "Docs card", {
  origin: "https://example.com",
  basePath: "/project",
  imagePath: "og-image.jpg",
});
// https://example.com/project/docs/og-image.jpg
```

Metadata helpers accept `route`/`basePath`/`imagePath` as pathnames only:
query strings, fragments, and `.`/`..` segments are rejected rather than
silently producing a URL that normalizes somewhere else.

### Channel-specific images and X Cards

Metaplate configures two published webpage metadata channels, not one platform:

| Metaplate option | Emitted/returned channel | Typical consumers |
| --- | --- | --- |
| `openGraph` / `OpenGraphImageOptions` | `og:image` and its structured properties | Facebook, LinkedIn, Slack, Mastodon, Discord, and other Open Graph readers |
| `twitter` / `XImageOptions` | `twitter:card`, `twitter:image`, and identity fields | X Cards |

The public option remains named `twitter` because `twitter:*` is still the X
Card wire protocol and because frameworks such as Next.js expose the same
`twitter` metadata field. `XCard` and `XImageOptions` are the preferred
human-facing type names; `TwitterCard` and `TwitterImageOptions` remain exact
aliases for existing code and framework terminology. Platform-specific
delivery rules are selected separately with `SocialTarget` in
`socialImageCompatibility`.

The one-image call remains unchanged. When the extra images are other sizes
of the same card, declare them as
[`variants`](#square-and-landscape-variants) instead. When a landscape Open
Graph image, a square fallback, and an X-specific composition differ, override
only those channels. Open Graph ordering is preserved and the first descriptor remains
the preferred image:

```ts
const metadata = socialImageMetadata("/docs", "Docs card", {
  origin: "https://example.com",
  imagePath: "og-image.png",
  openGraph: { images: [landscape, square] },
  twitter: {
    card: "summary",
    image: xCard,
    site: "@example",
    creator: "@author",
  },
});
```

Supported X identity fields are `site`, `siteId`, `creator`, and `creatorId`.
Overrides are copied into independent descriptors, so mutating a source object
later cannot silently change or desynchronize the two channels. Metaplate does
not generate fictional `discord:*` or `instagram:*` tags; those consumers use
Open Graph or undocumented heuristics rather than a separate page schema.

### Social compatibility profiles

`socialImageCompatibility` checks local descriptor facts without making
network requests. The conservative `universal` profile requires an absolute
HTTPS URL and PNG/JPEG media type; named profiles add documented checks,
including LinkedIn's minimum dimensions, a 1.91:1 aspect-ratio warning, and
optional 5 MB limit:

```ts
import { socialImageCompatibility } from "metaplate";

const report = socialImageCompatibility(metadata.openGraph.images[0], {
  targets: ["universal", "facebook", "linkedin", "slack"],
  fileSize: generatedBytes.byteLength,
});

if (!report.compatible) throw new Error(JSON.stringify(report.issues));
```

Pass `checkUrl: false` or `checkAlt: false` to evaluate a descriptor that has
not been assigned a URL or alt text yet; the input type,
`SocialCompatibilityImage`, makes both fields optional.

Issues are `error`, `warning`, or `unknown`. Discord and Instagram checks are
reported as unknown because neither publishes a stable webpage image-tag
contract. SVG remains useful as renderer output, but it is not a universal
social delivery format; use PNG or JPEG for broad crawler compatibility.

This local report cannot prove public fetchability, redirects, response MIME,
robots/WAF behavior, or crawler caches. Those require checking the deployed
page and image; use Meta Sharing Debugger, LinkedIn Post Inspector, and the
relevant client debugger after deployment.

### Emitting the meta tags yourself

Frameworks with a metadata API should keep receiving the metadata object:
pass `openGraph` and `twitter` to Next's `metadata`, as `metaplate/next`
does, so Next can merge them with layout metadata. When a page writes its own
`<head>`, as React Router `meta`, Astro and SvelteKit templates, or a static
HTML build do, `socialMetaTags` turns the same metadata into the tags
themselves:

```ts
import { socialImageMetadata, socialMetaHtml, socialMetaTags } from "metaplate";

const social = socialImageMetadata("/blog/launch", "Launch card", { type: "image/png" });
const page = {
  title: "Launch notes",
  description: "What shipped this week.",
  url: "https://example.com/blog/launch",
  siteName: "Example",
};

// React Router: the objects are valid `meta` descriptors as-is.
export const meta = () => [{ title: page.title }, ...socialMetaTags(social, page)];

// Plain HTML: escaped `<meta>` elements, one per line.
const head = socialMetaHtml(social, { ...page, indent: "    " });
```

In an Astro or Svelte template, loop over the array and bind the attributes;
the framework escapes them:

```astro
{socialMetaTags(social, page).map((tag) => <meta {...tag} />)}
```

`socialMetaTags` returns `{ property, content }` for Open Graph tags and
`{ name, content }` for X Card tags, in this fixed order:

1. Each Open Graph image, in caller order: `og:image`, `og:image:width`,
   `og:image:height`, `og:image:type`, `og:image:alt`. Repeating the group is
   how Open Graph expresses several images; a group whose URL repeats an
   earlier one is dropped.
2. `twitter:card`, `twitter:image`, `twitter:image:alt`, `twitter:site`,
   `twitter:site:id`, `twitter:creator`, `twitter:creator:id`. X reads one
   image, so only the first X Card image is used.
3. Page-level fields from the options: `og:title`, `og:description`,
   `og:url`, `og:site_name`, `og:type`.

A tag whose value is undefined or empty is left out, so metadata alone never
gains page-level tags. `og:type` defaults to `website` only when `title` or
`url` is supplied. Dimensions are emitted as integer strings.

`url` is the canonical page URL and must be an absolute http(s) URL. When it
is supplied, relative image URLs are resolved against it with standard URL
resolution, as a crawler on that page would; absolute image URLs are never
rewritten. Without `url`, image URLs are emitted exactly as the metadata holds
them.

`socialMetaHtml` renders the same tags in the same order and guarantees that
its output contains only `<meta>` elements: each has exactly a `property` or
`name` attribute followed by `content`, the key must match a strict
`og:`/`twitter:` pattern, and the content is escaped for a double-quoted
attribute (`&`, `<`, `>`, `"`, and `'`, plus line breaks so each element stays
on one line). `indent` accepts only spaces and tabs. It does not emit
`<title>` or `<link rel="canonical">`; those belong to the page, which must
escape its own title text.

Next.js `generateMetadata` can carry the tags through `other`, as
[`examples/social-meta-tags.ts`](examples/social-meta-tags.ts) shows, but Next
renders every `other` entry with a `name` attribute and groups repeated keys.
That is faithful for a single Open Graph image only; with several images, use
Next's `openGraph` and `twitter` fields.

### Next.js static export and `basePath`

Next's special `app/opengraph-image.tsx` file suits a root-deployed app: set
`dynamic = "force-static"` and Next prerenders the `ImageResponse` during
`next build` with [`output: "export"`](https://nextjs.org/docs/app/guides/static-exports)
enabled.

Under a deployment `basePath`, that file still prerenders and the build still
reports success, but the card is unusable for two independent reasons:

- **The emitted file has no extension.** `out/opengraph-image` holds PNG bytes
  with nothing to tell a static host so. The
  [Static hosts](#static-hosts) section fixes that for route handlers with
  per-path headers, which GitHub Pages project sites cannot set at all.
- **The emitted metadata drops the prefix.** Next resolves special-file
  metadata against `metadataBase` without applying `basePath`, so the tag reads
  `https://example.github.io/opengraph-image` and 404s on a project site. The
  build stays green, so this surfaces only once a crawler follows the link.

Under `basePath`, render the card into `public/` during the build instead, as
in [Authoring without a JSX toolchain](#authoring-without-a-jsx-toolchain), and
describe the result with the framework-neutral metadata helper:

```ts
// app/layout.tsx
import type { Metadata } from "next";
import { socialImageMetadata } from "metaplate";

const social = socialImageMetadata("/", "Project home card", {
  basePath: "/project",
  imagePath: "og-image.png",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://example.github.io"),
  openGraph: social.openGraph,
  twitter: social.twitter,
};
```

This emits `/project/og-image.png`, which Next resolves against
`metadataBase` into
`https://example.github.io/project/og-image.png`. Verify both
`public/og-image.png` and the copied `out/og-image.png`, and inspect the
exported HTML to confirm its social tags carry the deployment prefix.

### JPEG or WebP cards in Next.js

`metaplate/next` renders through `next/og`, which always produces PNG. A card
that composites a photograph is usually several times smaller as JPEG (see
[Other output formats](#other-output-formats)), and that needs the Node
renderer's `output` encoder. `createNodeOg` works inside a Next route handler
with one piece of configuration.

Next 16 builds with Turbopack, which cannot bundle the two renderer peers:
Resvg ships a native `.node` binary, and Satori locates its HarfBuzz `.wasm`
relative to its own file. Next's
[built-in external list](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages)
covers `sharp` but not these, so without configuration the build fails with:

```
./node_modules/@resvg/resvg-js/js-binding.js
Error: non-ecmascript placeable asset
```

and, once Resvg is external, every render aborts with:

```
Error: ENOENT: no such file or directory, open '…/node_modules/harfbuzzjs/hb.wasm'
```

List both in
[`serverExternalPackages`](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages)
so Next requires them from `node_modules` instead of bundling them:

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@resvg/resvg-js", "satori"],
};

export default nextConfig;
```

This applies to any module graph that reaches `metaplate/node`, including a
page that imports the plate only to call `og.metadata()`: the renderer loads
lazily at runtime, but the bundler still traces the import.

Name the route folder after the file the plate writes. With
`imagePath: "og-image.jpg"`, the handler lives at
`app/<route>/og-image.jpg/route.ts`, so a static export emits a real
`og-image.jpg` and static hosts serve it as `image/jpeg` without the
per-path header rules in [Static hosts](#static-hosts):

```ts
// app/roadmap/og-image.jpg/route.ts
import { og } from "@/lib/og";
import { copy } from "../page";

export const dynamic = "force-static";
export const GET = og.handler(copy);
```

## Fonts

[Satori](https://github.com/vercel/satori#fonts) needs the actual bytes of every
rendered face and accepts TTF, OTF, and WOFF, but not WOFF2. This is separate
from a framework's CSS font setup:
[`next/font`](https://nextjs.org/docs/app/getting-started/fonts), for example,
self-hosts and exposes class names but does not expose its transformed font
bytes to `ImageResponse`. Reuse the same source file or npm package for the
plate; do not attempt to extract it from the framework's generated CSS.

Choose the loader that matches where the project already owns the font:

| Existing source | Loader | What you specify |
| --- | --- | --- |
| Fontsource npm package | `fontsourceFontLoader` | Font id plus optional weight/style/subset |
| Local project file | `fileFontLoader` | Relative/absolute path or co-located `file:` URL |
| Existing bytes or framework fetch/import | `fontLoader` | Bytes or a lazy byte callback |
| Any other npm package | `packageFontLoader` | Package name and package-relative file |

All loaders memoize successful bytes across renders and retry after a failed
load. Fontsource is the shortest npm-managed path; it reads the installed
package's family and default subset from `metadata.json` and selects its WOFF
face, so no internal filename needs to be copied into application code:

```ts
import { fontsourceFontLoader } from "metaplate/fonts";

const fonts = fontsourceFontLoader([
  { font: "inter", weight: 400 },
  { font: "inter", weight: 700 },
]);
```

Install the corresponding package once (`npm install @fontsource/inter`). This
uses [Fontsource's official npm self-hosting model](https://fontsource.org/docs/getting-started/introduction)
while selecting WOFF instead of the WOFF2 normally used by browser CSS.

For a font already checked into the project, point at it directly in a
Node-compatible renderer:

```ts
import { fileFontLoader } from "metaplate/fonts";

const fonts = fileFontLoader([
  {
    name: "Brand Sans",
    file: new URL("../assets/brand-sans.woff", import.meta.url),
    weight: 700,
  },
]);
```

For an edge runtime or a framework that already resolves/fetches an asset,
give Metaplate the resulting bytes. The callback stays lazy and is evaluated
once:

```ts
import { fontLoader } from "metaplate/font-data";

const fonts = fontLoader([
  {
    name: "Brand Sans",
    weight: 700,
    data: async () => {
      const response = await fetch(new URL("../assets/brand-sans.woff", import.meta.url));
      if (!response.ok) throw new Error(`Unable to load font: ${response.status}`);
      return response.arrayBuffer();
    },
  },
]);
```

[Vite documents asset URL imports](https://vite.dev/guide/assets.html), but also
notes that `new URL(..., import.meta.url)` has different semantics in SSR. In
Astro and React Router Node deployments, prefer `fileFontLoader` for
server-owned files; use `fontLoader` only when the framework/deployment already
gives the server a fetchable URL or bytes.

`packageFontLoader` remains the escape hatch for other npm font packages. It
resolves through the active runtime first (npm, Yarn classic, pnpm, and hoisted
workspaces), then falls back to an upward `node_modules` walk:

Install layouts without a physical `node_modules` — Yarn Plug'n'Play — cannot
be read by path at all. Supply a `resolvePackage` hook that maps a package
name to a readable directory (an unplugged path, or a zipfs-backed view of
the archive):

```ts
import { packageFontLoader } from "metaplate/fonts";

const fonts = packageFontLoader([
  { name: "Inter", package: "@fontsource/inter", file: "files/inter-latin-700-normal.woff", weight: 700 },
], {
  resolvePackage: (name) => zipfsResolveToReadableDir(name),
});
```

Return `undefined` to fall back to the default resolution.

## Plate constraints

A plate is a Satori layout that rasterises to an image, not a DOM tree. Five
differences bite in practice:

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
  [variant](#square-and-landscape-variants), instead.

## Static hosts

Extension-free route-handler output may be served as a generic download by a
static host. Set the `Content-Type` explicitly for `/og-image` and `/*/og-image`
— `image/png` by default, or the `plate.contentType` of a custom-output plate
(`image/jpeg`, `image/webp`, …). For Netlify, a PNG plate:

```toml
[[headers]]
for = "/og-image"
  [headers.values]
  Content-Type = "image/png"

[[headers]]
for = "/*/og-image"
  [headers.values]
  Content-Type = "image/png"
```

A JPEG plate uses `Content-Type = "image/jpeg"` for the same two paths.

## Deployment routes

For provider-neutral guidance covering static generation, Vercel and Netlify Node
functions, Railway and Render services, GitHub Pages, and edge-runtime limits,
see the [deployment routes guide](docs/deployment.md). The release's current
route evidence and certification status lives in
[`deployment-evidence.json`](https://github.com/lnorton89/metaplate/blob/main/deployment-evidence.json)
in the repository. The short version is:
use a real `.png`/`.jpg` file for static hosts, use the provider's Node runtime
for `metaplate/node`, and never deploy the native renderer to an Edge/Workers
runtime; use `metaplate/edge`, which is tested in Node against its Wasm renderer
but not yet certified on a hosted edge platform.

## Verify generated files

`metaplate verify` reads dimensions from SVG roots and from PNG, JPEG, WebP,
and GIF container headers. It runs a structural/truncation check: raster chunk streams
are walked through image data to their terminator, while SVG roots must declare
safe, positive pixel dimensions (without XML entity expansion). Obvious header
shells, malformed roots, and partially written files fail even when their
dimension data survives. It is not a full raster decode — a file whose headers
are intact but whose payload cannot decode is outside its scope:

```sh
npx metaplate verify --size 1200x630 public/og.png
```

Files of different sizes can be checked in one invocation by repeating the
size group:

```sh
npx metaplate verify \
  --size 1200x630 public/og.png public/about.png \
  --size 512x512 public/icon-512.png
```

Mixed formats work in one invocation, since the format is detected per file,
and every target is checked even when earlier ones fail — the command reports
the full failing set and exits non-zero once:

```sh
npx metaplate verify --size 1200x630 public/og-image.jpg out/og-image.jpg --size 512x512 public/icon.webp
```

When a declared format must also hold — for example a `.jpg` file that must
really contain JPEG — pass `--format`:

```sh
npx metaplate verify --format jpeg --size 1200x630 out/og-image.jpg
```

Or import `verifyImage` from `metaplate/image` in a test, which returns the
format it verified alongside the dimensions. `metaplate/png` remains available
for PNG-only checks.

For a single application/reporting contract, `verifySocialImage` from the root
entry checks the encoded bytes and the published descriptor together. Structural
image failures still throw; metadata disagreement and compatibility findings are
returned so CI can report them:

```ts
import { verifySocialImage } from "metaplate";

const report = verifySocialImage(bytes, metadata.openGraph.images[0], {
  targets: ["universal", "linkedin"],
  maxFileSize: 1_000_000,
});

if (!report.compatible) throw new Error(JSON.stringify(report.issues));
console.log(report.actual); // { width, height, format, contentType, byteLength }
```

Every descriptor field is optional. `width` and `height` must be supplied
together and are compared against the bytes; `type` is compared against the
detected format; `url` and `alt` are checked only when present.

The CLI exposes the same checks for deployment pipelines:

```sh
npx metaplate verify --json --target linkedin --url https://example.com/og.png --alt "Project card" --max-file-size 1000000 --size 1200x630 out/og-image.png
```

`--json` prints one stable report per file with `valid` (file-level findings)
separate from per-target `compatible`. `--target` is repeatable.
`--max-file-size N` fails any file over `N` bytes and works without a target.
A target without `--url` or `--alt` verifies only image and platform facts and
does not invent metadata; those two flags are evaluated against targets only,
so they are rejected without at least one `--target`.

### Verify a deployed URL

`metaplate verify-url` fetches an image over http(s) and runs it through the
same checks as `verify`, so a deployment pipeline can confirm what a crawler
will actually receive:

```sh
npx metaplate verify-url --format png --size 1200x630 https://example.com/og.png
```

It takes the same `--json`, `--target`, `--alt`, `--max-file-size`, `--format`,
and repeatable `--size` groups as `verify`, with URLs in place of files.
`--target` checks evaluate the requested URL as it would be published. Beyond
the `verify` checks, the response `Content-Type` must name the format the bytes
really are. A success line reports the byte count and, after redirects, the
final URL; `--json` prints `{ "schemaVersion": 1, "urls": [...] }`, where each
entry carries the `verify` fields plus `url`, `finalUrl`, `redirects`,
`contentType`, and `bytes`, and each failure carries a stable `code`.

Fetching a URL someone else controls from a CI runner is a server-side request
forgery risk, so the fetcher refuses by default anything that is not plainly a
public image:

- **Schemes and ports.** Only `http:` and `https:` on their default ports.
  `file:`, `data:`, `ftp:`, and every other scheme are refused, as is any other
  port unless it is allowed with `--allow-port PORT` (repeatable).
- **Credentials.** URLs with user information (`https://user:pass@host/`) are
  refused, and the password is never echoed into logs or reports. Requests
  carry no cookies or `Authorization` header, `Set-Cookie` is ignored, and the
  only headers sent are `Host`, `User-Agent: metaplate-verify/<version>`,
  `Accept: image/*`, and `Accept-Encoding: identity`.
- **Addresses.** The hostname is resolved once per hop, and the fetch is
  refused if *any* resolved address is loopback, private (10/8, 172.16/12,
  192.168/16), carrier-grade NAT, link-local (including 169.254.169.254 cloud
  metadata), unique-local, unspecified, multicast, reserved, or an IPv4-mapped,
  NAT64, or 6to4 form of one. The connection is then made to the checked
  address itself, with the original name in `Host` and TLS SNI, so a DNS answer
  that changes between check and connect cannot move the request.
- **Redirects.** At most `--max-redirects N` (default 3) are followed, and every
  hop gets the full scheme, credential, port, and address check again.
- **Limits.** The body is capped at `--max-bytes N` (default 16 MiB) while it
  streams, and the whole fetch, redirects included, must finish within
  `--timeout MS` (default 10000). Each connection, from connect to the last
  body byte, is also held to 10 seconds or the total budget, whichever is
  lower. Only a `200` response is verified.

`--allow-private` lifts the address check so you can verify a local server
such as `http://127.0.0.1:3000`. It exists for local development only; do not
pass it in a pipeline that fetches URLs you do not control:

```sh
npx metaplate verify-url --allow-private --allow-port 3000 --size 1200x630 http://127.0.0.1:3000/og.png
```

The same fetcher is available from `metaplate/node` as `verifyRemoteImage` and
`fetchRemoteImage`. Failures throw `RemoteImageError` with a `code` such as
`address`, `scheme`, `byte-limit`, `timeout`, or `content-type`:

```ts
import { RemoteImageError, verifyRemoteImage } from "metaplate/node";

try {
  const checked = await verifyRemoteImage(
    "https://example.com/og.png",
    { width: 1200, height: 630, format: "png" },
    { maxBytes: 5_000_000, timeoutMs: 5_000 },
  );
  console.log(checked.finalUrl, checked.byteLength, checked.image);
} catch (error) {
  if (error instanceof RemoteImageError) console.error(error.code, error.message);
  throw error;
}
```

Options mirror the CLI flags: `allowPrivate`, `allowedPorts`, `maxRedirects`,
`maxBytes`, `timeoutMs`, plus `connectionTimeoutMs` for the per-connection
ceiling and `resolve` to replace `dns.lookup` (its answers are still checked).

## Entry points

- `metaplate` — framework-free paths, dimensions, metadata, `<meta>` tag
  serialization, social compatibility, and byte-level social image
  verification.
- `metaplate/render` — Satori-based SVG generation. Satori is installed
  automatically.
- `metaplate/node` — SVG, PNG, raw pixels, and any format a supplied encoder
  produces, plus Fetch API responses. Satori and Resvg are installed
  automatically. Also the hardened remote fetcher behind `verify-url`
  (`fetchRemoteImage`, `verifyRemoteImage`).
- `metaplate/edge` — PNG, raw pixels, and Fetch API responses through
  `@resvg/resvg-wasm` for Workers, Deno, and other edge runtimes. No Node
  built-ins. Needs `@resvg/resvg-wasm` and caller-supplied Wasm.
- `metaplate/next` — native Next.js `ImageResponse` adapter. Needs `next`.
- `metaplate/font-data` — runtime-neutral normalization and memoization for
  application/framework-provided bytes. No peers or Node built-ins.
- `metaplate/fonts` — project-file, Fontsource, generic npm-package, and
  application-byte font loading for Node-compatible runtimes. No peers.
- `metaplate/png` — PNG header inspection and dimension verification. No peers.
- `metaplate/image` — dimension and structural verification for SVG, PNG,
  JPEG, WebP, and GIF. No peers.

## Design lineage

Metaplate extracts the production patterns used by the GOLC and Cinnabar sites
and the pre-rendered static-image pattern used by the AntikytheraOS showcase.

## License

MIT
