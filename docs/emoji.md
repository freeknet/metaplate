# Emoji

Satori draws text with the fonts a plate supplies, and text fonts rarely
contain emoji, so `Shipped 🚀` renders as `Shipped` followed by the font's
missing-glyph box. Satori can draw an image in place of a grapheme instead,
through its `loadAdditionalAsset` hook. Metaplate's `emoji` plate option wires
that hook to an emoji set you choose.

Metaplate ships no emoji artwork, adds no dependency, and never fetches from a
third-party CDN on its own. You install the set, or serve it yourself, and you
credit it: the graphics carry their own licenses (see
[Licenses and attribution](#licenses-and-attribution)).

- [Quick start](#quick-start)
- [Choosing a set](#choosing-a-set)
- [Licenses and attribution](#licenses-and-attribution)
- [Edge runtimes](#edge-runtimes)
- [API](#api)
- [How graphemes map to files](#how-graphemes-map-to-files)
- [Fallback and failure behavior](#fallback-and-failure-behavior)
- [Next.js adapter](#nextjs-adapter)

## Quick start

```sh
npm install @twemoji/svg
```

```tsx
import { fontsourceFontLoader, packageEmojiLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

export const plate = createNodeOg({
  alt: (copy: { title: string }) => copy.title,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  emoji: packageEmojiLoader("twemoji"),
  component: (copy) => <div style={{ display: "flex", fontSize: 72 }}>{copy.title}</div>,
});
```

The option works the same way in `createSvgOg` (`metaplate/render`),
`createNodeOg` (`metaplate/node`), and `createEdgeOg` (`metaplate/edge`).
[`examples/api/emoji.ts`](../examples/api/emoji.ts) is a type-checked version of both
the Node and edge setups.

## Choosing a set

`packageEmojiLoader` reads SVG files from an npm package the application
installs, the way `fontsourceFontLoader` reads Fontsource files: resolution
goes through the active runtime (npm, Yarn classic, pnpm, hoisted workspaces),
then an upward `node_modules` walk, and accepts the same `cwd` and
`resolvePackage` options (for Yarn Plug'n'Play).

| Set | `packageEmojiLoader(...)` | Package (verified version) | Files | Graphics license |
| --- | --- | --- | --- | --- |
| Twemoji | `"twemoji"` | [`@twemoji/svg`](https://www.npmjs.com/package/@twemoji/svg) 15.0.0 | 3,720 SVGs at the package root, `1f44b-1f3fd.svg` | CC-BY 4.0 |
| OpenMoji | `"openmoji"` | [`openmoji`](https://www.npmjs.com/package/openmoji) 17.0.0 | 4,495 SVGs in `color/svg`, `1F44B-1F3FD.svg` | CC BY-SA 4.0 |
| Noto Emoji | `{ package, directory }` | none with per-emoji files; vendor [`googlefonts/noto-emoji`](https://github.com/googlefonts/noto-emoji) `2D/svg` | `emoji_u1f44b_1f3fd.svg` | Apache 2.0 |
| Anything else | `{ package, directory }` | your own package | `<hex>[-<hex>…].svg` or `.png` | yours |

Coverage, measured against the 3,953 Unicode emoji in OpenMoji 17's data
file: `openmoji` 17.0.0 has an image for all of them; `@twemoji/svg` 15.0.0
has 3,664 and lacks the 289 added in Emoji 15.1, 16.0, and 17.0. Those fall
back to the plate's fonts (see
[Fallback and failure behavior](#fallback-and-failure-behavior)).

Notes on the packages:

- `@twemoji/svg` is a third-party repackaging (by Samuel Kopp) of the SVGs from
  [jdecked/twemoji](https://github.com/jdecked/twemoji), the maintained
  Twemoji fork. Its `package.json` says `MIT`, which covers the packaging; the
  graphics themselves remain CC-BY 4.0. The official `@twemoji/api` package
  contains no SVG files.
- `openmoji` is 43 MB unpacked (it also ships black-and-white SVGs, sources,
  and tooling). Only `color/svg` is read.
- `@svgmoji/noto` and `@iconify-json/noto` exist on npm but store Noto as
  sprite or JSON bundles keyed by name, not one file per emoji, so they do not
  work with `packageEmojiLoader`. For Noto, copy `2D/svg` from the repository
  into a package or directory of your own and point at it:

  ```ts
  packageEmojiLoader({ package: "@acme/noto-emoji", directory: "svg" });
  // or, for a plain directory:
  packageEmojiLoader({ package: "noto" }, { resolvePackage: () => "/srv/assets/noto" });
  ```

  Noto's flags live under `third_party/region-flags` with region-code names
  rather than code points, so flags fall back unless you rename them.

## Licenses and attribution

Rendering an emoji into a card distributes a copy of that graphic. Each set's
license asks for credit wherever you publish the images; this is your
obligation as the publisher, and Metaplate cannot discharge it for you. This
section summarizes the sets' own guidance and is not legal advice.

- **Twemoji: CC-BY 4.0.** Graphics copyright Twitter, Inc and other
  contributors. The project's README says a credit in your README, an About
  page, or a site footer is enough, for example: "Emoji graphics by
  [Twemoji](https://github.com/jdecked/twemoji), licensed under
  [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)." Twemoji's code
  is MIT, but Metaplate uses none of it.
- **OpenMoji: CC BY-SA 4.0.** The project's README asks for credit in the
  same places and suggests a line naming [OpenMoji](https://openmoji.org/) as
  the designer with a link to
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). ShareAlike applies to adapted material: if your use adapts the graphics,
  the adaptation must be shared under a compatible license. Decide whether
  that fits your cards before choosing OpenMoji.
- **Noto Emoji: Apache 2.0.** The repository states that tools and most
  image resources are Apache 2.0, the emoji fonts are OFL 1.1, and the flag
  images under `third_party/region-flags` are public domain or otherwise
  exempt. Keep the license (and any NOTICE) with your vendored copy and credit
  Google's Noto Emoji.

## Edge runtimes

`metaplate/edge` has no filesystem, so `packageEmojiLoader` is not available
there. Use `emojiLoader` from the runtime-neutral `metaplate/emoji` entry with
a source that returns the image for one emoji. Serving copies of the SVGs
from your own origin keeps rendering independent of a third party:

```ts
import { createEdgeOg } from "metaplate/edge";
import { emojiLoader, twemojiName } from "metaplate/emoji";

const emoji = emojiLoader(async ({ grapheme }) => {
  const response = await fetch(new URL(`/emoji/${twemojiName(grapheme)}.svg`, origin));
  if (response.status === 404) return undefined; // no image: fall back
  if (!response.ok) throw new Error(`Emoji request failed: ${response.status}`); // fail, retry later
  return response.arrayBuffer();
});

const plate = createEdgeOg({ /* ...fonts, component, Wasm modules... */ emoji });
```

Copy the files of `@twemoji/svg` (or jdecked/twemoji's `assets/svg`)
unchanged into the static directory; their names are the `twemojiName` of the
emoji. A source can also return bytes bundled into the function, or an
existing `data:` URI. Fetching a public CDN at render time is possible but
adds a network dependency to every cold render and tells the CDN which emoji
your cards contain; Metaplate never does it by default.

## API

### Plate option

`emoji?: EmojiLoader` on `createSvgOg`, `createNodeOg`, and `createEdgeOg`
definitions. When set, Metaplate supplies Satori's `loadAdditionalAsset`:
emoji go to the loader first; every other language code goes to the
`languageFonts` option when the plate has one (see
[Other scripts](fonts.md#composition-with-emoji-and-loadadditionalasset));
whatever neither resolves, including any emoji the loader has no image for,
goes to `satori.loadAdditionalAsset` when the definition also has one, or is
left to the plate's fonts otherwise.

### `metaplate/fonts` (Node-compatible runtimes)

```ts
type PackageEmojiSet =
  | "twemoji"   // @twemoji/svg, package root
  | "openmoji"  // openmoji, color/svg
  | { package: string; directory?: string };

function packageEmojiLoader(set: PackageEmojiSet, options?: PackageFontOptions): EmojiLoader;
```

Lists the directory once (on the first emoji, not at definition time), then
reads and memoizes each emoji's file on first use. SVG wins over PNG when a
set ships both. `PackageFontOptions` is `{ cwd?, resolvePackage? }`, as for
the font loaders. `EmojiLoader` is re-exported as a type.

### `metaplate/emoji` (runtime-neutral, no Node built-ins)

```ts
type EmojiImage = string | ArrayBuffer | ArrayBufferView;
type EmojiRequest = Readonly<{ grapheme: string; codepoints: readonly number[] }>;
type EmojiSource = (emoji: EmojiRequest) => EmojiImage | undefined | Promise<EmojiImage | undefined>;
type EmojiLoader = (grapheme: string) => Promise<string | undefined>;

function emojiLoader(source: EmojiSource): EmojiLoader;
function twemojiName(grapheme: string): string;          // "👋🏽" -> "1f44b-1f3fd"
function emojiKey(codepoints: readonly number[]): string; // FE0F removed: [0x2764, 0xfe0f] -> "2764"
function emojiCodepoints(grapheme: string): number[];    // "❤️" -> [0x2764, 0xfe0f]
```

A source returns SVG markup, a `data:image/svg+xml` or `data:image/png` URI,
or the bytes of an SVG or PNG file; `undefined` means "no image". The loader
returns a `data:` URI, because Resvg rasterises offline and does not fetch a
remote `href`.

## How graphemes map to files

Satori segments text into grapheme clusters (`Intl.Segmenter`) and asks for an
emoji image only for clusters that its emoji regular expression matches and
that no plate font can draw. A cluster ending in U+FE0F (emoji presentation)
or U+20E3 (keycap) always counts as missing, even when the font has the base
character; a cluster with U+FE0E (text presentation) is never treated as an
emoji unless the character is emoji-presentation by default. Each distinct
cluster is requested once per render: `👋🏽`, `#️⃣`, `🇺🇸`, `🏴󠁧󠁢󠁳󠁣󠁴󠁿`, and
`❤️‍🔥` each arrive whole.

Emoji sets name a cluster's file by its code points in hex, but disagree on the
details, and copy may be fully qualified (`❤️`, U+2764 U+FE0F) or not (`❤`):

| Cluster | Twemoji (`@twemoji/svg`) | OpenMoji | Noto |
| --- | --- | --- | --- |
| `❤️` | `2764.svg` | `2764.svg` | `emoji_u2764.svg` |
| `#️⃣` | `23-20e3.svg` | `0023-FE0F-20E3.svg` | `emoji_u0023_20e3.svg` |
| `❤️‍🔥` | `2764-fe0f-200d-1f525.svg` | `2764-FE0F-200D-1F525.svg` | not checked |
| `👁️‍🗨️` | `1f441-200d-1f5e8.svg` | `1F441-FE0F-200D-1F5E8-FE0F.svg` | not checked |

Twemoji's own parser, which `@vercel/og` (and so `next/og`) copies, removes
U+FE0F from clusters without a zero-width joiner and keeps it in ZWJ
sequences. `twemojiName` implements exactly that rule, for sources that build
URLs. Checked against `@twemoji/svg` 15.0.0, it finds 3,663 of the package's
3,664 standard emoji for fully-qualified input; the exception is `👁️‍🗨️`, whose
file omits the selectors. For unqualified ZWJ input (`❤‍🔥`, typed without
U+FE0F) the rule finds only 2,835, because the file names keep the selector.

`packageEmojiLoader` does not guess a name. It lists the directory once and
indexes every file by `emojiKey`: lowercase hex with every U+FE0F removed, so
case, zero padding, separators (`-` or `_`), and selector placement stop
mattering. No two files in `@twemoji/svg` 15.0.0 or `openmoji` 17.0.0 share a
key, so the index is unambiguous, and every standard emoji either package has
an image for is found from both fully-qualified and unqualified input,
including `👁️‍🗨️`. Noto's names were checked only for single code points and
keycaps; because the key ignores U+FE0F, either spelling of its ZWJ files
works. Skin-tone
modifiers (U+1F3FB–U+1F3FF), regional-indicator pairs, tag sequences, and
keycaps are ordinary code points in the key and need no special handling.

## Fallback and failure behavior

- **No image for an emoji** (the set lacks it, or a source returns
  `undefined`): the render succeeds and Satori draws the cluster with the
  plate's fonts. In practice that is the font's missing-glyph (`.notdef`)
  shape: Inter draws a "NO GLYPH" box. Add a font with the glyph, or a set
  that has the emoji, to change that. The answer is memoized.
- **Not an emoji:** Satori classifies whole words, so a word such as `hi🎉`
  also sends `h` and `i`. Clusters without a pictograph, regional indicator,
  or keycap, and clusters longer than 16 code points, resolve to "no image"
  without calling the source.
- **Already in the font:** characters the plate's font can draw, such as `©`
  in Inter, are drawn as text and never requested; write `©️` (with U+FE0F) to
  ask for the emoji image.
- **Bytes that are not SVG or PNG** (an HTML error page served with status
  200, an empty body): the loader throws a `TypeError` naming the emoji, and
  the render fails, so a CDN never caches a card with a silent hole in it.
- **A source that throws, or a missing package:** the render fails with that
  error (`packageEmojiLoader` lists every directory it searched). Failures are
  not memoized, so the next render retries once the cause is fixed.
- **Memory:** each loader caches at most 4,096 clusters (the full Unicode set
  is under 4,000) and evicts the oldest beyond that, so copy taken from
  requests cannot grow it without bound. Each emoji is embedded in the SVG as
  a `data:` URI, typically a few kilobytes per occurrence.

## Next.js adapter

`metaplate/next` renders through Next's `ImageResponse`, which does not accept
Satori's `loadAdditionalAsset`, so the `emoji` option does not apply there.
`ImageResponse` has its own `emoji` option (`twemoji`, `blobmoji`, `noto`,
`openmoji`, `fluent`, `fluentFlat`), passed through Metaplate's `response`
option; it fetches each image from jsDelivr at render time. Use
`metaplate/node` with `packageEmojiLoader` when renders must not depend on a
third-party network.
