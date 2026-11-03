# Fonts

Loading font bytes for Satori from project files, Fontsource, npm packages, or your own bytes.

[Satori](https://github.com/vercel/satori#fonts) needs the actual bytes of every
rendered face. It reads TTF, OTF, and WOFF, and from
[Satori 0.55.0](https://github.com/vercel/satori/releases/tag/0.55.0) (the
audited 0.63.2 included) also WOFF2; older releases in Metaplate's `satori`
peer range do not, so the Fontsource loaders read the WOFF files, which every
supported release parses. This is separate from a framework's CSS font setup:
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
while selecting WOFF instead of the WOFF2 normally used by browser CSS, so the
same plate works with every Satori release Metaplate supports.

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
workspaces), then falls back to an upward `node_modules` walk.

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

### Font loader reference

Every face is a `FontFace`: `name` (the CSS `fontFamily` the plate uses),
`weight` (100 to 900 in steps of 100), and optional `style` (`"normal"` or
`"italic"`, default `"normal"`) and `lang` (a BCP 47 tag passed to Satori's
font selection). Each `*FontLoader` returns a memoized `() => Promise<LoadedFont[]>`
for a plate's `fonts` option; each `load*` function reads once and returns
the `LoadedFont[]` directly.

| Loader | Reads | Entry |
| --- | --- | --- |
| `fontLoader(fonts)` / `loadFonts(fonts)` | `DataFont`s: a `FontFace` plus `data`, the bytes or a function returning them | `metaplate/fonts`, `metaplate/font-data` |
| `fileFontLoader(fonts, { cwd })` / `loadFileFonts` | `FileFont`s: a `FontFace` plus `file`, a path relative to `cwd` (default `process.cwd()`) or a `file:` URL | `metaplate/fonts` |
| `packageFontLoader(fonts, { cwd, resolvePackage })` / `loadPackageFonts` | `PackageFont`s: a `FontFace` plus `package` and `file`, a path inside that package | `metaplate/fonts` |
| `fontsourceFontLoader(fonts, { cwd, resolvePackage })` / `loadFontsourceFonts` | `FontsourceFont`s: `font` (`inter` or `@fontsource/inter`), and optional `weight` (default 400), `style`, `subset` (default: the package's default subset, normally `latin`), `name` (default: the package's family name), and `lang` | `metaplate/fonts` |

`findPackageDirectory(packageName, cwd, resolvePackage)` returns the directory
the package loaders read from, resolved in the order above. The package
loaders reject a `file` that leaves its package directory, and every loader
rejects bytes that are not a TrueType, OpenType, WOFF, or WOFF2 font.

## Other scripts

A plate's fonts usually cover one or two scripts. Text in any other script,
such as Japanese, Korean, Chinese, Arabic, Hebrew, Thai, or Devanagari,
renders as the font's missing-glyph boxes. Satori can fill the gaps: for each
script no plate font covers, it calls
[`loadAdditionalAsset(languageCode, segment)`](https://github.com/vercel/satori#fonts)
and adds the fonts returned to its fallback list. `@vercel/og` (and so
`next/og`) answers that call by downloading Noto subsets from Google Fonts at
render time, as the
[Satori playground does](https://github.com/vercel/satori/blob/main/playground/utils/font.ts).
Metaplate's `languageFonts` plate option answers it offline, from fonts the
application installs or supplies, so renders stay deterministic and never
depend on a third-party network.

- [Quick start](#quick-start)
- [Language codes](#language-codes)
- [Subset files](#subset-files)
- [Package sizes](#package-sizes)
- [Serverless bundles](#serverless-bundles)
- [Edge runtimes and other byte sources](#edge-runtimes-and-other-byte-sources)
- [Composition with emoji and `loadAdditionalAsset`](#composition-with-emoji-and-loadadditionalasset)
- [Failure behavior](#failure-behavior)
- [Licenses](#licenses)

### Quick start

```sh
npm install @fontsource/noto-sans-jp @fontsource/noto-sans-arabic @fontsource/noto-sans-hebrew
```

```ts
import { fontsourceFontLoader, fontsourceLanguageFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

export const plate = createNodeOg({
  alt: (copy: { title: string }) => copy.title,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  languageFonts: fontsourceLanguageFontLoader({
    "ja-JP": { font: "noto-sans-jp", weight: 700 },
    "ar-AR": { font: "noto-sans-arabic", weight: [400, 700] },
    "he-IL": "noto-sans-hebrew", // weight 400
  }),
  component: (copy) => ({ type: "div", props: { style: { fontFamily: "Inter" }, children: copy.title } }),
});
```

Keep `fontFamily` set to the plate's own font: Satori draws each character
with the first font that has it, so Latin text stays in Inter and only the
characters Inter lacks fall back. The option works the same way in
`createSvgOg` (`metaplate/render`), `createNodeOg` (`metaplate/node`), and
`createEdgeOg` (`metaplate/edge`).
[`examples/api/language-fonts.ts`](https://github.com/lnorton89/metaplate/blob/main/examples/api/language-fonts.ts) is a
type-checked version of the Node and edge setups. `metaplate/next` renders
through `ImageResponse`, which does not take `loadAdditionalAsset`, so the
option does not apply there; `ImageResponse` loads Google Fonts on its own.

```ts
type FontsourceLanguageFont = {
  font: string;                                // "noto-sans-jp" or "@fontsource/noto-sans-jp"
  name?: string;                               // defaults to the package's family
  weight?: FontWeight | readonly FontWeight[]; // defaults to 400
  style?: "normal" | "italic";                 // defaults to "normal"
};

function fontsourceLanguageFontLoader(
  fonts: Partial<Record<LanguageCode, string | FontsourceLanguageFont>>,
  options?: { cwd?: string; resolvePackage?: (name: string) => string | undefined },
): LanguageFontLoader;
```

Packages resolve exactly as for `fontsourceFontLoader` (runtime resolver,
then an upward `node_modules` walk, or your `resolvePackage` hook for Yarn
Plug'n'Play), with the same package-name and path guards. Nothing is read
when the plate is defined; ids and language codes are validated then, so a
typo fails immediately. Several weights load one face each, and Satori draws
each run with the closest one.

### Language codes

The keys are the language codes Satori passes, defined in its
[`language.ts`](https://github.com/vercel/satori/blob/main/src/language.ts)
and unchanged from Satori 0.38.2 (the oldest supported peer) through 0.63:

| Code | Script (Unicode `Script_Extensions`) | Fontsource package |
| --- | --- | --- |
| `ja-JP` | Hiragana, Katakana, Han, U+3000, U+FF00–FFEF | `noto-sans-jp` |
| `ko-KR` | Hangul | `noto-sans-kr` |
| `zh-CN` / `zh-TW` / `zh-HK` | Han | `noto-sans-sc` / `noto-sans-tc` / `noto-sans-hk` |
| `th-TH` | Thai | `noto-sans-thai` |
| `ar-AR` | Arabic | `noto-sans-arabic` |
| `he-IL` | Hebrew | `noto-sans-hebrew` |
| `devanagari` | Devanagari | `noto-sans-devanagari` |
| `bn-IN`, `ta-IN`, `ml-IN`, `te-IN`, `kannada` | Bengali, Tamil, Malayalam, Telugu, Kannada | `noto-sans-bengali`, `-tamil`, `-malayalam`, `-telugu`, `-kannada` |
| `symbol`, `math` | any `\p{Symbol}` or `\p{Math}` character | `noto-sans-symbols` (or `-symbols-2`), `noto-sans-math` |
| `unknown` | everything else, such as Greek or Cyrillic | `noto-sans` |

The packages are the Noto families Satori's playground maps each code to.
Satori sends one more code, `emoji`, which the `emoji` option handles (see
[Emoji](emoji.md)).

A character can belong to several scripts. Satori then sends every match
joined by `|`, in its preference order: a Han character arrives as
`ja-JP|zh-CN|zh-TW|zh-HK`, or with `zh-CN` first inside an element with
`lang="zh-CN"`. Metaplate tries the configured languages in that order and
moves to the next only for characters the earlier fonts do not cover. This
is the gap [Satori issue #367](https://github.com/vercel/satori/issues/367)
describes: `试` is simplified Chinese, but Satori's expression for Han
matches Japanese first, and Noto Sans JP has no glyph for it. Configure
`zh-CN` as well, and `试` falls through to it while `日本` stays Japanese.
Each font is tagged with its language code, so Satori also prefers it for
text inside a matching `lang` element. A font for `unknown` is not tagged,
because Satori rejects `lang` values outside its list.

### Subset files

CJK families are far too large to load whole. Fontsource splits them the way
Google Fonts does: Noto Sans JP 5.3.1 ships 120 numbered slices per weight
(`files/noto-sans-jp-0-700-normal.woff` through `-119-`) plus `cyrillic`,
`latin`, `latin-ext`, and `vietnamese` files, and the package's
`unicode.json` records the CSS
[`unicode-range`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/unicode-range)
of each, keyed `"[0]"` through `"[119]"` for the slices. Browsers use those
ranges to download only the slices a page needs
([Fontsource subsets](https://fontsource.org/docs/getting-started/subsets)).
Metaplate does the same for a segment: it reads `unicode.json` once, picks the
files that contain the segment's characters (reusing a file already picked
before adding another), and reads each picked file once per process. It reads
the WOFF files, not the WOFF2 ones, because Satori before 0.55.0 does not
parse WOFF2. The
all-in-one `japanese`, `korean`, and `chinese-*` subsets listed in
`metadata.json` (1.6 MB for one Japanese weight) are not in `unicode.json`
and are never read.

### Package sizes

Measured from the published Fontsource 5.3 packages, for weight 700 WOFF.
"Typical title" is what a 10–20 character heading in that script read.

| Package | Unpacked package | `unicode.json` files, one weight | Typical title reads |
| --- | --- | --- | --- |
| `noto-sans-jp` | 84 MB | 124 files, 3.5 MB | 6 files, 111 KB |
| `noto-sans-kr` | 52 MB | 124 files, 2.3 MB | 4 files, 42 KB |
| `noto-sans-sc` | 75 MB | 101 files, 3.0 MB | 5 files, 191 KB |
| `noto-sans-tc` | 69 MB | 108 files, 2.8 MB | 6 files, 263 KB |
| `noto-sans-hk` | 86 MB | 109 files, 3.6 MB | 4 files, 167 KB |
| `noto-sans-arabic` | 1.9 MB | 5 files, 116 KB | `arabic`, 79 KB |
| `noto-sans-devanagari` | 1.5 MB | 3 files, 91 KB | `devanagari`, 70 KB |
| `noto-sans-hebrew` | 0.6 MB | 5 files, 33 KB | `hebrew`, 9 KB |
| `noto-sans-thai` | 0.6 MB | 3 files, 31 KB | `thai`, 11 KB |

The unpacked size is mostly the other eight weights, the WOFF2 copies, and
the CSS. Each weight you configure adds its own files. Satori draws text as
SVG paths, so only the glyphs used reach the output, whatever the font size.

### Serverless bundles

Like `fontsourceFontLoader`, this loader reads files at run time, which
bundlers and file tracers cannot see. Include the package's `package.json`,
`metadata.json`, `unicode.json`, `LICENSE`, and the WOFF files of the weights
you use. On Vercel:

```json
{
  "functions": {
    "api/og/*.mjs": {
      "includeFiles": "node_modules/@fontsource/noto-sans-jp/{package.json,metadata.json,unicode.json,LICENSE,files/*-700-normal.woff}"
    }
  }
}
```

In Next.js, list the same paths under
[`outputFileTracingIncludes`](https://nextjs.org/docs/app/api-reference/config/next-config-js/output);
on Netlify, under `included_files` in `[functions]`. Which slices a render
needs depends on the copy, so ship them all for each weight: the glob above
adds about 5 MB for Japanese (it also matches the unused 1.6 MB all-in-one
file), rather than the whole 84 MB package. That fits comfortably within
[Vercel's 250 MB uncompressed function limit](https://vercel.com/docs/functions/limitations)
and Netlify's [function limits](https://docs.netlify.com/build/functions/overview/),
but each CJK weight adds 3–5 MB, so configure only the weights your plates
use. The hosted certifications in [Deployment](deployment.md) cover the same
include mechanism for a Latin font.

### Edge runtimes and other byte sources

`metaplate/edge` has no filesystem. `languageFontLoader` from the
runtime-neutral `metaplate/font-data` entry takes a byte source per language
instead, so the files can come from your own origin, a binding, or an import.
Fontsource exports `unicode.json`, so a bundler can inline it:

```ts
import { languageFontLoader } from "metaplate/font-data";
import japaneseRanges from "@fontsource/noto-sans-jp/unicode.json" with { type: "json" };

const languageFonts = languageFontLoader({
  "ja-JP": {
    name: "Noto Sans JP",
    weight: 700,
    unicodeRanges: japaneseRanges,
    data: async (subset) => {
      const file = `/fonts/noto-sans-jp-${subset}-700-normal.woff`;
      const response = await fetch(new URL(file, origin));
      if (!response.ok) throw new Error(`Font request failed: ${response.status} ${file}`);
      return response.arrayBuffer();
    },
  },
});
```

```ts
type LanguageFontFace = {
  name: string;
  weight?: FontWeight;                    // defaults to 400
  style?: "normal" | "italic";            // defaults to "normal"
  unicodeRanges?: Record<string, string>; // subset id -> CSS unicode-range, as in unicode.json
  data: (subset: string | undefined) => FontBytes | Promise<FontBytes>;
};

function languageFontLoader(
  fonts: Partial<Record<LanguageCode, LanguageFontFace | readonly LanguageFontFace[]>>,
): LanguageFontLoader;
```

With `unicodeRanges`, `data` is called with the id of each subset file a
segment needs (`"12"` for the key `"[12]"`, `"arabic"` for `"arabic"`), once
per file while it succeeds. Without it, `data` is called once with
`undefined` and the bytes are assumed to cover the whole script, which suits
small faces such as Hebrew or Thai. List several faces for several weights.
Copy the WOFF files into your static directory unchanged. Fetching Google
Fonts or a public CDN instead is possible, but adds a network dependency to
every cold render; Metaplate never does it by default.

### Composition with emoji and `loadAdditionalAsset`

When a plate has `emoji`, `languageFonts`, or both, Metaplate supplies
Satori's `loadAdditionalAsset` and offers each request in a fixed order:

1. `emoji`, for the `emoji` code: an image resolves the grapheme.
2. `languageFonts`, for every other code: a non-empty font list resolves the
   segment.
3. `satori.loadAdditionalAsset`, if the definition has one, for anything the
   first two did not resolve.

Without a caller loader, an unresolved segment is drawn with the plate's
fonts, that is, as missing-glyph boxes.

### Failure behavior

- **Unconfigured language:** the loader returns no fonts and reads nothing;
  the request moves on as described above.
- **Characters no configured file covers** (a rare Han character outside
  every slice, for example): those characters are drawn with the plate's
  fonts while the rest of the segment uses the fallback.
- **Missing package, missing file, or bytes that are not a font:** the
  render fails with the error (`Cannot find @fontsource/noto-sans-jp. Looked
  in: ...`), so a CDN never caches a card full of boxes. Failures are not
  memoized; the next render retries once the cause is fixed.
- **A weight or style the package lacks:** fails with the weights and styles
  its `metadata.json` lists.
- **Memory:** a loader keeps the bytes of each file it has read for the life
  of the process, at most every file of the weights you configured. Satori
  keeps its own parsed copy of fallback fonts alongside the plate's fonts.

### Licenses

The Noto families are licensed under the
[SIL Open Font License 1.1](https://openfontlicense.org), as each package's
`metadata.json` and `LICENSE` file state. The OFL allows using, embedding,
and redistributing the fonts, including in commercial work, and images
rendered with them are not covered by it. Shipping the font files in a
serverless bundle or from your origin is redistribution: keep the package's
`LICENSE` file with them (the `includeFiles` glob above does), and do not
sell the fonts by themselves. This summarizes the license and is not legal
advice. Metaplate bundles no font data.
