# Takumi as a second rendering backend: spike results

**Date:** 2026-11-20
**Question:** can `takumi-js` (2.22.1) be metaplate's second rendering backend, so
metaplate can render on Cloudflare Workers, where Satori's bundled HarfBuzz
cannot start (see `examples/hosted/cloudflare/README.md`, `docs/deployment.md`)?
**Scope:** spike only. No `src/` change, no public entry point, no PR.
**Harness:** [`.planning/spikes/005-takumi-backend/`](../spikes/005-takumi-backend/README.md)
(`node .planning/spikes/005-takumi-backend/run.mjs` rebuilds every number below
except the hosted ones, from a fresh temporary consumer).

## Recommendation

**Conditional go** for an *experimental, Workers-targeted* Takumi backend
alongside Satori. **No-go** for replacing Satori as the default renderer.

The renderer is good enough. On metaplate's own `{ type, props }` trees,
Takumi's output matched Satori's on every fixture with a valid input (visually
the same, or close). It drew Arabic more correctly than Satori. It runs
unmodified in production workerd. Its layout tree can feed five of the six
guards. What holds it back is the operating model: one maintainer, very
frequent releases, and a hosted CPU profile that does not fit the Workers Free
plan without caching.

Conditions for the go:

1. **Pin and gate.** `takumi-js` as an optional peer pinned to an exact version.
   Run this spike's parity harness in CI as a test (Satori vs Takumi through
   `compareImages`, with per-fixture budgets), so every Takumi bump shows its
   diffs before it merges. Batch Takumi bumps with the other Dependabot updates.
2. **One adapter file.** Keep everything Takumi-specific (`render`, `measure`,
   `loadFallbackFonts`, `emoji`, `format: "raw"`) behind one internal module, so
   a Takumi v3 or an abandonment is a one-file change, and Satori stays the
   fallback.
3. **Document the semantic differences** listed under
   [Differences that are not noise](#differences-that-are-not-noise), above all
   that Takumi defaults to `box-sizing: border-box`.
4. **Ship guards in two steps.** `missingGlyphs`, `overflow`, `safeArea`,
   `textOverlap` and `blank` first. `avoid` later, because it needs a key
   mapping that Takumi does not provide (see [Guards](#guards)).
5. **Workers guidance requires caching or the Paid plan.** Uncached renders on
   the Free plan sit above the documented 10 ms CPU limit
   (see [Hosted Workers test](#hosted-workers-test)).
6. **No third-party fetches.** Takumi fetches emoji SVGs from jsDelivr by
   default. The adapter must pass `emoji: "from-font"` or hand Takumi the
   plate's own emoji images, to keep metaplate's "never fetches from a
   third-party CDN on its own" rule (docs/emoji.md).

If conditions 1 and 2 are too much upkeep for the value of Workers support, the
alternative is to keep documenting Workers as unsupported and revisit when
Satori's HarfBuzz loading changes.

## 1. Parity run

19 fixtures, each a `{ type, props }` tree rendered twice:

- **Satori:** through `metaplate/node` (`createNodeOg`, Satori 0.63.2 + resvg-js 2.6.2),
  with Inter WOFF in `fonts`, Noto Sans JP and Noto Sans Arabic through
  `fontsourceLanguageFontLoader`, and emoji through `packageEmojiLoader("twemoji")`.
- **Takumi:** through `takumi-js` `render()` from the same tree. Fonts were the same
  Fontsource faces as WOFF2 (the Wasm build cannot read WOFF), the Japanese
  subsets registered with their `unicodeRange`. Emoji were Takumi's twemoji
  mode, with its CDN fetch redirected to the same local `@twemoji/svg` files.

The images were compared with metaplate's `compareImages` (threshold 0, with a
diff image). The same was confirmed through `metaplate verify --baseline
--max-diff 2 --write-diff`, which passed 13 and failed 6 at a 2% budget. The
Takumi **Wasm and native outputs were pixel-identical on all 19 fixtures**
(0 changed pixels), so the Workers build draws exactly what Node draws.

Coverage: fonts and fallback, CJK, Arabic RTL, emoji, PNG/JPEG images,
gradients, `inset` and absolute positioning, `lineClamp`, `textOverflow:
ellipsis`, unclamped overflow, borders/shadows, flex layout with wrap, gap and
rotation, and the 1200x630, 1200x600, 1080x1080 and 1080x1920 sizes.

"Changed" is the share of pixels whose largest channel moved at all;
"Changed >64" uses a 64/255 tolerance, which mostly removes anti-aliasing.

| Fixture | Changed | Changed >64 | Verdict | What differs |
| --- | --- | --- | --- | --- |
| repro-card (Workers example card) | 1.48% | 0.97% | identical to the eye | glyph anti-aliasing, ~1 px baseline |
| block-default (no `display`) | 1.47% | 0.94% | identical to the eye | both engines default a bare div to block |
| typography (400/700, tracking, uppercase, underline) | 1.50% | 0.35% | identical to the eye | anti-aliasing |
| fallback-family (unknown `fontFamily`) | 0.29% | 0% | identical to the eye | both fall back to Inter; Takumi warns, Satori is silent |
| cjk (Japanese + mixed line) | 3.47% | 2.75% | minor diff | same glyphs, lines ~2 px apart in vertical position |
| arabic-rtl | 1.09% | 0.78% | minor diff, **Takumi more correct** | Satori drops dots in line 2: ة draws as ه, ق as ف; Takumi draws them |
| emoji (`Shipped 🚀 🎉 👋🏽`) | 2.09% | 1.63% | minor diff | narrower spaces around emoji in Takumi (see below) |
| missing-glyphs (Korean, no Korean font) | 0.35% | 0% | identical to the eye | both draw Inter's missing-glyph boxes |
| images (PNG + JPEG, radius, `objectFit`) | 17.42% | 1.26% | minor diff | Satori shrinks the 480 px image in the flex row; Takumi keeps 480 px |
| image-truncated-png (`tests/fixtures/card.png`) | n/a | n/a | **broken in Takumi** | Takumi rejects the render ("PNG decoding failed: IDAT … not enough data"); resvg draws what it can |
| gradients (linear + radial) | 6.28% | 0% | identical to the eye | banding: max channel change 46/255 |
| inset-absolute | 1.01% | 0.57% | identical to the eye | anti-aliasing |
| line-clamp (`lineClamp: 2`) | 0.76% | 0.12% | identical to the eye | same break and ellipsis |
| text-overflow-ellipsis | 0.70% | 0.41% | identical to the eye | same truncation point |
| unclamped-overflow (title runs off the card) | 4.52% | 2.33% | minor diff | same 7 lines; line positions drift a few px |
| borders-shadows | 16.13% | 1.80% | minor diff | box 708 px wide in Satori, 700 px in Takumi (box-sizing); softer shadow in Satori |
| flex-layout (space-between, wrap, gap, rotate) | 1.86% | 0.88% | identical to the eye | anti-aliasing |
| size-twitter-1200x600 | 1.61% | 1.07% | identical to the eye | anti-aliasing |
| size-square-1080 | 1.02% | 0.67% | identical to the eye | anti-aliasing |
| size-portrait-1080x1920 | 0.54% | 0.35% | identical to the eye | anti-aliasing |

No fixture is pixel-identical at threshold 0. Glyph rasterisation differs
(resvg paths vs Takumi's own rasteriser) on every image with text.

Diff images and the side-by-side PNGs are generated at
`<tmp>/metaplate-takumi-spike-*/out/` (`diff-wasm/`, `sheet-*.png`). A copy of
this run's evidence is in the session notes folder
`side-session-notes/local_333e17b8-…/takumi-spike-2026-11-20/`.

### Differences that are not noise

- **Box sizing.** Takumi defaults every element to `border-box`. Satori is
  `content-box`. Measured on the same tree with no `boxSizing`: Satori lays the
  root out 1328 px wide and a `width: 700; padding: 20; border: 4` child at
  748 px. Takumi gives 1200 and 700. Plates that never set `boxSizing` change
  geometry, and the overflow guard's "root is larger than the canvas, so … needs
  `boxSizing: "border-box"`" diagnosis never applies on Takumi.
- **Images in flex rows.** Satori shrinks an `<img width={480}>` to fit its row.
  Takumi keeps the intrinsic size, which is closer to browser behaviour
  (`min-width: auto`).
- **Emoji in flex containers.** Takumi's emoji extraction turns a text child
  into a text node plus one image node per emoji. In a flex container each
  becomes its own flex item, so the spaces between them collapse at item edges.
  `measure()` shows "Shipped" and three 80 px image boxes.
- **Image decoding is strict.** A truncated PNG fails the whole render. Satori
  and resvg draw the available rows. This is arguably safer, but it changes the
  failure mode.
- **Invalid style values warn instead of throwing.** Satori (with metaplate's
  defaults) throws on invalid inline styles. Takumi drops the declaration and
  `console.warn`s (`takumi: ignoring invalid value for color …`). Unknown
  properties are dropped silently.
- **Arabic.** Satori lost the dots of ة and ق in `صورة اجتماعية للموقع`. Takumi
  drew them from the same Noto Sans Arabic file. This is a Satori-side defect
  worth reporting on its own.

### Speed in Node (indicative only)

Per fixture: metaplate/node took 148–428 ms (a fresh plate each time, so this
includes font parsing). Takumi Wasm took 8–43 ms after the first render (the
first took 115–138 ms with Wasm instantiation), and native 6–47 ms.

## 2. Guards

What Takumi exposes:

- `measure(tree, options)` returns `MeasuredNode { width, height, transform,
  children, runs }`. `transform` is the full 2D matrix in canvas pixels,
  rotation included. `runs` are text runs `{ text, x, y, width, height }`
  relative to the node.
- It carries **no element type and no key**. Takumi's JSX conversion drops `key`,
  and string children become separate text nodes. Emoji extraction adds image
  nodes too.
- `loadFallbackFonts(characters)` is called with the characters no registered
  font draws. Probe: `["한","국","어","🚀"]` for `"Hello 한국어 🚀 world"` with
  `emoji: "from-font"`.
- `takumi:` warnings go to `console.warn` only: missing glyphs, unknown family,
  invalid values. The structured form (`RenderNeeds.missingCharacters`,
  `unresolvedFamilies`, `ignoredDeclarations`) exists on the binding but not on
  the public `Renderer`.
- `render(..., { format: "raw" })` returns RGBA bytes (1200×630×4 confirmed).

| Guard | Can Takumi implement it? | How, and the catch |
| --- | --- | --- |
| `missingGlyphs` | **Yes** | Wrap `loadFallbackFonts` the way `guardAssetLoader` wraps Satori's `loadAdditionalAsset`: an empty answer for non-empty characters is the issue. Catches: there is no Satori language code (only characters), and in the default twemoji mode emoji become images and never reach the hook. Do not parse `console.warn` (global and not concurrency-safe). |
| `overflow` | **Yes** | Walk `measure()`. A node with `runs` is text-bearing. Its box is the matrix applied to `width × height`, so rotated text gets an axis-aligned box (more accurate than Satori's pre-transform box, but different). `runs` allow a tighter per-line box. The element name needs a parallel walk of the converted node tree. The content-box remedy text must change (see above). |
| `safeArea` | **Yes** | The same boxes into the existing `safeAreaBox()` and `contains()`, unchanged. |
| `textOverlap` | **Yes** | The same boxes into the existing `intersects()`. Per-run boxes could cut false positives between a wrapped paragraph's ragged right edge and a neighbour. |
| `avoid` | **Partly** | Needs React keys, which neither the conversion nor `measure()` keeps. metaplate would have to convert the tree itself, carry keys in a side table (or `id`/attributes), and rely on Takumi preserving child order 1:1. Emoji extraction already breaks 1:1 (one text child becomes several nodes). Feasible but fragile across Takumi releases. Defer, or ask upstream for a node id in `MeasuredNode`. |
| `blank` | **Yes** | `format: "raw"` gives the RGBA that `uniformColor()` already scans. The catch is that metaplate then has to encode the PNG itself: `src/image/png-encode.ts` uses `node:zlib`, so Workers need a `CompressionStream`-based encoder, or a second render. Probe: text placed fully off-canvas leaves a uniform frame. |

Cost: guards that need `measure()` add a layout pass. `Renderer.prepare()` can
share the font and image loading between `measure` and `render`.

New guards Takumi would make possible: unknown font family and dropped style
declarations, if the `needs()` result becomes public. Today they are
warnings only.

## 3. Hosted Workers test

- **Account:** wrangler OAuth login on this desktop (Lawrence ran
  `wrangler login`), account "Lnorton89@gmail.com's Account".
  **Plan: Workers Free** (dashboard → Workers plans shows "Current plan" on Free).
  The jaja-mini-pc session had no Cloudflare login. The other jaja session could
  not check.
- **Worker:** new, separate `metaplate-takumi-spike`, workers.dev only, no routes or
  bindings, with observability enabled. Source:
  `.planning/spikes/005-takumi-backend/worker/`. It is the
  `examples/hosted/cloudflare/worker` card rendered by `takumi-js` (workerd
  import condition → precompiled `.wasm`), with Inter 700 WOFF2 as a Data
  module, `emoji: "from-font"`, and `Cache-Control: no-store`.
- **Bundle:** `Total Upload: 4582.10 KiB / gzip: 2002.04 KiB`, `Worker Startup
  Time: 2 ms`. Cloudflare's current limits page counts only the uncompressed
  bundle (64 MiB on Free and Paid) and states there is no compressed limit, so
  size is not a constraint. The prototype's "under the 3 MB free limit" framing
  is outdated.
- **Verification:** `metaplate verify-url --require-content --size 1200x630
  https://metaplate-takumi-spike.lnorton89.workers.dev/og/Hello` passed (✓
  1200x630, 8704 bytes). Local `wrangler dev --local` also passed.
- **Load:** 32 sequential requests, then 200 at concurrency 4, all `200`.
  The dashboard counted 236 invocations (including one stray `/` request and the
  verify fetches): 0 errors and 0 "Exceeded CPU Time Limits".
- **Deleted** afterwards with `wrangler delete`. The URL now returns 404 and the
  API reports code 10007, "This Worker does not exist".

CPU time per request:

| Source | n | min | p50 | p75 | p90 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `wrangler tail` (per-request `cpuTime`), all | 161 | 7 | 13 | 17 | 23 | 240 | 243 ms |
| tail, sequential requests | 32 | 9 | 20 | 88 | 172 | 243 | 243 ms |
| tail, concurrency 4 | 129 | 7 | 12 | 15 | 21 | 109 | 160 ms |
| Dashboard metrics (all 236) | 236 | | 13.74 | | 95.89 | 179 | P999 202 ms |

The tail sampled 161 of the ~233 requests under load. The dashboard covers all.
Wall time tracked CPU time (dashboard wall P50 15.01 ms), since there are no
subrequests. Memory P50 was 25.7 MB and P99 26.1 MB.

**Cold vs warm.** A request on a fresh isolate (Wasm instantiation, font
registration, first layout) cost 88–243 ms CPU. 12 of the 161 tailed requests
were in that band; the first two requests were 240 and 219 ms. A warm render
cost 7–25 ms, typically 11–14 ms. 120 of 161 tailed requests (75%) used more
than 10 ms.

**Against the Free plan's 10 ms.** Nothing was rejected in this test, even
though most requests exceeded 10 ms. Cloudflare documents why: "each isolate
has some built-in flexibility to allow for cases where your Worker
infrequently runs over the configured limit", but a Worker that hits the limit
consistently "will be terminated according to the limit configured"
([limits](https://developers.cloudflare.com/workers/platform/limits/)). An
uncached Takumi card exceeds 10 ms on most requests, so metaplate cannot claim
Free-plan support for uncached rendering. What can be supported:

- **Paid plan** (default limit 30 s CPU): warm renders cost about 0.1% of the
  budget.
- **Free plan with caching:** render once per URL and serve from the Cache API
  or with long-lived `Cache-Control` and ETags (metaplate/edge's `headers` and
  `etag` options, as the Workers example uses), so the render CPU is rare.

## 4. Risks

- **Effectively a single maintainer.** On GitHub (`kane50613/takumi`, 3.2k
  stars, created 2025-06), kane50613 has 3,547 commits. The next human
  contributor has 6. One npm maintainer account publishes the packages.
- **Release churn.** `takumi-js` has 157 versions since 2026-03-26 (the package
  rename; the `@takumi-rs/*` packages predate it): 102 of them 2.x, 49
  pre-releases, 27 in the last 90 days and 3 in the last 7. 2.22.1 was
  published on the day of this spike. For comparison, Satori published 60
  versions in the same 90 days, so a high cadence alone is not unusual here.
  Takumi's API surface moves within 2.x, though.
- **v3 is announced in the types.** Many options are marked "Will be removed in
  v3" (`stylesheets`, `keyframes`, the `OutputFormatOptions` /
  `RenderExtras` / `BackendRenderOptions` family, and more), so a breaking
  release is expected.
- **Behaviour drift.** Takumi's defaults differ from `next/og`'s in documented
  ways (its README warns that a bare `<div>` is block, not flex) and in
  undocumented ones found here (border-box, emoji splitting). The parity gate
  (condition 1) is what catches the next drift.
- **Supply chain.** Three packages (`takumi-js`, `@takumi-rs/core` with native
  per-platform binaries, `@takumi-rs/wasm` with a 4.5 MB `.wasm`). Each bump
  needs Socket evidence re-derived like other dependency changes.

## Raw results

- Parity summary JSON: printed by `run.mjs` (`summary.wasm`, `summary.native`).
  This run's copy is `results-wasm.json` / `results-native.json` in the notes
  folder above.
- Hosted per-request rows: `tail-rows.json`. Dashboard screenshots
  (`workers-plan-free.jpg`, `metrics-overview.jpg`,
  `metrics-cpu-percentiles.jpg`) are in the notes folder.
- Versions: metaplate 0.8.4 (npm), satori 0.63.2, @resvg/resvg-js 2.6.2,
  takumi-js / @takumi-rs/core / @takumi-rs/wasm 2.22.1, @fontsource/inter 5.3.0,
  @fontsource/noto-sans-jp 5.3.1, @fontsource/noto-sans-arabic 5.3.0,
  @twemoji/svg 15.0.0, Node 24.22.2, wrangler 4.156.0, compatibility date
  2026-10-01.
