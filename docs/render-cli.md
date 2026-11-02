# Rendering static files with `metaplate render`

Static generation is the most portable way to deploy social images: render
them during the build, publish them as ordinary `.png` or `.jpg` files, and no
server ever runs Satori or Resvg (see the
[deployment guide](deployment.md#runtime-decision-tree)). `metaplate render`
is that build step. It loads a module you write, renders every page at every
size its plates declare, writes each image where the plate's metadata says it
lives, verifies every file on disk, and writes a manifest of what it wrote.

```sh
npx metaplate render og.render.mjs --out public
```

## A render module

The module's default export names the plates and the pages each one renders:

```js
// og.render.mjs
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

const og = createNodeOg({
  alt: (copy) => copy.title,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  imagePath: "og-image.png",
  variants: { square: { size: { width: 1080, height: 1080 } } },
  component: (copy) => ({
    type: "div",
    props: {
      style: { width: "100%", height: "100%", display: "flex", fontFamily: "Inter", fontSize: 72 },
      children: copy.title,
    },
  }),
});

export default {
  plate: og,
  pages: [
    { copy: { title: "Home" } },
    { route: "/posts/hello", copy: { title: "Hello" } },
  ],
};
```

That writes four files and a manifest:

```text
public/og-image.png
public/og-image-square.png
public/posts/hello/og-image.png
public/posts/hello/og-image-square.png
public/metaplate-manifest.json
```

The contract, in full:

- **The default export** is a *job*, an array of jobs, or a function (sync or
  async) returning either. A function suits pages read from a CMS or the file
  system at build time. A module without a default export is refused.
- **A job** is `{ plate, pages }`. `plate` is a plate from `createNodeOg`
  (`metaplate/node`) or `createEdgeOg` (`metaplate/edge`); `pages` is a
  non-empty array.
- **A page** is `{ route?, copy, version? }`. `copy` is what the plate
  renders, exactly as `plate.artifact(route, copy)` takes it. `route` is the
  page's route as you pass it to `plate.metadata(route, copy)`, and defaults
  to `/`. `version` is an optional cache-busting token for the page's image
  URLs (see [Versioned URLs](#versioned-urls)); an invalid token is refused
  before anything renders.
- **Sizes.** A default plate renders each page at its default size and then
  at every declared variant, in declaration order. A variant view,
  `og.variant("square")`, renders only that size, so one job can add a single
  extra size for a few pages.
- **Several plates** go in one array: `export default [postJob, docsJob]`.

`createSvgOg` (`metaplate/render`) and `createNextOg` (`metaplate/next`)
plates are refused with an error naming the supported factories: neither can
produce the encoded bytes and metadata of an `artifact`. An edge plate renders
once the module has supplied its Wasm modules, through `createEdgeOg` or
`initEdgeRenderer`, exactly as in an edge function.

TypeScript modules can type the export with `RenderJob`, `RenderPage`, and
`RenderModule` from `metaplate/node`, which check each page's copy against
its plate:

```ts
import { createNodeOg, type RenderJob, type RenderModule } from "metaplate/node";

const posts = { plate: og, pages } satisfies RenderJob<Copy>;
export default [posts] satisfies RenderModule;
```

[`examples/render-module.ts`](../examples/render-module.ts) type-checks a
complete module against the sources.

## Where files go

Each image is written at its plate's `sitePath(route)`: the route joined with
that size's `imagePath`, without `basePath` or `origin`. That is the path the
metadata URL resolves to once `--out` is deployed under `basePath`. A plate
with `basePath: "/docs"` and `origin: "https://example.github.io"` advertises
`https://example.github.io/docs/posts/hello/og-image.png` and the file is
written to `public/posts/hello/og-image.png`, which a GitHub Pages project
site serves at exactly that URL. The manifest records both: `path` on disk
and `url` as published.

`sitePath` is part of every plate's surface, so a hand-written build script
can use the same rule:

```ts
og.sitePath("/posts/hello"); // "posts/hello/og-image.png"
og.variant("square").sitePath("/posts/hello"); // "posts/hello/og-image-square.png"
```

Paths are checked before anything renders, and a bad one fails the run:

- **Never outside `--out`.** Routes are already held to the plate's pathname
  rules (no `.` or `..` segments, literal or percent-encoded, no backslashes).
  Percent-escapes are then decoded the way a static host maps a URL onto a
  file (`/caf%C3%A9` is written to `café/`), and a decoded segment that is
  empty, a dot segment, or contains `/` or `\` is refused. Every target must
  resolve inside `--out`; before each write the directory's real path must
  still be inside it, so a symbolic link or junction inside `--out` cannot
  carry a write elsewhere, and an existing symbolic link is never written
  through.
- **Portable names only.** A segment containing `< > : " | ? *` or a control
  character, a Windows device name such as `con` or `nul`, or a name ending in
  a dot or a space is refused on every platform, so one module produces one
  tree on Windows, macOS, and Linux.
- **One image per file.** Two pages or sizes that would write the same file
  are refused, including two paths differing only in case, which collide on
  the default Windows and macOS filesystems.

`--out` is not emptied first; files the run does not write are left alone.

### Versioned URLs

Crawlers cache images by URL, so a card that changes needs a new URL (see
[Versioned image URLs](metadata.md#versioned-image-urls)). A plate created
with `version: "copy"` (and optionally a design `revision`) publishes each
page's image URL with `?v=<token>` derived from its copy, and a page's own
`version` overrides that token for the page:

```js
const og = createNodeOg({ /* ... */ imagePath: "og-image.png", version: "copy", revision: "2" });

export default {
  plate: og,
  pages: [
    { route: "/posts/hello", copy: { title: "Hello" } },
    { route: "/about", copy: { title: "About" }, version: "release-12" },
  ],
};
```

The token changes only the manifest `url`, which is the URL the page's
metadata publishes. The file is written at the same unversioned `path`,
because a static host serves `posts/hello/og-image.png` for any query on that
path:

```json
{
  "path": "posts/hello/og-image.png",
  "url": "/posts/hello/og-image.png?v=1e52226d"
}
```

Render the module with the same plate your pages use for their metadata, so
the manifest and the pages agree on every token.

## Formats and verification

The plate decides the format. A plate with no `output` writes PNG; a plate
with an [`output` encoder](rendering.md#other-output-formats) writes what that
encoder produces, at the plate's `imagePath` (give it the matching
extension).

Every written file is read back from disk and checked. Its SHA-256 must match
the rendered bytes, and `verifyImage` must confirm the format and the exact
dimensions that size advertises. This always runs, with no flag to turn it
off: it walks the image's chunk structure without decoding pixels, which
costs little next to rendering, and a static build has no later point at
which a truncated or mis-sized file would be caught before a crawler sees it.
The one exception is an encoder declared with `checkSignature: false` (a
format Metaplate cannot recognize, such as AVIF): its file is still written
and hashed, but recorded with `"format": null` and `"verified": false`.

To check the files against a platform profile as well, run
[`metaplate verify --target`](verification.md#verify-generated-files) over them.

## Command line

```text
metaplate render [--json] [--out DIR] [--manifest FILE] [--concurrency N] <module>
```

| Option | Meaning |
| --- | --- |
| `<module>` | The render module: `.mjs`, `.js`, `.cjs`, or, where Node strips types, `.ts`, `.mts`, `.cts` (see [Loading TypeScript and JSX](#loading-typescript-and-jsx)). Relative to the current directory. |
| `--out DIR` | The directory the site is published from. Default `public`. Created if missing. |
| `--manifest FILE` | Where to write the manifest. Default `DIR/metaplate-manifest.json`. Pass a path outside `DIR` to keep the manifest out of the published site. |
| `--concurrency N` | Render at most `N` images at once, 1 to 256. Default 4. |
| `--json` | Print one JSON report instead of a line per image. |

Without `--json`, each image prints `✓ <path> <width>x<height> <format> (<bytes>
bytes)` as it is written, each failure prints `✗ <path> render failed:
<reason>` to stderr, and a summary line follows.

**Concurrency.** Satori's layout and Resvg's rasterization both run on the
main JavaScript thread (Metaplate calls Resvg's synchronous `render`), so
within one process they run one at a time whatever the limit. The limit
bounds how many renders are in flight, and so how much image memory is held
at once, while font loading, asynchronous `output` encoders
(sharp runs on its own thread pool), and file writes overlap. Raise it for
modules whose encoders do real work off the main thread; lower it to cap
memory on a small build machine. The manifest and the JSON report list images
in declaration order whatever order renders finish in; the per-image lines
print as each one finishes.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every image rendered, was written inside `--out`, matched its hash and dimensions on disk, and the manifest was written. |
| `1` | Anything else: an argument error (printed with the usage line), a module that cannot be loaded or breaks the contract, a refused path or collision (nothing is rendered), or at least one image that failed to render, write, or verify. |

These match `metaplate verify` and `verify-url`, which also exit `1` for every
failure. When some images fail, the rest are still rendered and written, every
failure is reported, and **no manifest is written**, so a deploy step that
publishes only when the manifest exists never publishes half a build. Files
written before the failure stay in `--out`.

Format, size, and structure checks cannot tell a blank card from a drawn one.
Give the module's plate [render guards](rendering.md#render-guards) set to
`"error"` and a card with text off the canvas, text no font covers, or a
single-color image fails its render here, exits `1`, and keeps the manifest
unwritten.

### Manifest

One entry of the manifest written for
[`examples/render-module.ts`](../examples/render-module.ts):

```json
{
  "schemaVersion": 1,
  "images": [
    {
      "path": "posts/hello-world/og-image-square.png",
      "url": "https://example.github.io/docs/posts/hello-world/og-image-square.png",
      "route": "/posts/hello-world",
      "variant": "square",
      "size": { "width": 1080, "height": 1080 },
      "format": "png",
      "contentType": "image/png",
      "bytes": 8587,
      "sha256": "dd3c394252be391c568ec98a84ebf025f3a10e35a759924537db936b8beaafaa",
      "verified": true
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1`. Fields may be added within a version; removing or changing one bumps it. |
| `path` | The file, relative to `--out`, with `/` separators on every platform. |
| `url` | The image URL the plate's metadata publishes for it, with `basePath`, `origin`, and any `?v=` [version token](#versioned-urls). |
| `route` | The page route, as given (default `/`). |
| `variant` | The variant name, or `null` for the default size. |
| `size` | The width and height the file was verified at. |
| `format` | `png`, `jpeg`, `webp`, `gif`, or `null` for an unrecognizable encoder format. |
| `contentType` | The media type the plate serves the image as. |
| `bytes`, `sha256` | Length and lowercase hex SHA-256 of the file as read back from disk. |
| `verified` | Whether `verifyImage` checked the file (`false` only when `format` is `null`). |

Images appear in declaration order: jobs, then pages, then the default size
before each variant.

### JSON report

`--json` prints `{ "schemaVersion": 1, "out", "manifest", "images" }`, where
`out` and `manifest` are paths relative to the current directory, `manifest` is
`null` when none was written, and each `images` entry is a manifest entry plus
`"valid": true` and an empty `issues` array. A failed image has only its
identity and its issues:

```json
{
  "path": "posts/hello/og-image.png",
  "route": "/posts/hello",
  "variant": null,
  "valid": false,
  "issues": [{ "severity": "error", "message": "Expected 1200x630, received 1080x1080" }]
}
```

A module that cannot be loaded or breaks the contract prints its error to
stderr instead of a report.

## Loading modules

The CLI runs on Node and loads the module with a dynamic
[`import()`](https://nodejs.org/api/esm.html#import-expressions) of the
file's `file:` URL, built with
[`url.pathToFileURL`](https://nodejs.org/api/esm.html#file-urls) as the Node
documentation recommends for importing a path (a Windows drive path is not a
valid specifier). The module is an ordinary ES module: top-level `await`
works, and its own imports, such as `metaplate/node`, resolve from its
location, so keep it inside the project that installs Metaplate. Font loaders
such as `fontsourceFontLoader` resolve packages from the current directory,
so run the command from the project root.

A `.js` module is an ES module when the nearest `package.json` has
`"type": "module"`; otherwise Node decides by
[syntax detection](https://nodejs.org/api/packages.html#syntax-detection),
which is on by default from Node 20.19 and 22.7. `.mjs` is always an ES module
and avoids the question. A CommonJS module (`.cjs`) works too:
[its `module.exports` is the default export](https://nodejs.org/api/esm.html#import-statements).

### Loading TypeScript and JSX

Metaplate adds no TypeScript or JSX compiler. A `.ts` module loads only where
Node itself
[strips types](https://nodejs.org/api/typescript.html#type-stripping), which
depends on the Node version running the CLI:

| Node | `.ts`, `.mts`, `.cts` |
| --- | --- |
| 20 | Not supported: compile the module to `.js`. |
| 22.6 to 22.17 | With `NODE_OPTIONS=--experimental-strip-types`. |
| 22.18+, 23.6+, 24, and later | By default (disabled by `--no-strip-types`). |

Type stripping removes type annotations and does nothing else, so a module
must use only erasable syntax:

- **Type-only imports need `type`**: `import { createNodeOg, type RenderJob }
  from "metaplate/node"`. Without it Node treats the import as a value and
  fails at run time
  ([details](https://nodejs.org/api/typescript.html#importing-types-without-type-keyword)).
  TypeScript's `verbatimModuleSyntax` enforces this.
- **No syntax that needs code generation**: `enum`, namespaces with runtime
  code, parameter properties, and `import x = require()` aliases
  ([details](https://nodejs.org/api/typescript.html#typescript-features)) fail
  with a message naming them; TypeScript's `erasableSyntaxOnly` flags them.
- **Relative imports name the real file**, extension included
  (`./plates.ts`), and `tsconfig.json` (including `paths`) is not read.
- **No `.tsx` or `.jsx`.** Node does not transform JSX in any version.

So a TypeScript module authors its plate with plain `{ type, props }`
objects, as [`examples/render-module.ts`](../examples/render-module.ts) does
(see also
[Authoring without a JSX toolchain](rendering.md#authoring-without-a-jsx-toolchain)).
For a plate written in JSX, either compile the module first (with `tsc`, your
bundler, or your framework's build) and pass the compiled `.js`, or register a
JSX-capable loader for the CLI's process through `NODE_OPTIONS`, for example
`NODE_OPTIONS="--import tsx" npx metaplate render og.render.tsx` with the
[`tsx`](https://www.npmjs.com/package/tsx) package installed. Node never type
checks a module either way, so keep `tsc --noEmit` in the build.
