# Metaplate

[![CI](https://github.com/lnorton89/metaplate/actions/workflows/ci.yml/badge.svg)](https://github.com/lnorton89/metaplate/actions/workflows/ci.yml)
[![CodeQL](https://github.com/lnorton89/metaplate/actions/workflows/codeql.yml/badge.svg)](https://github.com/lnorton89/metaplate/actions/workflows/codeql.yml)
[![npm](https://img.shields.io/npm/v/metaplate)](https://www.npmjs.com/package/metaplate)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Composable, framework-neutral Open Graph image tooling for TypeScript.

Metaplate turns one branded JSX plate into a consistent image system: SVG and
raster rendering (PNG by default, any format an encoder produces), Fetch API
responses, predictable image URLs, matching Open Graph and Twitter metadata,
package-based font loading, and image verification. It works with plain Node,
Astro, SvelteKit, Remix, Express, static build scripts, and Next.js.

## Contents

- [Install](#install)
  - [Optional peers](#optional-peers)
- [Framework-neutral renderer](#framework-neutral-renderer)
  - [Other output formats](#other-output-formats)
  - [Astro, SvelteKit, Remix, and other Fetch-based routes](#astro-sveltekit-remix-and-other-fetch-based-routes)
  - [Express and build scripts](#express-and-build-scripts)
  - [Authoring without a JSX toolchain](#authoring-without-a-jsx-toolchain)
  - [SVG-only rendering](#svg-only-rendering)
- [Next.js adapter](#nextjs-adapter)
- [Metadata without a renderer](#metadata-without-a-renderer)
  - [Next.js static export and `basePath`](#nextjs-static-export-and-basepath)
- [Fonts](#fonts)
- [Plate constraints](#plate-constraints)
- [Static hosts](#static-hosts)
- [Verify generated files](#verify-generated-files)
- [Entry points](#entry-points)
- [Design lineage](#design-lineage)
- [License](#license)

## Install

Metaplate has no runtime dependencies of its own. Each entry point declares the
peers it needs, so metadata-only and Next.js projects never download Satori or
Resvg's platform-specific binaries.

For metadata, or for Next.js where `next` and `react` are already supplied by
the application:

```sh
npm install metaplate
```

For framework-neutral PNG rendering with `metaplate/node`:

```sh
npm install metaplate satori @resvg/resvg-js react
```

For SVG-only rendering with `metaplate/render`, Resvg is unnecessary:

```sh
npm install metaplate satori react
```

React is needed only for JSX authoring. A plate can also be written as a
plain `{ type, props }` object tree — see
[Authoring without a JSX toolchain](#authoring-without-a-jsx-toolchain) —
which needs no React at all, its types or the package.

### Optional peers

Every peer — `satori`, `@resvg/resvg-js`, and `next` — loads on the first
render rather than at import time, so each entry point imports cleanly in an
install that lacks it. A render without the peer reports the package to
install:

```
Cannot find satori, required by metaplate/render and metaplate/node.
Install it with: npm install satori
```

Through 0.1.x Satori and Resvg were ordinary dependencies. Standalone consumers
upgrading from those versions should add them to their own `package.json`;
nothing changes for metadata-only consumers, and Next.js applications already
supply `next` themselves.

`metaplate/next` no longer re-exports `ImageResponse`. Import it from `next/og`
directly if a plate needs it:

```ts
import { ImageResponse } from "next/og";
```

Upgrading in place does not reclaim the disk. An already-installed `satori` or
`@resvg/resvg-js` satisfies the now-optional peer, so npm considers the tree
valid and leaves both packages where they are; `npm prune` makes it worse,
proposing Resvg's entire platform matrix rather than removing anything.
Reinstall from scratch to shed them:

```sh
rm -rf node_modules package-lock.json && npm install
```

Measured on a metadata-only consumer: 19 MB retained after an in-place upgrade
from 0.1.2, against 164 KB after a clean reinstall.

## Framework-neutral renderer

Define the design once with `createNodeOg`. The component is Satori-compatible
JSX, not browser DOM, so containers with multiple children should use flex.

```tsx
// src/lib/og.tsx
import { packageFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

export const og = createNodeOg<{ title: string; alt: string }>({
  alt: (copy) => copy.alt,
  fonts: packageFontLoader([
    {
      name: "Inter",
      package: "@fontsource/inter",
      file: "files/inter-latin-700-normal.woff",
      weight: 700,
    },
  ]),
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

The resulting plate supports three output forms:

```ts
const png: Uint8Array = await og.render(copy);
const svg: string = await og.renderSvg(copy);
const response: Response = await og.response(copy);
```

Rendering is safe to call concurrently. Satori is a pure call, each render
builds its own Resvg instance, and `packageFontLoader` memoizes one shared copy
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

### Astro, SvelteKit, Remix, and other Fetch-based routes

`handler` returns a standard Fetch API handler. For an Astro endpoint:

```ts
// src/pages/og-image.png.ts
import { og } from "../lib/og";

export const prerender = true;
export const GET = og.handler({ title: "An Astro site", alt: "Astro card" });
```

The same handler shape works in SvelteKit and other route systems that return a
Web `Response`.

### Express and build scripts

Express can send the bytes returned by `render` — PNG by default, or whatever
`output` encodes. Static generators can write the same bytes into `public/`
during a build:

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
import { packageFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

const og = createNodeOg({
  alt: (copy) => copy.alt,
  fonts: packageFontLoader([
    {
      name: "Inter",
      package: "@fontsource/inter",
      file: "files/inter-latin-700-normal.woff",
      weight: 700,
    },
  ]),
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

The same tree can be written as plain `{ type, props }` objects when React is
not installed at all, which is what the standalone package verification does.
That path is typed, not just runtime-supported: `createSvgOg` and
`createNodeOg` declare `component` as returning a local `SatoriNode` element
tree rather than React's `ReactNode`, so a TypeScript consumer of
`metaplate/render` or `metaplate/node` does not need React — its types or the
package — to author a plain-object plate. The Next adapter keeps React's own
types because Next itself is intrinsic to it.

### SVG-only rendering

Use `createSvgOg` from `metaplate/render` when the consumer only needs SVG and
should not install Resvg's native Node binding.

## Next.js adapter

Next applications can use the native `next/og` pipeline while keeping the same
route and metadata pattern:

```tsx
// src/lib/og.tsx
import { packageFontLoader } from "metaplate/fonts";
import { createNextOg } from "metaplate/next";

export type OgCopy = {
  eyebrow: string;
  title: string;
  description: string;
  alt: string;
};

export const og = createNextOg<OgCopy>({
  alt: (copy) => copy.alt,
  fonts: packageFontLoader([
    {
      name: "Inter",
      package: "@fontsource/inter",
      file: "files/inter-latin-700-normal.woff",
      weight: 700,
    },
  ]),
  component: (copy) => (
    <div style={{ width: "100%", height: "100%", display: "flex" }}>
      {copy.title}
    </div>
  ),
});
```

Next shallow-merges metadata: a page that sets `openGraph` **replaces** the
root layout's rather than extending it. Spreading `og.metadata()` straight into
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

### Next.js static export and `basePath`

Next's special `app/opengraph-image.tsx` file suits a root-deployed app: set
`dynamic = "force-static"` and Next prerenders the `ImageResponse` during
`next build` with `output: "export"` enabled.

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

Satori needs real font bytes and accepts TTF, OTF, and WOFF, but not WOFF2.
`packageFontLoader` resolves faces from installed packages — through the
active runtime resolver first (so npm, Yarn classic, and pnpm layouts work,
including hoisted workspaces), falling back to an upward `node_modules` walk.
It memoizes the bytes for repeated development requests, and a failed load is
retried on the next call rather than poisoning the loader.

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

A plate is a Satori layout that rasterises to an image, not a DOM tree. Three
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

## Verify generated files

`metaplate verify` reads dimensions from the container header — PNG, JPEG, or
WebP — and runs a structural/truncation check: the chunk stream is walked
through image data to its terminator, and obvious header shells are rejected,
so a truncated or partially written file fails even when its dimension header
survives. It is not a full decode — a file whose headers are intact but whose
payload cannot decode is outside its scope:

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

## Entry points

- `metaplate` — framework-free paths, dimensions, and metadata. No peers.
- `metaplate/render` — Satori-based SVG generation. Needs `satori`.
- `metaplate/node` — SVG, PNG, raw pixels, and any format a supplied encoder
  produces, plus Fetch API responses. Needs `satori` and `@resvg/resvg-js`.
- `metaplate/next` — native Next.js `ImageResponse` adapter. Needs `next`.
- `metaplate/fonts` — hoist-safe package font loading and memoization. No peers.
- `metaplate/png` — PNG header inspection and dimension verification. No peers.
- `metaplate/image` — the same for PNG, JPEG, and WebP. No peers.

## Design lineage

Metaplate extracts the production patterns used by the GOLC and Cinnabar sites
and the pre-rendered static-image pattern used by the AntikytheraOS showcase.

## License

MIT
