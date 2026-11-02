# Metaplate

[![CI](https://github.com/lnorton89/metaplate/actions/workflows/ci.yml/badge.svg)](https://github.com/lnorton89/metaplate/actions/workflows/ci.yml)
[![CodeQL](https://github.com/lnorton89/metaplate/actions/workflows/codeql.yml/badge.svg)](https://github.com/lnorton89/metaplate/actions/workflows/codeql.yml)
[![npm](https://img.shields.io/npm/v/metaplate)](https://www.npmjs.com/package/metaplate)
[![Socket Badge](https://badge.socket.dev/npm/package/metaplate/0.7.0)](https://socket.dev/npm/package/metaplate/overview/0.7.0)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Composable, framework-neutral Open Graph image tooling for TypeScript.

Define your social images once. Render, serve, and publish them consistently across your TypeScript app.

Metaplate turns a single branded JSX plate into the complete Open Graph image pipeline. Use the same definition to render SVG or raster images in several sizes, serve them from Node-compatible or edge routes, generate matching Open Graph and X metadata, emit the `<meta>` tags, manage fonts, produce predictable image URLs, and verify the files you ship, locally or at a deployed URL.

The same metadata also produces Open Graph video and audio tags, X player and app cards, Schema.org `ImageObject` JSON-LD, and Adaptive Cards for Teams, Slack, and Discord previews.

It works with plain Node, static build scripts, Next.js, Astro, React Router, SvelteKit, Express, Bun, and Deno, and on Deno-based edges such as Netlify Edge Functions and Deno Deploy, without tying your image design to a single framework.

## Contents

- [Install](#install)
  - [Dependency behavior](#dependency-behavior)
- [Quick start](#quick-start)
- [Guides](#guides)
  - [Rendering and routes](#rendering-and-routes)
  - [Static files with `metaplate render`](#static-files-with-metaplate-render)
  - [Framework and runtime support](#framework-and-runtime-support)
  - [Edge runtimes](#edge-runtimes)
  - [Next.js](#nextjs)
  - [Square and landscape variants](#square-and-landscape-variants)
  - [Metadata and meta tags](#metadata-and-meta-tags)
  - [X player and app cards](#x-player-and-app-cards)
  - [Social compatibility profiles](#social-compatibility-profiles)
  - [Teams, Slack, and Discord previews](#teams-slack-and-discord-previews)
  - [Schema.org image metadata](#schemaorg-image-metadata)
  - [Fonts](#fonts)
  - [Emoji](#emoji)
  - [Verifying images](#verifying-images)
  - [Deployment routes](#deployment-routes)
- [Entry points](#entry-points)
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

## Quick start

Define the design once with `createNodeOg`. The component is Satori-compatible
JSX, not browser DOM: containers with more than one child use flex, and a root
that fills the card with padding needs `boxSizing: "border-box"` (see
[plate constraints](docs/rendering.md#plate-constraints)).

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

The same plate renders bytes, a complete artifact with its metadata, and
Fetch API responses for any framework route:

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

## Guides

Each guide below is a summary; the linked page has the full reference.

### Rendering and routes

`render` returns PNG by default, and an `output` encoder produces JPEG, WebP,
or anything else from the same raw pixels. `handler` and `handlerFrom` plug
into Fetch-based routes in Next.js, Astro, React Router, and SvelteKit, and
`render` feeds Express or a build script. Plates are Satori layouts, not DOM,
so read the plate constraints before designing one.
[Rendering guide](docs/rendering.md)

### Static files with `metaplate render`

`metaplate render` renders a whole site's cards for static hosting. It loads a
module whose default export is `{ plate, pages: [{ route, copy }] }`, writes
every page at every size to the path its metadata URL names, verifies each
file, and records them in a checksummed manifest.

```sh
npx metaplate render og.render.mjs --out public
```

[Render CLI guide](docs/render-cli.md)

### Framework and runtime support

Every supported framework and runtime is listed with the official reference
it follows and the release evidence behind it, from packed-tarball fixtures to
dated hosted deployments.
[Support matrix](docs/support.md)

### Edge runtimes

`metaplate/edge` renders the same plates through `@resvg/resvg-wasm` with no
Node built-ins. It runs on Deno-based edges such as Netlify Edge Functions and
Deno Deploy, and not on Cloudflare Workers or Vercel Edge, which forbid the
run-time WebAssembly compilation Satori needs.
[Edge guide](docs/edge.md)

### Next.js

`metaplate/next` renders through Next's own `next/og` pipeline and keeps the
same route and metadata pattern. The guide also covers static export with
`basePath` and JPEG or WebP cards through the Node renderer.
[Next.js guide](docs/nextjs.md)

### Square and landscape variants

One plate can declare `variants` such as a 1080x1080 square beside the
1200x630 card. The component receives `{ variant, size }` and lays out each
size itself, and `plate.variant(name)` gives the full plate API for one size.
[Variants guide](docs/variants.md)

### Metadata and meta tags

The root `metaplate` entry builds Open Graph and X metadata with no renderer
or framework, including per-channel images and Open Graph video and audio.
`socialMetaTags` and `socialMetaHtml` emit the `<meta>` tags for pages that
write their own `<head>`. An opt-in `version`, or a plate's `version: "copy"`,
adds a `?v=` token to published image URLs so crawlers that cache images by
URL fetch a changed card, while file paths stay unchanged.
[Metadata guide](docs/metadata.md)

### X player and app cards

`twitter.card` can be `"player"` or `"app"`, with the payload each one
requires checked against X's published rules. `nextTwitterMetadata` maps them
to Next.js metadata.
[X cards guide](docs/x-cards.md)

### Social compatibility profiles

`socialImageCompatibility` checks an image descriptor against each platform's
published preview rules, such as LinkedIn's minimum size, Discord's accepted
formats, or WhatsApp's 600 KB limit, without network requests. Platforms that
publish no rules, such as Instagram and Telegram, are reported as unknown.
[Profiles guide](docs/compatibility.md)

### Teams, Slack, and Discord previews

Chat clients build link previews from the same meta tags, so no app is needed.
For bots and webhooks, `socialImageAdaptiveCard` builds an Adaptive Card from
the same metadata.
[Chat previews guide](docs/adaptive-cards.md)

### Schema.org image metadata

`socialImageJsonLd` describes the same images as a schema.org `ImageObject`
in JSON-LD, and `socialImageJsonLdScript` serializes it safely for a
`<script>` tag.
[JSON-LD guide](docs/json-ld.md)

### Fonts

Satori needs the bytes of every face it renders. Loaders read them from
project files, Fontsource, other npm packages, or bytes you supply, and
memoize one copy for every render.
[Fonts guide](docs/fonts.md)

### Emoji

The `emoji` plate option draws emoji as images instead of missing-glyph boxes.
`packageEmojiLoader` from `metaplate/fonts` reads them offline from a set the
application installs, such as `@twemoji/svg`, and `emojiLoader` from
`metaplate/emoji` takes any source, including your own origin on an edge
runtime. Metaplate bundles no artwork; the guide covers each set's license.
[Emoji guide](docs/emoji.md)

### Verifying images

`metaplate verify` checks generated files for dimensions, format, structure,
and platform rules, and `metaplate verify-url` runs the same checks on a
deployed URL under a hardened fetch policy. `metaplate verify-page` audits a
whole page: it reads the page's `og:image`, `twitter:card`, `twitter:image`,
and JSON-LD images and verifies every image they name.
[Verification guide](docs/verification.md) and
[page audit guide](docs/verify-page.md)

### Deployment routes

Use a real `.png` or `.jpg` file on static hosts, the provider's Node runtime
for `metaplate/node`, and `metaplate/edge` on Deno-based edges. Hosted
certifications cover Vercel Functions, Next.js on Vercel, Netlify Functions,
Netlify Edge Functions, and Deno Deploy, each from a dated deployment whose
sources are in [`examples/hosted`](examples/hosted). The current status of
every route is in [`deployment-evidence.json`](deployment-evidence.json).
[Deployment guide](docs/deployment.md)

## Entry points

- `metaplate` — framework-free paths, dimensions, Open Graph and X metadata
  (including video and audio, and X player and app cards), cache-busting
  image URL versions (`socialImageVersion`), `<meta>` tag serialization, Schema.org JSON-LD, Adaptive Cards, social compatibility
  profiles, and byte-level social image verification.
- `metaplate/render` — Satori-based SVG generation. Satori is installed
  automatically.
- `metaplate/node` — SVG, PNG, raw pixels, and any format a supplied encoder
  produces, plus Fetch API responses. Satori and Resvg are installed
  automatically. Also the hardened remote fetcher behind `verify-url` and
  `verify-page` (`fetchRemoteImage`, `verifyRemoteImage`, `verifyRemotePage`,
  `extractPageSocialMetadata`).
- `metaplate/edge` — PNG, raw pixels, and Fetch API responses through
  `@resvg/resvg-wasm` for Deno-based edges such as Netlify Edge Functions,
  and other runtimes that allow run-time Wasm compilation; not Cloudflare
  Workers. No Node built-ins. Needs `@resvg/resvg-wasm` and the
  caller-supplied `@resvg/resvg-wasm/index_bg.wasm` and `satori/layout.wasm`
  modules.
- `metaplate/next` — native Next.js `ImageResponse` adapter, and
  `nextTwitterMetadata` for X player and app cards in Next metadata. Needs
  `next`.
- `metaplate/font-data` — runtime-neutral normalization and memoization for
  application/framework-provided bytes. No peers or Node built-ins.
- `metaplate/fonts` — project-file, Fontsource, generic npm-package, and
  application-byte font loading, plus installed emoji packages
  (`packageEmojiLoader`), for Node-compatible runtimes. No peers.
- `metaplate/emoji` — runtime-neutral emoji images for the `emoji` plate
  option (`emojiLoader`, `twemojiName`). No peers or Node built-ins; the
  installed-package reader, `packageEmojiLoader`, is in `metaplate/fonts`.
- `metaplate/png` — PNG header inspection and dimension verification. No peers.
- `metaplate/image` — dimension and structural verification for SVG, PNG,
  JPEG, WebP, and GIF. No peers.

## License

MIT
