# Changelog

All notable changes to Metaplate are documented in this file. The project uses
[Semantic Versioning](https://semver.org/).

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

### Fixed

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

[Unreleased]: https://github.com/lnorton89/metaplate/compare/v0.6.0...HEAD
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
