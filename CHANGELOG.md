# Changelog

All notable changes to Metaplate are documented in this file. The project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Documentation

- New guides, built from how real projects use Metaplate, with each behavior they
  describe checked against a packed tarball:
  - [Static Next.js sites](docs/static-next-site.md) goes from the first file to
    the post-deploy check, compares the five ways to produce cards, and adds a
    troubleshooting table. A complete
    [example](examples/next-static-site) is type-checked with the other examples.
  - [Card recipes](docs/recipes.md) covers text beside a photograph, photos of any
    shape, logos, long titles, several fonts, brand colors, one card per record, and
    a remote image that may be missing.
  - [Testing your cards](docs/testing.md) says what each check catches, with a unit
    test, an offline audit of a whole export, and a browser test.
  - [Upgrading](docs/upgrading.md) lists each breaking change with what to do, and
    how to compare cards before and after.
  - The [plate reference](docs/plate.md) lists every option and returned member by
    factory. A test fails if a plate gains a member it does not list.
- `verifySocialImage` documents that a plate's relative URLs fail its crawler-ready
  URL check, and the three ways to handle that (#181).
- `metaplate render` documents a JSX recipe that works on Windows, through `runCli`
  under `tsx`, and its error for a `.tsx` module now names that route (#185).
- The plate constraints now say that an inline SVG `<title>` shows as text through
  `createNextOg` only, and add that an `<img>` stretches without `objectFit`, and
  that CSS variables and unloaded fonts are ignored with no error.
- The static hosts guide leads with using a real file extension, and adds Cloudflare
  Workers static assets. Next.js dynamic routes under `output: "export"` are
  documented.

## [0.8.2] - 2026-11-04

### Changed

- The repository moved to [freeknet/metaplate](https://github.com/freeknet/metaplate).
  The package metadata, documentation links, security reporting links, and the
  edge runtime error message now point there; old `lnorton89/metaplate` links
  redirect.

## [0.8.1] - 2026-11-03

### Added

- `metaplate verify --baseline DIR` compares every PNG or JPEG with the file
  at the same relative path in `DIR`, to catch the visual changes a Satori,
  Resvg, font, or metaplate upgrade makes without any code change (#174). A
  card fails when more of its pixels changed than `--max-diff` allows
  (default 0), when it has no baseline, or when a baseline file has no card.
  `--threshold` sets how far a channel may move before a pixel counts as
  changed (by default 0 for PNG, and 16 when either side is a JPEG, so
  re-encoding noise does not count). `--write-diff DIR` writes the baseline,
  the current card, and the changed pixels side by side for each changed
  card, and `--update-baseline` rewrites the baseline after review. See
  [Compare against a baseline](docs/verification.md#compare-against-a-baseline).
- `metaplate/node` exports `compareImages(baseline, current, options)`, the
  same comparison for tests, with `decodeImagePixels` and
  `JPEG_COMPARE_THRESHOLD` (#174). JPEGs are fully decoded without a
  dependency, within a few levels of libjpeg.
- Three layout render guards for every renderer, for failures that stay
  inside the canvas, which `overflow` cannot see (#168):
  - `safeArea` reports text outside the area the centered 2:1 (X) and 1.91:1
    (Open Graph) crops keep, which removes 15px from the top and bottom of
    1200x630, or outside a margin given as `{ level, inset }`;
  - `textOverlap` reports two text boxes that intersect;
  - `avoid: { level, keys, gap }` reports text that comes within `gap` pixels
    of an element whose React `key` is listed, such as a photo.

  Each issue lists the text and its box, plus the safe area, the other text,
  or the avoided element. See
  [Render guards](docs/rendering.md#render-guards).
- `metaplate/node` and `metaplate/edge` export the `SatoriOptions` and
  `SatoriLayoutNode` types that `metaplate/render` already exported, so a
  plate's `satori: { onNodeDetected }` can be typed without a cast to
  Satori's own `SatoriOptions`, which requires `width`, `height`, and
  `fonts` (#168).
- `metaplate verify` accepts directories and globs as well as files (#166).
  A directory stands for every image file below it, limited to `--format`'s
  extensions when given. Globs (`*`, `?`, `**`, `[...]`, `{a,b}`) are
  expanded by metaplate, so `"out/og/*/og-image.jpg"` works from npm scripts
  on Windows, where `cmd.exe` expands nothing. Files are checked in sorted
  order, each once. A directory without images, or a glob that matches
  nothing, is an error. Symbolic links to files count as files; links to
  directories are not followed.
- `metaplate/cli` exports `runCli(args, { stdout, stderr })`, which runs any
  `metaplate` command in-process and resolves to its exit code (#166). It
  leaves `process.exitCode` alone, and concurrent calls keep separate output.
  The `metaplate` binary is unchanged.
- `metaplate verify --require-content` and `verify-url --require-content`
  check JPEG as well as PNG (#164), so cards encoded as JPEG, the format
  [the rendering guide](docs/rendering.md) recommends for photographic
  cards, can be checked after the build. The decoder adds no dependency. It
  supports baseline, extended, and progressive Huffman JPEGs, any chroma
  subsampling, restart markers, grayscale, and Adobe CMYK. It reads the DCT
  coefficients and fails a JPEG only when every 8x8 block of every channel
  holds the same flat value. WebP and GIF still fail with the flag; that
  error now names the plate's `guards: { blank: "error" }` as the check for
  those formats.

### Changed

- The `satori` peer range is now `>=0.38.2 <1` (was `>=0.33.3 <1`) (#165).
  Older releases inside the old range drop content without an error, and no
  render guard can see it:
  - before 0.38.2, `inset` is ignored, so an absolutely positioned overlay
    such as a scrim behind a headline collapses to 0x0;
  - through 0.35.1, text with `color: "transparent"` draws nothing, so
    outline type set with `WebkitTextStroke` disappears;
  - 0.35.2 to 0.37.0 fail on import under Node ESM;
  - before 0.38.2, a fragment is laid out as a box of its own.

  All four were checked on Satori 0.33.5 through 0.63.2. A project on an
  older Satori gets a peer-dependency warning and should upgrade. The
  fragment constraint is gone from the rendering guide.

### Fixed

- `verify-page` reads `twitter:image:type`, `twitter:image:width`, and
  `twitter:image:height`, which Next.js emits from `og.metadata()` for a
  JPEG plate, and checks them against the fetched bytes like the
  `og:image:*` properties (#163). They are reported in `metadata.twitter` as
  `imageType`, `imageWidth`, and `imageHeight`.
- A `verify-page` target no longer reports "No media type is declared, so
  raster compatibility cannot be confirmed" for an image it fetched. Without
  a declared type, the format rule reads the fetched bytes' format, so the
  `universal` target accepts an undeclared PNG or JPEG and `x` rejects an
  undeclared SVG (#163).

## [0.8.0] - 2026-11-01

### Added

- The `languageFonts` plate option (`createSvgOg`, `createNodeOg`,
  `createEdgeOg`) draws scripts the plate's fonts lack, such as Japanese,
  Korean, Chinese, Arabic, Hebrew, Thai, and Devanagari, with fallback fonts
  instead of missing-glyph boxes, offline. `fontsourceLanguageFontLoader`
  from `metaplate/fonts` maps Satori's language codes (`"ja-JP"`,
  `"ar-AR"`, ...) to installed Fontsource packages, reads each package's
  `unicode.json` on first use, and reads only the subset files covering the
  requested characters, each once (a Japanese title reads about 100 KB of an
  84 MB package); several weights per language are supported, failures are
  not memoized, and package resolution uses the same `cwd` and
  `resolvePackage` options and path guards as `fontsourceFontLoader`.
  `languageFontLoader` from the runtime-neutral `metaplate/font-data` takes a
  byte source per language (and optional `unicodeRanges`) for edge runtimes.
  Han characters, which Satori offers to `ja-JP`, `zh-CN`, `zh-TW`, and
  `zh-HK` at once, fall through the configured languages until each
  character is covered. Satori's requests are answered in a fixed order:
  `emoji`, then `languageFonts`, then `satori.loadAdditionalAsset`. See
  [`docs/fonts.md`](docs/fonts.md#other-scripts).
- `metaplate preview <module>` serves a live local gallery of a render
  module: every page at every size, rendered on request and checked with
  `verifyImage`, with its path, published URL, alt text, size, format, bytes,
  and any `--target`/`--max-file-size` findings. Each card can switch to
  Satori's layout debug boxes and to centered 1.91:1 (Open Graph), 2:1 (X
  `summary_large_image`), and 1:1 (X `summary`) crop overlays. Saving the
  module reloads open pages over a server-sent event; on Node 22.15 and 23.5
  or newer a `module.registerHooks` resolve hook reloads the local files it
  imports too, while `node_modules` packages stay loaded. A failing image
  fails only its card, and a module that cannot load is shown in the page
  until it is fixed. It listens on `127.0.0.1:4323` by default (`--host`,
  `--port`, `--port 0` for any free port), warns before listening on any
  other address, answers only loopback `Host` headers while on loopback,
  escapes every module-supplied value, and serves the page under a strict
  Content Security Policy. See [`docs/preview.md`](docs/preview.md).
- `renderSvg(copy, { debug: true })` turns on Satori's `debug` option for
  one render without changing the plate's `satori` options.
- Signed image routes. `signImagePath` and `verifyImageSignature` (from
  `metaplate`) insert and check an HMAC-SHA-256 signature of the URL's
  pathname as one 43-character base64url path segment before the file name,
  through Web Crypto only, so they run in Node 20+, Deno, and
  `metaplate/edge`. Secrets must be at least 32 bytes; pass several, newest
  first, to rotate. Plates from `metaplate/node`, `metaplate/edge`, and
  `metaplate/next`, and their variants, gain `signedMetadata(route, copy,
  keys, options?)`, which signs every Open Graph and X Card image URL, and
  `handlerFrom` and `fetchableFrom` take `{ signed: { secret | secrets,
  status?, url? } }`, which answers a missing or invalid signature with 403
  (or 404) and `Cache-Control: no-store` before the resolver or renderer
  runs. Unsigned routes are unchanged. See
  [`docs/signed-routes.md`](docs/signed-routes.md).
- Plate components may be `async` in `createSvgOg`, `createNodeOg`,
  `createEdgeOg`, and `createNextOg`, so a component can load per-page
  data before returning its element tree; a synchronous component is not
  awaited. The `PlateElement` type names either result.
- `imageAsset` and `imageAssetLoader` in `metaplate/image` embed image
  bytes as a `data:` URI with the intrinsic size Satori uses, in any
  runtime. The format is detected from the bytes and walked structurally, so
  truncated files, HTML error pages, and formats Satori rejects (AVIF, HEIC,
  JPEG XL, TIFF, BMP, ICO) throw with the reason. Only PNG, JPEG, and SVG are
  accepted by default, because the Resvg in `metaplate/node`,
  `metaplate/edge`, and `next/og` draws WebP (and, in `next/og`, GIF)
  as nothing; `formats` opts in. A viewBox-only SVG is sized from its
  `viewBox`, and sources over `maxBytes` (default 4 MiB) are refused.
- New `metaplate/assets` entry: `readImageAsset` and `fileImageLoader`
  read project image files, and `remoteImageLoader` fetches per-page images
  only from a required `origins` allowlist, re-checked on every redirect,
  through the hardened `verify-url` fetcher, with a streaming byte cap and a
  bounded per-URL cache. See
  [Images and assets](docs/rendering.md#images-and-assets).

- Opt-in render guards fail (`"error"`) or report (`"warn"`) a render that
  would ship a broken card. A plate's `guards` option on `createSvgOg`,
  `createNodeOg`, and `createEdgeOg` takes `missingGlyphs` (text no plate font
  covers that the emoji loader and `satori.loadAdditionalAsset` resolved to
  nothing, reported with its segment and Satori language code), `overflow`
  (an element holding text whose laid-out box reaches outside the canvas,
  read through a composed `satori.onNodeDetected`; elements without text may
  bleed), and, on the two raster renderers, `blank` (every pixel one color,
  checked on the raw pixels before encoding). Errors reject the render with a
  `RenderGuardError` listing every issue, exported from `metaplate/render`,
  `metaplate/node`, and `metaplate/edge`; warnings go to `guards.onWarning`,
  or `console.warn` without one. Every guard defaults to `"off"`, which leaves
  Satori's options and every output unchanged, so no existing plate breaks.
  Both Satori hooks behave identically in every release probed, 0.33.3
  through 0.63.2. `createNextOg` rejects `guards`, because `ImageResponse`
  exposes no hooks or pixels, and `createSvgOg` rejects `blank`. `metaplate verify` and `verify-url` gain
  `--require-content`, which decodes PNG files and URLs with `node:zlib` and
  fails one whose every pixel is the same color; other formats fail with the
  flag rather than passing unchecked. See
  [`docs/rendering.md`](docs/rendering.md#render-guards).
- `socialMetaTags` and `socialMetaHtml` accept validated page-level fields:
  `locale` and `alternateLocales` (`og:locale`, `og:locale:alternate`, in
  `language_TERRITORY` form), `article` (`article:published_time`,
  `modified_time`, and `expiration_time` as calendar dates, RFC 3339
  date-times with an offset, or `Date`s, plus `article:author`,
  `article:section`, and `article:tag`; `og:type` then defaults to
  `article`), `pubdate` (Discord's `og:pubdate`, a full RFC 3339 timestamp),
  and `themeColor` (`<meta name="theme-color">`, `#RRGGBB` or `#RRGGBBAA`, the
  accent color Discord reads). They follow the existing page tags, so output
  without them is unchanged; the `socialMetaHtml` key allowlist now admits
  `article:` keys and exactly `theme-color`. `metaplate/next` adds
  `nextPageMetadata` (Next `openGraph` fields plus `og:pubdate` through
  `other`), `nextPageViewport` (`themeColor` for Next's `viewport` export),
  and `NEXT_OPEN_GRAPH_TYPES`. See `docs/metadata.md#page-level-tags`.
- Opt-in cache-busting image URLs. `socialImageMetadata` and `socialImage`
  accept `version`, a token of 1 to 64 URI-unreserved characters appended as
  `?v=<version>` to every image URL they build (default and variants, Open
  Graph and X), and so to `socialMetaTags`, JSON-LD, and Adaptive Cards.
  `socialImageVersion(copy, revision?)` derives an eight-hex-digit token from
  a stable serialization of the copy (32-bit FNV-1a, synchronous and
  runtime-neutral). Plates take `version: "copy"` and a design `revision`
  (valid on its own too, where it feeds `fingerprint()`), and
  `metadata`, `image`, and `artifact` take a per-call `{ version }`; a
  `metaplate render` page may name its own `version`, and the manifest `url`
  carries the token. `socialImagePath`, `sitePath`, and rendered file paths
  never do, and `route`, `basePath`, and `imagePath` still reject queries. See
  [`docs/metadata.md`](docs/metadata.md#versioned-image-urls).
- `metaplate render <module>` renders static social images as a build step.
  The module's default export is `{ plate, pages: [{ route?, copy }] }`, an
  array of those, or a function returning either; a `createNodeOg` or
  `createEdgeOg` plate renders every page at its default size and every
  variant (a `plate.variant(name)` view renders one size), in the plate's own
  output format. Each image is written into `--out` (default `public`) at the
  new `plate.sitePath(route)` (the route plus `imagePath`, without `basePath`
  or `origin`), with percent-escapes decoded, paths that would leave `--out`
  (including through a symbolic link) or collide refused before or during the
  write, and every file read back, hashed, and checked with `verifyImage`. A
  schema-versioned `metaplate-manifest.json` lists each file's path, URL,
  route, variant, size, format, bytes, and SHA-256, and is written only when
  every image succeeded; any failure exits `1`. `--json` prints one report,
  `--concurrency` bounds renders in flight (default 4), and `.ts` modules load
  wherever Node strips types (22.18+ and 23.6+ by default). `RenderJob`,
  `RenderPage`, and `RenderModule` types come from `metaplate/node`. See
  [`docs/render-cli.md`](docs/render-cli.md).
  A run that starts writing deletes the previous run's manifest first, so a
  failed rebuild never leaves a manifest describing files it overwrote, and a
  successful run replaces the manifest atomically (temporary file, then
  rename). `--incremental` reuses an image when its `inputHash` (the SHA-256
  of the Metaplate and renderer peer versions, path, route, variant, the
  plate's `fingerprint()`, and the key-sorted copy) matches the previous
  manifest and the file on disk still matches that manifest's length,
  SHA-256, and `verifyImage`; everything else renders. Manifest entries gain
  `inputHash`, and `--json` report entries gain `reused`.
- `plate.cached(options)` on `metaplate/node` and `metaplate/edge` plates and
  their variant views renders each distinct copy once. Entries are keyed by
  the SHA-256 of the size's `fingerprint()` and the key-sorted copy, served
  with a strong SHA-256 `ETag`, and a matching `If-None-Match` (weak
  comparison, `*` included) is answered `304` for `GET`/`HEAD` and `412`
  otherwise, keeping the 200's caching headers (RFC 9110 sections 13.1.2 and
  15.4.5). Concurrent misses share one render. The default store,
  `memoryRenderCache()`, is an LRU bounded to 32 MiB and 1000 entries; any
  sync or async `{ get, set }` store works, entries are re-hashed on the way
  out, a failing store degrades to rendering (`onStoreError`), `ttl` is
  optional, and two plates with one fingerprint cannot share a store.
  `plate.fingerprint()` exposes the design hash (Metaplate version,
  renderer, `revision`, size, format, font bytes, guard levels, and the source
  text of the definition's functions). The plate `revision` option, which
  needs no `version: "copy"`, names what the fingerprint cannot see, such as
  a helper the component imports. See
  [`docs/rendering.md`](docs/rendering.md#caching-renders).
- `metaplate verify-page <url>` audits a deployed page's social preview. It
  fetches the HTML with the same hardened fetcher as `verify-url` (its own
  `text/html`/`application/xhtml+xml` check and `--max-html-bytes` cap,
  default 4 MiB), extracts `og:image` and its structured properties,
  `twitter:card`/`twitter:image`, and Schema.org JSON-LD `ImageObject` and
  `image` URLs with a linear-time, dependency-free tokenizer, resolves them
  against the final URL and `<base href>`, and verifies each distinct image
  (at most `--max-images`, default 8): bytes, `Content-Type`, declared
  dimensions and type, alt text, http URLs, and `--target` profiles judged
  against the image each consumer picks. `--json` prints
  `{ "schemaVersion": 1, "pages": [...] }`. `verifyRemotePage` and
  `extractPageSocialMetadata` are exported from `metaplate/node`; see
  `docs/verify-page.md`.
- `verify-page` checks crawler access. Each `--target` implies the
  link-preview crawler its platform documents (`Twitterbot`,
  `facebookexternalhit`, `LinkedInBot`, `Discordbot`, `WhatsApp`,
  `Pinterestbot`, `Slackbot-LinkExpanding`), and `--crawler TOKEN` adds any
  product token. robots.txt is read once per origin of the page, the images,
  and their redirects, under RFC 9309 (five redirects, 4xx allows, 5xx
  disallows, 500 KiB parsing limit), and each crawler's rules are evaluated
  for every URL it would fetch; no request is sent with a crawler's user
  agent. A disallow is an error for crawlers documented to obey robots.txt
  and for requested tokens, a warning where the platform does not say, and
  not reported for Slack, which documents that it ignores robots.txt. The
  report gains `robots`; `parseRobotsTxt`, `evaluateRobots`, and
  `SOCIAL_CRAWLERS` are exported from `metaplate/node`.
- `verify-page` warns (`html-limit`) when Open Graph tags start after the
  first 1 MB of HTML, which Meta's crawler does not read, and, under
  `--target whatsapp`, when the `<head>` does not end within 300KB.
- `verify-page` inspects at most 64 image references per page
  (`maxImageReferences`), always including the first `og:image`, its
  `og:image:secure_url`, and `twitter:image`, and parses each fetched image
  once however many tags name it.

- The `verify-page` extractor now reads `<noscript>` as raw text, as browsers do with
  scripting enabled, so an analytics pixel's `<noscript><img></noscript>` in
  the head no longer ends the head and drops every later Open Graph tag. It
  ends the head where the HTML tree builder does (non-whitespace text,
  `</body>`, `</html>`, `</br>`), keeps head elements between `</head>` and
  `<body>`, skips `<template>` contents, closes comments at `--!>`, `<!-->`,
  and `<!--->`, trims only ASCII whitespace, decodes a UTF-16
  `Content-Type` charset as UTF-16, and deduplicates JSON-LD images in linear
  time.
- `metaplate/edge` renders plates to PNG through `@resvg/resvg-wasm` on
  Deno-based edges such as Netlify Edge Functions (hosted-certified on
  2026-11-01), and on other Fetch-shaped runtimes that allow WebAssembly to be
  compiled at run time. It does not run on Cloudflare Workers: Satori's
  bundled HarfBuzz text shaper reads `self.location.href` and compiles its
  Wasm from embedded bytes, and Workers define no `location` and forbid
  run-time Wasm compilation, so every render failed under `wrangler dev`
  (workerd). Every Satori release that exports `satori/layout.wasm` bundles
  that HarfBuzz build and Satori accepts no precompiled HarfBuzz module, so
  `metaplate/edge` rethrows either failure as an error that names the
  limitation (the original error is its `cause`); other errors pass through
  unchanged. Vercel's Edge runtime forbids the same compilation. `createEdgeOg`
  shares `metaplate/node`'s SVG rendering, size variants, dimension checks,
  owned headers, ETags (computed with Web Crypto), `artifact`, `response`,
  `fetchable`, `fetchableFrom`, and `handlerFrom`, and imports no Node
  built-ins. It lays out through `satori/standalone` only and never
  references Satori's default build, so edge bundlers ship one Satori build.
  The caller supplies both Wasm modules, `@resvg/resvg-wasm/index_bg.wasm`
  and `satori/layout.wasm`, through `createEdgeOg({ resvg: { wasm },
  layout: { wasm } })` or `initEdgeRenderer(resvgWasm, { layout })`; the
  first source supplied wins, a failed initialisation is retried on the next
  render, and a missing module fails with an error naming it. A minimal
  esbuild-bundled consumer is 414 KB gzip of JavaScript plus about 1.17 MB
  gzip of Wasm, about 1.6 MB in all. It needs a runtime that compiles Wasm at
  run time, so Cloudflare Workers and Vercel Edge are not supported whatever
  the bundle size. Output is PNG only: `output` encoders are
  rejected because `@resvg/resvg-wasm` has no JPEG or WebP encoder. The entry
  is tested in Node against the Wasm renderer and from the packed tarball.
- `@resvg/resvg-wasm` (`>=2.6.2 <3`) is a new optional peer. `npm install
  metaplate` does not install it, and a missing peer reports
  `npm install @resvg/resvg-wasm`.
- `npm run check:package` now serves two production-server fixtures from the
  packed tarball, alongside the existing Next static export and Astro static
  build. A default-output `next build` started with `next start` on
  127.0.0.1 exposes a per-request `app/[slug]/opengraph-image.tsx` through
  `createNextOg` and an `app/[slug]/og-image.jpg/route.ts` route handler
  through `createNodeOg(...).handlerFrom`, encoded as JPEG with sharp and
  configured with `serverExternalPackages: ["@resvg/resvg-js", "satori"]` as
  [`docs/nextjs.md`](docs/nextjs.md#jpeg-or-webp-cards-in-nextjs) documents. An Astro `output: "server"` build with
  `@astrojs/node` in standalone mode serves a `src/pages/[slug]/og-image.png.ts`
  endpoint whose `GET` is `handlerFrom` and a page emitting
  `socialImageMetadata` tags from the built `dist/server/entry.mjs`. Each
  server is started on a free loopback port, its page and image routes are
  fetched for two slugs and checked for status, media type, cache policy,
  length, format, and dimensions with the packed `verifyImage`, different
  slugs must produce different bytes, and the server's whole process tree is
  stopped on Windows and POSIX even when verification fails.
- `deployment-evidence.json` records the `next-server` and `astro-server`
  routes as `certified-local-contract`, with their runtime boundary (Next.js
  16.3.2–16.x and Astro 7 with `@astrojs/node` 11, on Node.js 24) and
  official upstream references. This is local packed-contract evidence from
  `next start` and the standalone Astro entry; hosted Next and Astro
  deployments are not certified. `verify-deployment-evidence.mjs` validates
  the new optional `officialReferences` and `runtimeBoundary` fields.
- `@astrojs/node` 11.1.9 is a pinned development dependency for the Astro
  server fixture. It is not a dependency or peer of the published package.
- Hosted Vercel certification from a dated production deployment
  (2026-11-01) of the packed 0.8.0 tarball. `vercel-node` moves from
  `certified-local-contract` to `certified`: a Vercel Function on the Node.js
  runtime whose `GET` is `metaplate/node` `handlerFrom`. A new `vercel-next`
  route is `certified` for Next.js 16.4.3 on Vercel, serving a `metaplate/next`
  `[slug]/opengraph-image` and a `metaplate/node` JPEG route handler. Both
  were checked for two slugs with `metaplate verify-url` and a plain GET for
  status, media type, dimensions, response headers, and distinct bytes. A
  `metaplate/edge` Vercel Edge Function was attempted and is recorded as
  `vercel-edge`, `not-supported`: the deploy was rejected because the
  function is 2.13 MB after gzip and the Hobby plan's Edge limit is 1 MB.
  Raw outputs are in `.planning/hosted-evidence/vercel-2026-11-01.json`, and
  the deployed fixtures are in `examples/hosted/vercel/`.
- Hosted Netlify certification from dated production deployments
  (2026-11-01) of the packed 0.8.0 tarball, each to a new Netlify site.
  `netlify-node` moves from `certified-local-contract` to `certified`: a
  Netlify Function (`nodejs24.x`) whose default export is `metaplate/node`
  `handlerFrom` reading `context.params.slug`, with the Linux Resvg binding
  shipped through `external_node_modules` and the Fontsource files through
  `included_files`. A new `netlify-edge` route is `certified` for
  `metaplate/edge` `fetchableFrom` on Netlify Edge Functions, with
  `resvg.wasm`, `layout.wasm`, and the font served as static files and
  fetched as bytes; it is the first hosted edge certification. Both were
  checked for two slugs with `metaplate verify-url`, a plain GET for status
  and headers, distinct bytes, and a decoded check that each image is not
  uniform, added after the edge site's first deploy served blank cards that
  format and size checks accepted. Raw outputs are in
  `.planning/hosted-evidence/netlify-2026-11-01.json`, and the deployed
  fixtures are in `examples/hosted/netlify/`.
- Hosted Deno Deploy certification from the production build of `main` on
  2026-11-01. New `deno-deploy-edge` and `deno-deploy-node` routes are
  `certified`: one app serves `metaplate/edge`, reading both Wasm modules
  from its `node_modules`, and `metaplate/node`, loading the native Resvg
  binding through Deno's Node compatibility. Deno Deploy builds the app from
  GitHub with `examples/hosted/deno-deploy` as the app directory, packs
  metaplate from the checkout in its install step, and installs the app
  against that tarball. Local `deno deploy` uploads stalled on Deno Deploy's
  side and are not used (denoland/deploy_feedback#954). Raw outputs, the build
  log, and the build history are in
  `.planning/hosted-evidence/deno-deploy-2026-11-01.json`.
- The scripts that read `npm pack --json` accept npm 12's output, an object
  keyed by package name, as well as the array older npm prints.
- `verify-deployment-evidence.mjs` now allows a `certified` edge route only
  when its `api` names `metaplate/edge`. The native renderer still cannot be
  certified on an edge runtime.
- X player and app cards. `XCard` (and its `TwitterCard` alias) now also
  accepts `"player"` and `"app"`, and `twitter` options are discriminated by
  card: `card: "player"` requires `player` (`url`, `width`, `height`,
  optional `stream`) and `site` or `siteId`; `card: "app"` requires `app`
  with at least one of `iphone`, `ipad`, or `googleplay` (`id`, optional
  `name` and `url`), optional `country`, and `site`. Both accept a
  `description`. Missing or mismatched payloads fail to compile, and every
  rule from X's card references also throws at runtime: HTTPS-only,
  credential-free player and stream URLs, player dimensions from 1 to 65535,
  a player image of at least 68,600 pixels, non-empty app ids, names, and
  URLs, numeric App Store ids, `://` in app URLs, two-letter country codes,
  and descriptions of at most 200 characters. `socialMetaTags` and
  `socialMetaHtml` append `twitter:description`, then `twitter:player`,
  `twitter:player:width`, `twitter:player:height`, `twitter:player:stream`,
  or `twitter:app:name|id|url:<platform>` per platform followed by
  `twitter:app:country`, after `twitter:creator:id`. `nextTwitterMetadata`
  in `metaplate/next` maps the metadata onto Next's `players` and `app`
  fields and throws for what Next cannot render: a player without `stream`,
  an app `country`, or differing per-platform app names. Summary-card
  metadata and tags are unchanged.
- `socialImageAdaptiveCard(metadata, options)` builds a Microsoft Teams
  Adaptive Card (schema `https://adaptivecards.io/schemas/adaptive-card.json`,
  version 1.6, the highest Teams documents) for bots, Workflows webhooks, and
  message extensions: an `Image` with `altText`, a title `TextBlock`, an
  optional description, and an `Action.OpenUrl` to the page. It enforces the
  documented Teams limits (HTTPS image URL, PNG/JPEG/GIF, at most 1024x1024
  pixels, image under 1 MB when `fileSize` is given, card within the 28 KB
  webhook message limit). `SocialTarget` gains `teams` for
  `socialImageCompatibility` and `--target teams`.
  [`docs/adaptive-cards.md`](docs/adaptive-cards.md) documents what each client reads for an
  ordinary link, which metaplate options feed it, and when an app is needed.
- Open Graph video and audio (`og:video`, `og:audio`, https://ogp.me/#structured).
  `socialImageMetadata` and plate `metadata()` calls accept
  `media: { videos, audio }` (`OpenGraphVideo`, `OpenGraphAudio`) and carry
  them on `metadata.openGraph.videos` and `.audio` in Next's descriptor shape,
  so `openGraph: social.openGraph` passes them to Next's `Metadata`.
  `socialMetaTags` emits each video's `og:video`, `og:video:secure_url`,
  `og:video:type`, `og:video:width`, `og:video:height`, then each audio item's
  `og:audio`, `og:audio:secure_url`, `og:audio:type`, after the `og:image`
  groups and before the `twitter:*` tags, resolving relative URLs against the
  canonical `url` and dropping repeated URLs as it does for images. Absolute
  URLs must be credential-free http(s), `secureUrl` must be absolute https,
  `type` must be a media type, and video dimensions must be integers from 1 to
  65535. `metaplate/next` rejects relative video and audio URLs because Next
  emits them without resolving `metadataBase`. Metadata without `media` is
  unchanged.
- `socialImageJsonLd` and `socialImageJsonLdScript` describe a metadata
  object's Open Graph images as schema.org `ImageObject` JSON-LD, following
  schema.org's ImageObject definition and Google's image metadata guidance:
  `contentUrl`, `url`, `caption` (alt text), `encodingFormat`, and `width` and
  `height` as pixel `QuantitativeValue`s, plus optional `name`, `creditText`,
  `creator`, `copyrightNotice`, `license`, `acquireLicensePage`, and
  `representativeOfPage` from options. One image yields a single node and
  several yield an `@graph`, with a fixed key order. Relative URLs resolve
  against a canonical `url` validated exactly as for `socialMetaTags`. The
  script form, and the exported `serializeJsonLd`, escape `<`, `>`, `&`,
  U+2028, and U+2029 so the payload can never close its `<script>` element.
- `metaplate verify-url <url>` fetches a deployed image and runs the same size,
  format, and social-target checks as `verify`, plus a check that the response
  `Content-Type` matches the bytes. It reports the final URL after redirects
  and the byte count, in human output and in `--json` (`urls` entries). The
  fetcher refuses non-http(s) schemes, non-default ports unless allowed with
  `--allow-port`, URLs with user information, and any hostname that resolves
  to a loopback, private, link-local, unique-local, unspecified, multicast, or
  IPv4-mapped address unless `--allow-private` is passed for local
  development. It connects to the address it checked, so DNS rebinding cannot
  move the request, re-checks every redirect hop (at most 3 by default), caps
  the body at 16 MiB while streaming, bounds the fetch with total and
  per-connection timeouts, and sends no cookies or credentials.
- `metaplate/node` exports the fetcher as `fetchRemoteImage` and
  `verifyRemoteImage`, with `RemoteImageError` carrying a stable `code` for
  each refusal.
- Size variants: a plate definition can declare `variants`, such as
  `{ square: { size: { width: 1080, height: 1080 } } }`, beside its default
  `size`, and every renderer (`createSvgOg`, `createNodeOg`, `createEdgeOg`,
  `createNextOg`) passes the component a second argument, `{ variant, size }`,
  so each size is laid out rather than cropped. One-argument components are
  unaffected.
- `plate.variant(name)` returns the same plate bound to one variant, with the
  full plate surface (`render`, `renderSvg`, `renderPixels`, `response`,
  `handler`, `handlerFrom`, `fetchable`, `fetchableFrom`, `artifact`, `image`,
  `metadata`, `size`, `contentType`; `metaplate/edge` omits `handler`);
  `plate.variants` lists the declared names and `plate.variantName` names the
  view. Variant names are inferred from the definition when no type arguments
  are given.
- A variant's `imagePath` defaults to the plate's with `-<name>` inserted
  before the extension (`og-image.png` to `og-image-square.png`), exported as
  `variantImagePath` from `metaplate`; per-variant `imagePath` and `alt`
  override it. Colliding paths and invalid names or sizes fail at definition.
- `socialImageMetadata` accepts `variants` and `twitter.variant`, and a
  variant plate's `metadata` emits one `og:image` per size, default first.
  `twitter:image` stays the default unless `twitter.variant` selects another.
  Plates without variants produce byte-for-byte the same metadata as 0.7.0.
- `PlateContext`, `PlateVariant`, `PlateVariants`, `PlateView`, and
  `PlateMetadataOptions` types from `metaplate/render`, `metaplate/node`,
  `metaplate/edge`, and `metaplate/next`, and `SocialImageVariantOptions` from
  `metaplate`.
- Package verification now builds and serves a SvelteKit 3 app from the exact
  packed artifact. The fixture syncs route types, typechecks the documented
  `+server` route ([`docs/rendering.md`](docs/rendering.md)) against the generated `RequestHandler`, builds it with
  `adapter-node`, starts the adapter's server on an ephemeral port, checks the
  page's social metadata, and verifies the PNG bytes, dimensions, headers, and
  per-slug output of a dynamic `handlerFrom` `GET` route. The route is recorded
  as the `sveltekit-node` local contract in `deployment-evidence.json`.
  SvelteKit 3.1.1 depends on `cookie` 2, so the Cookie advisory that deferred
  this fixture is gone from the tree. The new dev dependencies are
  `@sveltejs/kit` 3.1.1, `@sveltejs/adapter-node` 6.0.1,
  `@sveltejs/vite-plugin-svelte` 7.3.1, and `svelte` 5.57.3; they add one
  low-severity advisory, `deepmerge` GHSA-gcqx-w48m-w2h4, under the release
  audit's high threshold.
- The root entry exports `socialMetaTags(metadata, options?)` and
  `socialMetaHtml(metadata, options?)`, a framework-neutral serializer for
  `SocialImageMetadata`. `socialMetaTags` returns an ordered, deduplicated
  array of `{ property | name, content }` objects that React Router `meta`,
  Next.js `other`, and Astro or Svelte templates consume without string
  handling; `socialMetaHtml` renders the same tags as escaped `<meta>`
  elements, one per line. Optional `title`, `description`, `url`, `siteName`,
  and `type` add page-level Open Graph tags, and a canonical `url` resolves
  relative image URLs. The tag order, escaping, and the guarantee that the
  HTML contains only `<meta>` elements are documented and tested. This closes
  the page-level serializer deferred in 0.7.0.
- `scripts/package/verify-runtime.mjs`, a runtime-neutral smoke of the built package.
  It imports `metaplate` alone and produces metadata, then imports
  `metaplate/render`, `metaplate/node`, `metaplate/fonts`, and
  `metaplate/image`, loads Inter through `fontsourceFontLoader`, renders a
  1200x630 SVG through Satori, rasterizes it through native Resvg with
  `createNodeOg(...).artifact`, serves it through `handlerFrom`, and checks the
  PNG with `verifyImage`. Every step always runs; a failure exits non-zero
  with a JSON report naming the step. It imports `dist/` by relative path, so
  run `npm run build` first.
- A `runtimes` CI job runs that smoke on Bun (latest 1.x) and Deno 2.x on
  ubuntu-latest, after the same smoke under Node as a control.
- Emoji render as images in `metaplate/render`, `metaplate/node`, and
  `metaplate/edge` through a new `emoji` plate option.
  `packageEmojiLoader("twemoji" | "openmoji" | { package, directory })` from
  `metaplate/fonts` reads SVGs from an emoji package the application installs
  (`@twemoji/svg` or `openmoji`), offline and without a network fetch at
  render time; the runtime-neutral `metaplate/emoji` entry adds
  `emojiLoader(source)` for edge functions that serve the images themselves,
  plus `twemojiName`, `emojiKey`, and `emojiCodepoints`. Files are matched
  ignoring U+FE0F, case, and zero padding, so fully-qualified and unqualified
  copy, ZWJ sequences, skin tones, flags, and keycaps all resolve. Each emoji
  is resolved once per loader; one without an image falls back to the plate's
  fonts, and bytes that are not SVG or PNG are rejected rather than drawn as
  nothing. Metaplate ships no emoji images and adds no dependency. See
  [docs/emoji.md](docs/emoji.md) for sources and attribution duties.
- `socialImageCompatibility` and `metaplate verify --target` add the
  `whatsapp`, `bluesky`, `telegram`, `threads`, and `pinterest` profiles,
  each limited to what the platform's own documentation states. `whatsapp`
  requires an absolute `og:image` URL and an image under 600KB, at least
  300px wide, and no wider than 4:1, the documented conditions for WhatsApp's
  large link preview. `bluesky` warns above the 1,000,000-byte limit the
  `app.bsky.embed.external` lexicon sets on the card thumbnail blob a posting
  client uploads. Telegram, Threads, and Pinterest publish no link-preview
  image contract, so those profiles report `unknown`, as `instagram` does.
  `SocialTarget` includes the new names.
- `metaplate/fonts` and `metaplate/font-data` export the `FontFace` type, the
  base shape shared by `DataFont`, `FileFont`, `PackageFont`, and
  `FontsourceFont`. Consumers that emit declarations referring to a font
  descriptor could previously hit TS2742 because the type had no public name.

### Changed

- Built files keep the `node:` prefix on Node built-in imports (`node:crypto`,
  `node:http`, ...). tsup 9 strips it by default, which lets a bundler remap a
  bare `crypto` or `http` to a userland shim. The package check now fails if
  any built file imports a bare built-in.
- Development tooling now resolves `minimatch` 11 through an npm override,
  clearing the moderate globparts denial-of-service advisory (fixed in
  11.0.1) that eslint and typescript-eslint pulled in through their 10.x
  ranges. Development-only; the published package has no dependencies.
- The `discord` compatibility profile now checks the image formats Discord's
  published link-preview contract supports (PNG, GIF, JPEG, WebP, and AVIF)
  instead of reporting an unknown contract. Discord sets no image size limit
  and accepts root-relative image URLs, so the profile does not require
  crawler-ready URLs. `socialImageCompatibility` output for `discord` changes
  accordingly; Instagram is still reported as unknown.
- Every font loader now rejects bytes that are not a TrueType, OpenType, WOFF,
  or WOFF2 file with a `TypeError` naming the font and showing the leading
  bytes it received. Satori renders text in an unreadable font as nothing, so
  previously a failed font fetch (an HTML error page, a placeholder, an empty
  body) produced a blank card that a CDN could cache; it now fails the render
  and the memoized loader retries on the next request.
- `Runtime smoke / bun` and `Runtime smoke / deno` are now blocking, required
  checks on `main`, and they run against the packed tarball:
  `scripts/package/prepare-runtime-consumer.mjs` installs it, with the lockfile's peer
  versions, into a clean consumer, and the smoke imports `metaplate` by
  package name and fails unless every entry resolves into that consumer's
  `node_modules`. Bun and Deno are recorded as `certified` for the packed
  package on linux-x64. Deno Deploy is certified separately (`deno-deploy-edge`,
  `deno-deploy-node`); no hosted Bun deployment is certified.
- The packed-package verifier copies a dependency's installed optional
  dependencies with its lockfile-verified closure, so Next's SWC binaries and
  its optional sharp encoder (with sharp's platform binaries) arrive through
  one rule instead of an SWC-specific copy step.
- The tslib `unstableOwnership` disposition's dependency path now names the
  first lockfile path through `@astrojs/node`, which reaches `astro` as a
  peer; the alert, package, version, and reasoning are unchanged.
- Deployment evidence routes may list extra upstream references in
  `relatedDocs`, which the manifest validator requires to be HTTPS URLs.
- The `x` compatibility profile checks X's documented Card image rules:
  JPG, PNG, WEBP, or GIF (SVG is an error), under 5MB, at least 144x144 and
  at most 4096x4096 pixels, and alt text of at most 420 characters. An image
  below `summary_large_image`'s 300x157 minimum is a warning. It previously
  checked only the URL and alt text.
- `metaplate/node`'s renderer-independent code moved into internal modules
  shared with `metaplate/edge`. Its public API, types, and output are
  unchanged.
- The Socket baseline moves from the historical 0.6.0 snapshot to a fresh
  Socket CLI deep score of the published 0.7.0 package, with the importer and
  verifier pins moved to 0.7.0. Both high alerts carry time-bounded
  dispositions: the `string.prototype.codepointat` upgrade signal under Satori,
  and the `unstableOwnership` signal on `tslib@2.9.1`, which the lockfile now
  audits because Socket resolves it through the optional `next` peer.
- The build and type checks now run on TypeScript 6.0, tsup 9, and vitest 5.
  tsup 9 no longer injects the deprecated `baseUrl` option into its
  declaration build, so TypeScript 6 needs no `ignoreDeprecations` escape
  hatch, and vitest 5 clears the `@vitest/mocker` advisory. Both tools declare
  Node 22 as their floor; the Node 20 compatibility job still runs them and
  passes, so Node 20 stays in the matrix on that evidence.
- The `satori` peer range widens from `>=0.33.3 <0.34` to `>=0.33.3 <1`, and
  the audited release moves from 0.33.5 to 0.63.2. Satori's automated releases
  bump a minor version per feature with no breaking changes recorded, so a
  one-minor range forced a peer bump every few days. Satori 0.63 bundles its
  layout engine, so `yoga-layout` leaves the dependency tree.
- The certified React Router resource-route fixture now runs on React Router 8
  and Vite 8, so the support table claims React Router 8 framework mode on
  Node 22.22 or newer. The fixture still fails if React Router emits Vite's
  deprecated `envFile` warning.

### Fixed

- `metaplate/next` imports `next/og.js` instead of `next/og`. Next has no
  exports map, so the extensionless form failed with `ERR_MODULE_NOT_FOUND`
  in plain Node ESM (scripts and test runners that do not bundle), and under
  NodeNext type resolution it either failed or silently became `any`.
- `verifySocialImage` and `metaplate verify-page` compare an SVG with a
  fractional size (`width="98.36"`) in whole pixels instead of throwing an
  integer-size error. A page whose JSON-LD logo was such an SVG failed
  entirely.
- Remote checks (`verify-url`, `verify-page`, `remoteImageLoader`) decode a
  body served with `Content-Encoding: gzip`, `deflate`, or `br` despite the
  `identity` request, as crawlers do, and apply the byte limit to the decoded
  bytes. Any other coding fails with a clear error instead of reading
  compressed bytes as an image or page.
- `connectionTimeoutMs` defaults to `timeoutMs`, so `--timeout` above 10
  seconds also lets one slow connection use the longer budget.
- `metaplate render` refuses an image whose file name has no extension, or
  another format's, because a static host would serve it as the wrong
  `Content-Type`. Before, `og-image` and JPEG bytes in `og.png` were written
  and recorded as verified.
- `metaplate verify` and `verify-url` reject a trailing `--size` or
  `--format` that no file follows, instead of silently ignoring it.
  `metaplate <command> --help` prints that command's usage and exits 0.
- `socialImagePath` percent-encodes a relative path exactly as the
  `origin`-qualified URL does, so spaces, control characters, and non-ASCII
  no longer reach metadata raw.
- Error messages name an empty route as `""` and an emoji directory as an
  emoji directory, not a font file.

### Documentation

- The README is now a short overview: install, a quick start, a one-paragraph
  summary of each guide, and the entry points. The full guides moved verbatim
  into `docs/`: rendering, framework and runtime support, edge runtimes,
  Next.js, size variants, metadata, X player and app cards, compatibility
  profiles, chat previews, Schema.org JSON-LD, fonts, and verification. Static
  hosts joined the deployment guide. The package now ships the whole `docs/`
  directory, so the README's links into `docs/` resolve offline; links to
  `examples/`, `deployment-evidence.json`, and other repository files point
  at GitHub.
- Plate constraints now lead with the `content-box` pitfall: a padded root
  sized to 100% grows past the canvas and can draw a one-line title off the
  image. The README quick start, the size-variants guide, and the Astro,
  Next.js, and size-variants examples set `boxSizing: "border-box"`. In the
  size-variants example the square layout is bottom-aligned, and its title
  rendered entirely below the 1080px canvas.
- Correct the Netlify Edge caveat. The blank cards on the edge site's first
  deploy came from the fixture's layout, not from a first-deploy race on the
  font fetch as first recorded. Satori sizes boxes as content-box, so a card
  100% wide and tall with 64px padding grew past the canvas, and a one-line,
  bottom-aligned title was drawn below it. The Netlify Edge and Cloudflare
  fixtures now set `boxSizing: "border-box"`, and `netlify-edge` was
  redeployed and re-certified with one-line titles.
- Document why image responses are buffered rather than streamed: each
  response carries `Content-Length` and a strong `ETag` from the final bytes,
  which CDNs and the verification tools rely on, and cards are too small for
  streaming to help.
- The support table claims SvelteKit 3 `+server` routes with `adapter-node` 6
  on Node 22.17 or newer. The SvelteKit example now imports from `#lib`,
  because SvelteKit 3 removed `$lib` in favor of `package.json` subpath
  imports, and notes that SvelteKit 3 configures its adapter in
  `vite.config.js`. The deployment guide's matrix lists the route.
- Document that Satori releases before 0.38.2 lay a React fragment out as a
  box of its own, so absolutely positioned children of a fragment anchor to
  that box instead of the positioned parent, while 0.38.2 and newer flatten
  fragments like the DOM. A test pins the current behavior.
- Document using `metaplate/node` inside a Next.js 16 app for JPEG or WebP
  cards: Turbopack cannot bundle Resvg's native binary or Satori's HarfBuzz
  wasm, so both must be listed in `serverExternalPackages`, and a route folder
  named after `imagePath` (`og-image.jpg/`) gives static exports a real file
  extension.

## [0.7.0] - 2026-09-08

### Breaking

- `createNodeOg` now throws a `TypeError` at definition time when `headers`
  contains `Content-Type`, `Content-Length`, or `Content-Encoding`, or contains
  `ETag` while automatic `etag` generation is enabled. Previously a caller
  `Content-Type` was silently overwritten. A custom `output.contentType` must
  now be a syntactically valid media type.
- `socialImageCompatibility` throws a `TypeError` when the descriptor lacks
  `width` or `height`, instead of surfacing the generic image-size error.

### Added

- Provider-neutral `fetchable` and `fetchableFrom` handlers on both
  `createNodeOg` and `createNextOg` for Fetch-style deployments, plus a unified
  Node `artifact(route, copy)` result that keeps encoded bytes, dimensions,
  format, content type, metadata, and optional ETag together.
- `verifySocialImage` and `SocialImageVerificationDescriptor` combine
  structural image-byte validation with metadata agreement and social
  compatibility reports. `metaplate verify` now accepts `--json`, repeatable
  `--target`, `--url`, `--alt`, `--max-file-size`, and `--format gif`;
  `--url` and `--alt` require at least one `--target`.
- `socialImageCompatibility` accepts `SocialCompatibilityImage` descriptors
  with optional `url`/`alt` and new `checkUrl`/`checkAlt` options, and reports
  a LinkedIn 1.91:1 aspect-ratio warning.
- GIF87a/GIF89a structural verification and an `etag: true | "sha256"` option
  that adds deterministic SHA-256 strong ETags to Node responses.

### Changed

- Node responses own and compute `Content-Type` and `Content-Length`, never
  set `Content-Encoding`, and preserve unrelated cache headers.
- Dependency inventory now uses lockfile reachability, nested package identity,
  optional/dev/peer state, and npm's authoritative `hasInstallScript` field.
- Deployment certification and Socket release policy manifests are executable;
  CI evidence reports include verified checks with captured failure output,
  route status, artifact hashes, dependency summaries, toolchain details, and
  commit/version context. The retained bundle is rejected unless every
  required check passed for the same commit and version.
- Dependency inventory controls are observed rather than declared: every
  lockfile package must resolve to the npm registry with a sha512 integrity,
  no package may declare a git, URL, or file dependency, every CI install runs
  with lifecycle scripts disabled, and `hasInstallScript` comes only from the
  lockfile so the inventory is identical on every platform.
- `npm run check:workflows` pins every GitHub Actions reference to a full
  commit SHA, and CI runs `npm audit signatures` so every installed package
  carries a valid registry signature and, where published, a provenance
  attestation.
- Packed deployment fixtures now render two slugs per route and reject
  identical bytes, so `queryOrPathResolved` is observed rather than asserted.

### Fixed

- Correct the Vercel example to consume a Web `Request` and the Netlify example
  to read `params` from the second `context` argument.
- Prevent empty or invalid custom encoder output and implausible custom media
  types from becoming HTTP responses.

## [0.6.0] - 2026-08-24

### Added

- `metaplate verify` now safely verifies SVG root dimensions without XML entity
  expansion, `PackageFont` preserves an optional `lang` tag for Satori font
  selection, and `metaplate --help` / `--version` are successful discovery
  commands.
- `socialImageMetadata` now supports ordered Open Graph image descriptors,
  an independent X image, `summary` or `summary_large_image`, and X
  site/creator names and IDs while preserving the existing shared-image
  default. Override descriptors are copied so later source mutation cannot
  desynchronize the channels.
- Export X-first `XCard` and `XImageOptions` names while retaining
  `TwitterCard` and `TwitterImageOptions` as wire-format-compatible aliases.
  Documentation now maps the Open Graph and X channels to the platforms that
  consume them so the `twitter` metadata key is not mistaken for the only
  supported target.
- `socialImageCompatibility` provides side-effect-free universal, Open Graph,
  Facebook, X, LinkedIn, Slack, Mastodon, Discord, and Instagram profiles with
  explicit error, warning, and unknown verdicts.
- Node and Next plates expose `handlerFrom`, a framework-neutral sync/async
  resolver that forwards every route argument for dynamic copy.
- Font loading now matches how applications already manage assets:
  `fontsourceFontLoader` infers family, subset, and WOFF paths from installed
  Fontsource metadata; `fileFontLoader` reads project-owned files; and the
  runtime-neutral `metaplate/font-data` entry memoizes existing or lazily
  fetched bytes for framework and edge runtimes.

### Changed

- **Breaking:** Satori, Resvg, and React are required peer dependencies again,
  so `npm install metaplate` supplies the complete framework-neutral renderer
  stack without a separate install command. Next remains optional and
  application-supplied. This favors a one-command setup over the smaller
  metadata-only install introduced in 0.2.0.
- **Breaking:** `metaplate/next` now declares Next `>=16.3.2 <17`. The
  previously open-ended `>=15` claim included untested future majors, while
  the remaining Next 15 line fails the release audit through high-severity
  transitive advisories.
- **Breaking:** dimension-changing Resvg `fitTo` settings and all `crop`
  settings are rejected. Set the intended plate `size` instead so rendered
  pixels, metadata, and `plate.size` remain one contract.
- Cap the Satori, Resvg, React, and Next peer ranges at their next breaking
  boundary rather than claiming compatibility with unknown majors.
- Cross-reference every documented framework recipe with the corresponding
  official routing, metadata, static-export, adapter, or response API instead
  of leaving Metaplate's examples disconnected from upstream contracts. The
  pull-request and release templates now require those references for future
  framework-specific changes.
- Centralize renderer plate assembly and route handlers, platform compatibility
  facts, packed-package fixture definitions, and binary image test builders in
  focused modules. A zero-tolerance clone scan now runs in `npm run check` to
  prevent those contracts from drifting back into duplicated call sites.
- Automate the post-publish clean registry install, public export/peer/CLI
  smoke, npm registry-signature verification, and SLSA provenance check. CI
  replays the verifier against the local tarball before it can reach a release.

### Fixed

- Pin the certified React Router 7 fixture to Vite 7.3.6 instead of allowing
  npm to select Vite 8. React Router 7 passes Vite's deprecated `envFile`
  option internally under Vite 8; package verification now rejects that
  warning if the mismatch returns.
- Harden PNG structural validation: unsupported color/bit-depth combinations,
  invalid IHDR methods, oversized zlib windows, invalid indexed palettes, and
  unknown critical chunks now fail verification.
- Validate WebP extended-container animation structure, including canvas-area
  bounds, required animation controls, frame bounds, RIFF padding bytes, and
  lossy VP8 first-partition lengths that overrun their declared chunk payload.
- Reject JPEG frames whose encoded width or height is zero.
- Assert the native renderer's actual width and height before returning pixels
  or encoding output, preventing renderer options or upstream changes from
  desynchronizing advertised metadata.

### Documentation

- Add a Socket badge for the audited published `0.5.0` artifact and record the
  0.6 verifier-hardening audit context.
- Package verification now proves the documented Next adapter through a real,
  network-free static export of the exact packed artifact with lockfile-pinned
  local peers.
- Package verification now also builds a real Astro 7 static endpoint and
  page from the packed artifact, then serves the packed renderer through an
  ephemeral Express 5 server and verifies headers, bytes, and dimensions.
- A React Router 7 framework-mode fixture now generates route types,
  typechecks, builds, serves, and fetches a dynamic resource `loader` from the
  exact packed artifact. SvelteKit remains a documented Node-adapter recipe
  rather than a certified fixture while its stable dependency graph retains
  an upstream Cookie advisory.
- Document Node-versus-edge runtime boundaries, dynamic-route resource and
  SSRF controls, channel-specific metadata, social compatibility profiles,
  and framework certification status.
- Document how Satori's byte requirement differs from framework CSS loaders,
  including `next/font`, and give explicit Fontsource, project-file, and
  framework-provided byte recipes with upstream references.
- Add reviewed, versioned GitHub release notes, a reusable highlights-first
  template, a draft-release workflow, and publish-time validation so a bare
  generated pull-request list cannot become the release landing page again.

## [0.5.0] - 2026-08-24

### Added

- An `origin` option on `socialImage`, `socialImageMetadata`, and every plate
definition, producing crawler-ready absolute image URLs while untouched
relative paths stay the default. `basePath`, route, and `imagePath` compose
beneath it, and the origin must not carry credentials — userinfo such as
`https://user:pass@example.com` is rejected rather than leaked into
crawler-facing metadata ([#56]).
- A `format` form of `output` on `createNodeOg`. The media type derives from
it, the encoded bytes' signature is checked against it on every render, and
the media type is carried into metadata (`og:image:type` / `twitter:image:type`)
and the descriptor `type`. A declared-but-unrecognized format opts out
through `contentType` + `checkSignature: false` ([#51]).
- `--format png|jpeg|webp` on `metaplate verify`, so a `.jpg` file that
actually holds WebP or PNG fails the build check instead of slipping past the
format-agnostic dimension check.

### Changed

- **Breaking:** A plate renders exactly one size. The per-render `size`
override is removed from `render`, `renderSvg`, `renderPixels`, `response`,
and the Next adapter; `plate.size` is both the definition size and the size metadata advertises ([#49]).
- **Breaking:** `output` on `createNodeOg` now takes `format` (deriving
`contentType`) or `contentType` + `checkSignature: false` for unknown
formats; a bare `contentType` is rejected.
- `metaplate verify` reports every failing target and exits non-zero once,
instead of stopping at the first bad file ([#55]).
- Size validation is shared across metadata helpers, plate definitions, and
the CLI: dimensions must be integers from 1 to 65535, and the CLI rejects
numeric overflow to `Infinity` as well as zero ([#53]).

### Fixed

- `packageFontLoader` no longer memoizes a rejected load; a later call after
the package or file is fixed succeeds without recreating the loader ([#52]),
  it accepts a `resolvePackage` hook for installs without a conventional
  `node_modules` layout, such as Yarn Plug'n'Play, and it resolves a relative
  `cwd` once at the public boundary so the runtime resolver never receives a
  relative `createRequire` filename. Package names and font file paths are
  validated so a declaration cannot escape its resolved package directory
  ([#58]).
- `metaplate/render` and `metaplate/node` declare `component` against a local
  `SatoriNode` element-tree type instead of React's `ReactNode`, and their
  public type surfaces ship no React- or Node-dependent declaration:
  `SatoriFont` and `SatoriOptions` are declared structurally and faithfully —
  `SatoriFont.data` is `ArrayBuffer | Uint8Array` rather than Satori's
  `Buffer | ArrayBuffer` so the declaration never names Node's bare `Buffer`
  global (a Node `Buffer` stays assignable as a `Uint8Array`),
  `tailwindConfig` is typed `object` so an upstream `TwConfig` (an interface
  without an index signature) is accepted, and `SatoriNode` carries `bigint`
  like Satori's runtime and React 19's `ReactNode`. A TypeScript consumer can
  author a plain-object plate with no React, @types/react, or @types/node
  installed while still passing an `ArrayBuffer`-backed font, the layout node
  handed to `onNodeDetected`, and an async `loadAdditionalAsset`. The package
  verification compiles a React-free TypeScript consumer exercising those
  fields against the packed package with `skipLibCheck` off, and a second
  consumer that installs no `@types/node` or React types, sets `types: []`,
  and asserts those type packages are absent — so a hidden React or Node
  dependency or a broken mirror is an error ([#59]).
- `metaplate/node` also mirrors `ResvgRenderOptions` structurally instead of
  importing Resvg's Node-dependent declarations, and `renderPixels` explicitly
  returns `RenderedPixels` so its generated declaration exposes `Uint8Array`
  rather than Resvg's narrower `Buffer`. The no-React/no-Node package smoke
  imports both standalone renderer entry points and exercises these types.
- `metaplate verify` is a structural/truncation check, identical through
`metaplate/png` and `metaplate/image`, that rejects truncated files and
obvious header shells even when their dimension header survives: PNG walks
to a non-empty concatenated IDAT stream whose bytes form a zlib envelope — a
deflate CMF/FLG header with room for the Adler-32 trailer — then a
zero-payload IEND (empty IDAT siblings stay legal, but IDAT chunks must remain
consecutive, and zero IHDR dimensions are rejected); JPEG validates the SOF
frame header (8 + 3·Nf bytes) and every SOS segment, parses marker segments
that appear between entropy-coded data (progressive multi-scan files
included) instead of counting them as compressed bytes, and requires each
scan to contain entropy-coded data before another marker ends it; WebP
requires the declared RIFF size to match the bytes, every chunk to stay inside
it, the first chunk to
declare enough payload for every field read (never reading dimensions across
the chunk boundary into RIFF padding), and an extended VP8X container to
carry a `VP8 `/`VP8L`/`ANMF` chunk whose payload is structurally real — the
VP8 key-frame start code, the VP8L `0x2F` signature, or a fully walked ANMF
frame (no nested animation frames, duplicate ALPH/image bitstreams, or
malformed tails) with exactly one nested image bitstream. It is not a full
decode: a file whose headers are intact but whose payload cannot decode is
outside its scope ([#50]).
- `socialImagePath` rejects query strings, fragments, backslashes, ASCII tab
and newline characters (which WHATWG URL parsing strips before
normalization), and literal or percent-encoded `.`/`..` segments — `%2e%2e`,
`.%2e`, `%2e.`, decoded independently per segment so a single malformed
escape cannot disable elsewhere — in `route`, `basePath`, and `imagePath`
instead of silently emitting a URL that normalizes somewhere else ([#57]).
- Release package smokes install only the local Metaplate tarball offline and
  link renderer/tool dependencies from the exact `npm ci` installation after
  checking their versions against `package-lock.json`, so verification never
  executes a newly resolved loose-range peer before the release is packed.

### Documentation

- Static-host guidance derives the `Content-Type` from the plate's output
(JPEG/WebP examples) rather than hard-coding `image/png`, and the description
reflects that `render` may return any consumer-encoded format ([#54]).

[#49]: https://github.com/lnorton89/metaplate/issues/49
[#50]: https://github.com/lnorton89/metaplate/issues/50
[#51]: https://github.com/lnorton89/metaplate/issues/51
[#52]: https://github.com/lnorton89/metaplate/issues/52
[#53]: https://github.com/lnorton89/metaplate/issues/53
[#54]: https://github.com/lnorton89/metaplate/issues/54
[#55]: https://github.com/lnorton89/metaplate/issues/55
[#56]: https://github.com/lnorton89/metaplate/issues/56
[#57]: https://github.com/lnorton89/metaplate/issues/57
[#58]: https://github.com/lnorton89/metaplate/issues/58
[#59]: https://github.com/lnorton89/metaplate/issues/59

## [0.4.1] - 2026-08-24

### Fixed

- Reject an `output.encode` that does not return a `Uint8Array`, naming what it
  returned instead. A plain JavaScript build script — the case the option
  exists for — previously failed later inside `response`, where the error read
  as a defect in Metaplate rather than in the supplied encoder.

## [0.4.0] - 2026-08-24

### Added

- `metaplate/image`, reading dimensions from PNG, JPEG, and WebP headers, and
  `metaplate verify` now covering all three. A card encoded as JPEG or WebP
  through `output` stays inside the build check rather than silently leaving
  it. `metaplate/png` is unchanged for PNG-only checks.
- An `output` option on `createNodeOg` that takes a `contentType` and an
  `encode` function, so a plate can emit JPEG, WebP, or anything else while
  `render`, `response`, and `handler` carry the declared media type. Metaplate
  still ships no image encoder; the pair is declared together so the bytes and
  the media type cannot disagree.

## [0.3.0] - 2026-08-24

### Added

- `renderPixels` on `metaplate/node`, returning the raw RGBA pixmap so a
  consumer can encode a card as JPEG or WebP. A card compositing a photograph
  is several times larger as PNG, and returning the pixmap keeps an image
  encoder out of this package.

### Changed

- Report both renderer peers at once when `metaplate/node` has neither
  installed, rather than naming Satori, then Resvg on the following run.

## [0.2.1] - 2026-08-24

### Documentation

- Record that upgrading to 0.2.0 in place keeps Satori and Resvg on disk,
  because an installed package satisfies the now-optional peer, and that a
  clean reinstall is what reclaims the space. The note ships in the package so
  it reaches the npm page, where an upgrading consumer looks first.

## [0.2.0] - 2026-08-23

### Removed

- **Breaking:** The `ImageResponse` re-export from `metaplate/next`. Import it
  from `next/og` directly. The adapter now resolves `next/og` on first render,
  so the entry point imports in an install without Next and a missing peer
  reports its install command like every other peer.

### Fixed

- Attribute a failed optional-peer import to the package that is actually
  missing. A broken dependency tree inside an installed peer reports the same
  error code, so the install recipe could name a package the consumer already
  had.
- Reject a zero width or height in `metaplate verify --size` rather than
  reporting the mismatch it always produces against the file.

### Changed

- **Breaking:** Move `satori` and `@resvg/resvg-js` to optional peer
  dependencies. Metadata-only and Next.js installs no longer fetch Satori or
  Resvg's native binaries; consumers of `metaplate/render` and `metaplate/node`
  install them explicitly. The renderer resolves both packages on first use, so
  a missing peer reports its install command instead of failing at import.
- Show concise relative paths rather than ambiguous basenames in multi-file
  verifier output.

### Documentation

- Recommend rendering into `public/` and describing the file with
  `socialImageMetadata` for Next.js static exports under a `basePath`, and
  record why `app/opengraph-image.tsx` cannot serve that deployment shape.
- Document `createElement` as the build-script authoring form for projects
  without a JSX toolchain, including Satori's rule that array children need an
  explicit `display`.
- Warn that a page's `openGraph` replaces the layout's under Next's shallow
  metadata merge, and document a single `pageMetadata` composition in the
  README and the Next example — including the per-route `url` and an explicit
  `openGraph.title` — rather than a spread that drops layout-level fields.
- Record the plate constraints that surprise consumers: an inlined SVG
  `<title>` renders as visible text, and the React accessibility rules that ask
  for one do not apply to a plate.

## [0.1.2] - 2026-08-23

### Added

- Support repository and application subpath deployments through `basePath` in
  framework-neutral, Next.js, and standalone metadata helpers.
- Verify mixed PNG dimensions in one CLI invocation by repeating `--size`
  groups.

### Fixed

- Add default package-export conditions so CommonJS-based TypeScript runners
  can resolve every public entry point.

### Documentation

- Document build-time `opengraph-image.tsx` and public-PNG patterns for Next.js
  static exports, including `metadataBase` and a deployment `basePath`.

## [0.1.1] - 2026-08-23

### Fixed

- Make route and image-path slash trimming linear-time, preventing maliciously
  long inputs from causing polynomial regular-expression backtracking.
- Allow cold native PNG initialization enough time on Windows CI runners.

## [0.1.0] - 2026-08-23

### Added

- Framework-neutral Open Graph and Twitter metadata generation.
- Satori-based SVG rendering and Resvg-based PNG rendering for Node.js.
- Fetch API handlers and responses for Astro, SvelteKit, Remix, Express, and
  static build workflows.
- A Next.js `ImageResponse` adapter with predictable route metadata.
- Hoist-safe package font loading with memoized font bytes.
- PNG signature, header, and dimension verification through both the public API
  and the `metaplate verify` CLI.
- Typed package exports for framework-neutral, rendering, Node.js, Next.js,
  font, and PNG entry points.

[Unreleased]: https://github.com/freeknet/metaplate/compare/v0.8.2...HEAD
[0.8.2]: https://github.com/freeknet/metaplate/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/lnorton89/metaplate/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/lnorton89/metaplate/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/lnorton89/metaplate/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/lnorton89/metaplate/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/lnorton89/metaplate/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/lnorton89/metaplate/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/lnorton89/metaplate/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/lnorton89/metaplate/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/lnorton89/metaplate/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/lnorton89/metaplate/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/lnorton89/metaplate/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/lnorton89/metaplate/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/lnorton89/metaplate/releases/tag/v0.1.0
