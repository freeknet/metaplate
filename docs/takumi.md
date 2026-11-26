# Takumi renderer (experimental)

`metaplate/takumi` renders plates with [Takumi](https://takumi.kane.tw/docs/)
(`takumi-js`) instead of Satori and Resvg. Takumi ships a precompiled
WebAssembly build, so this entry renders on **Cloudflare Workers**, where
[`metaplate/edge` cannot start](edge.md). It also runs on Node.js (Takumi's
native addon), Deno, and other Fetch-shaped runtimes.

It takes the same plate definition and returns the same plate surface as
`createEdgeOg`: `render`, `renderPixels`, `renderSvg`, `artifact`, `response`,
`fetchable`, `fetchableFrom`, `cached`, `metadata`, variants, and render
guards.

- [Install](#install)
- [Cloudflare Workers](#cloudflare-workers)
- [How it differs from Satori](#how-it-differs-from-satori)
- [Fonts, languages, and emoji](#fonts-languages-and-emoji)
- [Remote images](#remote-images)
- [Render guards](#render-guards)
- [Status](#status)

## Install

```sh
npm install metaplate takumi-js
```

`takumi-js` is an optional peer (`>=2.22.1 <3`). Metaplate's tests run against
the exact version in its lockfile.

```ts
import { fontLoader } from "metaplate/font-data";
import { createTakumiOg } from "metaplate/takumi";

export const og = createTakumiOg({
  alt: (copy: { title: string }) => copy.title,
  fonts: fontLoader([{ name: "Inter", weight: 700, data: interWoff2 }]),
  component: (copy) => ({
    type: "div",
    props: {
      style: { width: "100%", height: "100%", display: "flex", alignItems: "center", padding: 64, fontFamily: "Inter", fontWeight: 700, fontSize: 64 },
      children: copy.title,
    },
  }),
});
```

Fonts must be TrueType, OpenType, or **WOFF2**. Takumi cannot read WOFF 1.0,
and the entry rejects a WOFF font with an error naming it. Fontsource ships
both files: use `files/<font>-<subset>-<weight>-normal.woff2`.

## Cloudflare Workers

`takumi-js`'s `workerd` import condition loads its precompiled `.wasm`, which
Wrangler bundles as a `WebAssembly.Module`, so there is no Wasm to pass. Bundle
the font as a Data module:

```toml
# wrangler.toml
name = "og"
main = "src/index.ts"
compatibility_date = "2026-10-01"

[[rules]]
type = "Data"
globs = ["**/*.woff2"]
fallthrough = true
```

```ts
// src/index.ts
import inter from "@fontsource/inter/files/inter-latin-700-normal.woff2";
import { fontLoader } from "metaplate/font-data";
import { createTakumiOg } from "metaplate/takumi";

const og = createTakumiOg({
  alt: (copy: { title: string }) => copy.title,
  fonts: fontLoader([{ name: "Inter", weight: 700, data: inter as ArrayBuffer }]),
  headers: { "Cache-Control": "public, max-age=86400, immutable" },
  etag: true,
  component: (copy) => ({ type: "div", props: { style: { display: "flex", fontFamily: "Inter", fontSize: 64 }, children: copy.title } }),
});

const cards = og.fetchableFrom((request: Request) => ({
  title: decodeURIComponent(new URL(request.url).pathname.slice("/og/".length)) || "home",
}));

export default { fetch: (request: Request) => cards.fetch(request) };
```

A Worker serving one card bundles to about 4.7 MB uncompressed (2.0 MB gzip),
almost all of it Takumi's Wasm. That is far below the Workers script size
limit, which counts only uncompressed size.

**Cache the cards, or use the Paid plan.** In a hosted test on 2026-11-20
(`.planning/research/takumi-spike-2026-11-20.md`), a warm render of a simple
card used about 13 ms of CPU (median; 7–25 ms). The first render in a fresh
isolate used 88–243 ms. The Workers Free plan allows 10 ms of CPU per
request, with
[some flexibility for infrequent overruns](https://developers.cloudflare.com/workers/platform/limits/)
but not consistent ones. So on the Free plan, render each card rarely: serve
it with long-lived `Cache-Control` and an ETag (as above), put it behind the
Cache API, or generate it at build time. On the Paid plan (30 seconds of CPU
by default), uncached rendering fits easily.

## How it differs from Satori

Most plates render the same. A 19-fixture comparison against `metaplate/node`
matched on every fixture with valid input, apart from glyph anti-aliasing.
Takumi lays out like a browser in a few places where Satori does not:

| | Satori (`metaplate/node`, `metaplate/edge`) | Takumi (`metaplate/takumi`) |
| --- | --- | --- |
| `box-sizing` default | `content-box`: `width: 100%` plus padding grows past the canvas | `border-box` |
| A bare `<div>` | Block | Block |
| `<img>` in a flex row | Shrinks to fit | Keeps its size (`min-width: auto`) |
| Emoji in a flex container | One text run | Text and emoji images become separate flex items, so spaces next to emoji collapse |
| Invalid style value | The render fails | The declaration is dropped with a `takumi:` console warning |
| Remote image `src` or CSS `url()` | Fetched by Satori if the host is public; a private, loopback, or `localhost` address or a relative URL fails the render; a failed download (such as a 404) is logged and drawn blank | Never fetched: any URL other than a `data:` URI fails the render, before a request ([Remote images](#remote-images)) |
| Truncated or corrupt image | Draws what decodes | The render fails |
| Arabic marks | Some dots are lost (ة, ق with Noto Sans Arabic) | Drawn |

`renderSvg` returns Takumi's SVG and ignores the `debug` option (Satori's
layout outlines). `takumi-js` writes its own `takumi:` warnings to the console
(for example, for a family no font provides), whether or not a guard is on.

Compare a plate before switching it:

```ts
import { compareImages } from "metaplate/node";

const diff = compareImages(await nodePlate.render(copy), await takumiPlate.render(copy), { threshold: 64 });
```

## Fonts, languages, and emoji

- **`fonts`**: the plate's faces, in order. Text without a `fontFamily`, or
  whose stack names no loaded family, uses the first one, as in Satori.
- **`languageFonts`**: characters no plate font draws are grouped by script as
  Satori groups them and offered to the loader with Satori's language codes
  (`"ko-KR"`, `"ja-JP|zh-CN|zh-TW|zh-HK"` for Han, and so on), so the same
  `fontsourceLanguageFontLoader` or `languageFontLoader` works unchanged.
- **`emoji`**: emoji are drawn from the plate's emoji loader. Takumi itself
  would fetch them from a CDN; this entry never does. The loader receives each
  grapheme as the copy spells it, as under Satori (`1️⃣` and `❤️` with their
  U+FE0F, though Takumi's image names drop it). An emoji the loader has
  no image for is left blank (Satori would draw it from the fonts) and is
  reported by `missingGlyphs`. Without `emoji`, emoji are drawn from the fonts.

## Remote images

**This entry fetches nothing over the network.** Takumi has its own image
fetcher; `metaplate/takumi` switches it off. An `<img src>` or CSS `url()`
(`backgroundImage`, `maskImage`, and so on) must be a `data:` URI or inline
SVG. Any other URL, public or private, absolute or relative, fails the render
before a request is made:

```text
Error: metaplate/takumi does not fetch images: https://example.com/avatar.png. Load remote images with fetchImageLoader from metaplate/image (or remoteImageLoader from metaplate/assets on Node.js) and pass the data URI it returns as src.
```

This is stricter than Satori. Under `metaplate/node` and `metaplate/edge`,
Satori fetches a public `http(s)` URL itself, with no origin allowlist, byte
cap, or cache, and refuses private, loopback, and `localhost` addresses and
relative URLs. A Satori download that fails (a 404, say) is only logged and
leaves the image blank; here nothing is downloaded, so a plate that relied on
Satori fetching a public URL fails until its image goes through a loader.
`@font-face` URLs in a stylesheet are not fetched either; pass fonts through
`fonts` or `languageFonts`.

`metaplate/assets` needs Node, so on Workers load per-page images such as
avatars with [`fetchImageLoader`](rendering.md#edge-runtimes) from
`metaplate/image`, inside an `async` component. It applies the same origin
allowlist, redirect checks, byte cap, and cache as `remoteImageLoader`, through
the Worker's `fetch`.

```ts
import { fetchImageLoader } from "metaplate/image";

const avatars = fetchImageLoader({ origins: ["https://avatars.example.com"] });

const og = createTakumiOg({
  // alt and fonts as above
  component: async (copy: { title: string; userId: string }) => {
    const { src, width, height } = await avatars(`https://avatars.example.com/u/${copy.userId}.png`);
    return { type: "div", props: { style: { display: "flex", gap: 32 }, children: [{ type: "img", props: { src, width, height } }, copy.title] } };
  },
});
```

## Render guards

Every guard except `avoid`, which fails at definition time:

| Guard | How Takumi runs it |
| --- | --- |
| `missingGlyphs` | Characters Takumi's fallback hook receives that no language font covers, and emoji the emoji loader has no image for |
| `overflow`, `safeArea`, `textOverlap` | Boxes from Takumi's `measure()`, through the same checks as Satori's. A transformed element is checked by its transformed box, where Satori uses the box before the transform |
| `fontFallback` | The same element-tree check as Satori's |
| `lineClamp` | The same element-tree check, with Satori's rules. Takumi also ignores `lineClamp` on a flex or grid element, but clamps an `inline-block` element and text in child elements, which Satori does not; the guard reports those too, so a plate that passes clamps on both renderers |
| `blank` | The raw pixels. With `blank` on, `render` paints twice (pixels, then PNG) |
| `avoid` | Not supported: Takumi's layout keeps no React `key` |

Guards that read the layout measure before painting, so an error-level issue
fails the render without the cost of a paint.

## Status

Experimental. Takumi is young, effectively maintained by one person, and
releases often (27 versions in the 90 days to 2026-11-20). Its types already
announce removals for v3. Metaplate pins the version it tests in its lockfile,
and on every update its test suite renders 16 plates (layout, typography,
images, gradients, clamping, overflow, borders, and four sizes) through both
`metaplate/node` and `metaplate/takumi` and fails when any one differs from
Satori by more than its budget.
This entry may change in a minor release while it is experimental.
