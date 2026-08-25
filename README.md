# Metaplate

[![CI](https://github.com/lnorton89/metaplate/actions/workflows/ci.yml/badge.svg)](https://github.com/lnorton89/metaplate/actions/workflows/ci.yml)
[![CodeQL](https://github.com/lnorton89/metaplate/actions/workflows/codeql.yml/badge.svg)](https://github.com/lnorton89/metaplate/actions/workflows/codeql.yml)
[![npm](https://img.shields.io/npm/v/metaplate)](https://www.npmjs.com/package/metaplate)
[![Socket Badge](https://badge.socket.dev/npm/package/metaplate/0.5.0)](https://socket.dev/npm/package/metaplate/overview/0.5.0)
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
  - [Authoring without a JSX toolchain](#authoring-without-a-jsx-toolchain)
  - [SVG-only rendering](#svg-only-rendering)
- [Next.js adapter](#nextjs-adapter)
- [Metadata without a renderer](#metadata-without-a-renderer)
  - [Channel-specific images and X Cards](#channel-specific-images-and-x-cards)
  - [Social compatibility profiles](#social-compatibility-profiles)
  - [Next.js static export and `basePath`](#nextjs-static-export-and-basepath)
- [Fonts](#fonts)
- [Plate constraints](#plate-constraints)
- [Static hosts](#static-hosts)
- [Deployment routes](#deployment-routes)
- [Verify generated files](#verify-generated-files)
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

`next` remains the only optional peer: Next applications already own their
framework version, and non-Next applications should not download it. The
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
only unrelated headers such as `Cache-Control`. Set `etag: "sha256"` on the
plate when responses should carry a deterministic strong ETag based on the final
encoded bytes.

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
JPEG, and WebP, so the build check follows the card whichever format it takes.

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
typed params without a wrapper around every plate:

```ts
import type { RequestHandler } from "./$types";
import { og } from "$lib/og";

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
Web `Response` does not by itself make its edge runtime compatible.

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
| Astro static endpoints | [Static and server endpoints](https://docs.astro.build/en/guides/endpoints/) | Astro 7 build on Node 24 | Exact packed artifact produces the endpoint, PNG bytes, dimensions, and absolute page metadata. |
| React Router resource routes | [Resource routes](https://reactrouter.com/how-to/resource-routes) | React Router 7 framework mode on Node | Exact packed artifact is type-generated, typechecked, built, served, and fetched through a dynamic `loader(args)` route. |
| SvelteKit | [`+server` routing](https://svelte.dev/docs/kit/routing#server) and [`adapter-node`](https://svelte.dev/docs/kit/adapter-node) | Node-compatible adapters | `handlerFrom` follows its `RequestHandler` contract, but certification is deferred while the latest stable Kit line retains an upstream Cookie advisory. |
| Express | [Express 5 response API](https://expressjs.com/en/5x/api/#res.send) | Express 5 on Node | Exact packed artifact is served over an ephemeral HTTP server and checked for headers, bytes, and dimensions. |
| Workers, Deno, and other edge runtimes | Consult the framework's adapter/runtime documentation | Not supported by `metaplate/node` | Native Resvg cannot be inferred from Web `Response` support. Use a compatible renderer instead. |

Public dynamic image routes are CPU- and memory-intensive. Bound copy length
and component complexity, use stable path params rather than arbitrary query
strings, set an explicit cache policy, and apply deployment-level concurrency
and timeout limits. Never pass a request-controlled remote image URL into a
Satori component: allowlist asset origins so server-side rendering cannot be
used to reach private or link-local services.

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

A plate renders exactly one size. `plate.size` is both the definition size and
the size `render`/`renderSvg`/`response` use, so the bytes Metaplate produces
and the dimensions it advertises (`og:image:width`/`height`) can never
disagree. Size values must be integers between 1 and 65535; `socialImage`,
`socialImageMetadata`, and every plate definition reject anything else at the
boundary.

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

The one-image call remains unchanged. When a landscape Open Graph image, a
square fallback, and an X-specific composition differ, override only those
channels. Open Graph ordering is preserved and the first descriptor remains
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
including LinkedIn's dimensions and optional 5 MB limit:

```ts
import { socialImageCompatibility } from "metaplate";

const report = socialImageCompatibility(metadata.openGraph.images[0], {
  targets: ["universal", "facebook", "linkedin", "slack"],
  fileSize: generatedBytes.byteLength,
});

if (!report.compatible) throw new Error(JSON.stringify(report.issues));
```

Issues are `error`, `warning`, or `unknown`. Discord and Instagram checks are
reported as unknown because neither publishes a stable webpage image-tag
contract. SVG remains useful as renderer output, but it is not a universal
social delivery format; use PNG or JPEG for broad crawler compatibility.

This local report cannot prove public fetchability, redirects, response MIME,
robots/WAF behavior, or crawler caches. Those require checking the deployed
page and image; use Meta Sharing Debugger, LinkedIn Post Inspector, and the
relevant client debugger after deployment.

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

A plate is a Satori layout that rasterises to an image, not a DOM tree. Four
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
- **Resvg may not resize the raster behind the plate's back.** Dimension-changing
  `fitTo` values and `crop` are rejected because metadata, `plate.size`, raw
  pixels, and encoded output must agree. Define the intended `size` on the
  plate instead.

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
[`deployment-evidence.json`](deployment-evidence.json). The short version is:
use a real `.png`/`.jpg` file for static hosts, use the provider's Node runtime
for `metaplate/node`, and do not deploy the native renderer to an Edge/Workers
runtime without a separately tested Wasm-compatible renderer.

## Verify generated files

`metaplate verify` reads dimensions from SVG roots and PNG, JPEG, WebP, or
structurally walked GIF files
container headers. It runs a structural/truncation check: raster chunk streams
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
format it verified alongside the dimensions. For a single application/reporting
contract, use `verifySocialImage(bytes, descriptor, { targets: [...] })` to catch
byte/metadata format and dimension mismatches alongside target compatibility
findings. Add `--json --target linkedin --url https://example.com/og.png --alt
\"Project card\"` to the CLI for machine-readable deployment checks.
`metaplate/png` remains available for PNG-only checks.

## Entry points

- `metaplate` — framework-free paths, dimensions, and metadata.
- `metaplate/render` — Satori-based SVG generation. Satori is installed
  automatically.
- `metaplate/node` — SVG, PNG, raw pixels, and any format a supplied encoder
  produces, plus Fetch API responses. Satori and Resvg are installed
  automatically.
- `metaplate/next` — native Next.js `ImageResponse` adapter. Needs `next`.
- `metaplate/font-data` — runtime-neutral normalization and memoization for
  application/framework-provided bytes. No peers or Node built-ins.
- `metaplate/fonts` — project-file, Fontsource, generic npm-package, and
  application-byte font loading for Node-compatible runtimes. No peers.
- `metaplate/png` — PNG header inspection and dimension verification. No peers.
- `metaplate/image` — dimension and structural verification for SVG, PNG,
  JPEG, and WebP. No peers.

## Design lineage

Metaplate extracts the production patterns used by the GOLC and Cinnabar sites
and the pre-rendered static-image pattern used by the AntikytheraOS showcase.

## License

MIT
