# Changelog

All notable changes to Metaplate are documented in this file. The project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `npm run check:package` now serves two production-server fixtures from the
  packed tarball, alongside the existing Next static export and Astro static
  build. A default-output `next build` started with `next start` on
  127.0.0.1 exposes a per-request `app/[slug]/opengraph-image.tsx` through
  `createNextOg` and an `app/[slug]/og-image.jpg/route.ts` route handler
  through `createNodeOg(...).handlerFrom`, encoded as JPEG with sharp and
  configured with `serverExternalPackages: ["@resvg/resvg-js", "satori"]` as
  the README documents. An Astro `output: "server"` build with
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

### Changed

- The packed-package verifier copies a dependency's installed optional
  dependencies with its lockfile-verified closure, so Next's SWC binaries and
  its optional sharp encoder (with sharp's platform binaries) arrive through
  one rule instead of an SWC-specific copy step.
- The tslib `unstableOwnership` disposition's dependency path now names the
  first lockfile path through `@astrojs/node`, which reaches `astro` as a
  peer; the alert, package, version, and reasoning are unchanged.
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
  `size`, and every renderer (`createSvgOg`, `createNodeOg`, `createNextOg`)
  passes the component a second argument, `{ variant, size }`, so each size is
  laid out rather than cropped. One-argument components are unaffected.
- `plate.variant(name)` returns the same plate bound to one variant, with the
  full plate surface (`render`, `renderSvg`, `renderPixels`, `response`,
  `handler`, `handlerFrom`, `fetchable`, `fetchableFrom`, `artifact`, `image`,
  `metadata`, `size`, `contentType`); `plate.variants` lists the declared names
  and `plate.variantName` names the view. Variant names are inferred from the
  definition when no type arguments are given.
- A variant's `imagePath` defaults to the plate's with `-<name>` inserted
  before the extension (`og-image.png` to `og-image-square.png`), exported as
  `variantImagePath` from `metaplate`; per-variant `imagePath` and `alt`
  override it. Colliding paths and invalid names or sizes fail at definition.
- `socialImageMetadata` accepts `variants` and `twitter.variant`, and a
  variant plate's `metadata` emits one `og:image` per size, default first.
  `twitter:image` stays the default unless `twitter.variant` selects another.
  Plates without variants produce byte-for-byte the same metadata as 0.8.0.
- `PlateContext`, `PlateVariant`, `PlateVariants`, `PlateView`, and
  `PlateMetadataOptions` types from `metaplate/render`, `metaplate/node`, and
  `metaplate/next`, and `SocialImageVariantOptions` from `metaplate`.
- Package verification now builds and serves a SvelteKit 3 app from the exact
  packed artifact. The fixture syncs route types, typechecks the README's
  `+server` route against the generated `RequestHandler`, builds it with
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
- Deployment evidence routes may list extra upstream references in
  `relatedDocs`, which the manifest validator requires to be HTTPS URLs.

### Documentation

- The support table claims SvelteKit 3 `+server` routes with `adapter-node` 6
  on Node 22.17 or newer. The SvelteKit example now imports from `#lib`,
  because SvelteKit 3 removed `$lib` in favor of `package.json` subpath
  imports, and notes that SvelteKit 3 configures its adapter in
  `vite.config.js`. The deployment guide's matrix lists the route.
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
- `scripts/verify-runtime.mjs`, a runtime-neutral smoke of the built package.
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

### Changed

- The README support table no longer groups Deno with edge runtimes. Bun and
  Deno now have their own row, stating what the smoke proves and that
  certification is still in progress; the not-supported row is narrowed to
  Workers and other edge isolates, where the native Resvg binding cannot load.
  `deployment-evidence.json` records Bun and Deno as `documented`, not
  certified.

### Known gaps

- TODO: the `runtimes` jobs run with `continue-on-error: true` and are not
  required status checks, because they have not yet passed on main. Once
  `Runtime smoke / bun` and `Runtime smoke / deno` have passed consistently on
  main, remove `continue-on-error`, add both to the required checks, and only
  then consider a certified status for Bun and Deno.

## [0.8.0] - 2026-10-31

### Added

- `metaplate/fonts` and `metaplate/font-data` export the `FontFace` type, the
  base shape shared by `DataFont`, `FileFont`, `PackageFont`, and
  `FontsourceFont`. Consumers that emit declarations referring to a font
  descriptor could previously hit TS2742 because the type had no public name.

### Changed

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

### Documentation

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

[Unreleased]: https://github.com/lnorton89/metaplate/compare/v0.8.0...HEAD
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
