# Previewing plates with `metaplate preview`

`metaplate preview` serves a local gallery of every image a
[render module](render-cli.md#a-render-module) declares: each page at each
size, rendered on request, with its metadata, its target checks, and
switchable overlays. Save the module, or any local file it imports, and every
open gallery reloads with the new renders. Nothing is written to disk.

```sh
npx metaplate preview og.render.mjs
# metaplate preview of og.render.mjs at http://127.0.0.1:4323/
```

It takes the same module as [`metaplate render`](render-cli.md), so the
gallery shows exactly the set a build would write, and refuses exactly the
routes a build would refuse. Stop it with Ctrl+C.

## What each card shows

- **The image** as the plate renders it, at the plate's own format (PNG, or
  what its `output` encoder produces), checked with `verifyImage` against the
  size it advertises, as `metaplate render` checks a written file.
- **Its metadata**: the path `render` would write, the URL the plate
  publishes (with `basePath` and `origin`), the alt text, size, format, media
  type, and byte count.
- **Target checks**, when `--target` is given: each image against each
  [compatibility profile](compatibility.md), with every issue's message. A
  `--max-file-size` ceiling applies to every image too. As in
  [`metaplate render`](render-cli.md#formats-and-verification), the image URL is
  checked only when it is absolute HTTPS.
- **A failure in place.** A component that throws, an encoder that returns
  the wrong format, or bytes at the wrong size fail that card with the error,
  and the rest of the gallery still renders. A module that cannot be loaded,
  or that breaks the render contract, replaces the gallery with its error
  until it is fixed.

### Satori debug boxes

The **Satori debug boxes** switch swaps the image for the plate's SVG
rendered with Satori's `debug` option: every element's layout box is outlined
in red and every line of text in blue. It is the quickest way to see a
`content-box` root that overflows the canvas, a flex child that collapsed, or
text that wrapped where it should not (see
[Plate constraints](rendering.md#plate-constraints)). The plate is not
changed: the gallery calls `plate.renderSvg(copy, { debug: true })`, which
overrides `satori.debug` for that one call. Plates from `createNodeOg`,
`createEdgeOg`, and their variant views all support it.

### Crop overlays

Each overlay dims what falls outside a centered crop to one platform ratio:

| Overlay | Ratio | What the platform publishes |
| --- | --- | --- |
| Open Graph link share | 1.91:1 | Facebook's [image guidance](https://developers.facebook.com/docs/sharing/webmasters/images/): keep images "as close to 1.91:1 aspect ratio as possible" to show the full image in Feed without cropping. |
| X `summary_large_image` | 2:1 | X's Summary Card with Large Image reference ([archived 2023-12-17](https://web.archive.org/web/20231217021401/https://developer.twitter.com/en/docs/twitter-for-websites/cards/overview/summary-card-with-large-image)): "an aspect ratio of 2:1 with minimum dimensions of 300x157 or maximum of 4096x4096 pixels". |
| Square thumbnail (X `summary`) | 1:1 | X's Summary Card reference ([archived 2024-01-25](https://web.archive.org/web/20240125214107/https://developer.twitter.com/en/docs/twitter-for-websites/cards/overview/summary)): "an aspect ratio of 1:1 with minimum dimensions of 144x144 or maximum of 4096x4096 pixels", "cropped to a square on all platforms". |

These platforms publish the ratio, not where the crop is anchored, so the
overlay assumes the center. Treat it as a guide to the safe area for text and
faces, not as a pixel-exact rendition of any client. On a 1200x630 card the
2:1 overlay trims 15 pixels from the top and bottom and the 1:1 overlay keeps
the middle 630 pixels; a 1080x1080 square variant needs no 1:1 crop at all.

The switches are remembered for the browser tab across reloads.

## Reloading

Node caches ES modules by URL, so the preview loads the module afresh by
importing it under a new query string (`og.render.mjs?metaplate-preview=2`)
on every change. Where Node has
[`module.registerHooks`](https://nodejs.org/api/module.html#moduleregisterhooksoptions)
(22.15 and 23.5 or newer), an in-thread resolve hook carries that query onto
every local `file:` import the module reaches, so editing `plate.mjs` that the
module imports reloads it too, and the preview watches every such file.
Packages under `node_modules` keep their first-loaded instance, so font
loaders and renderer peers stay warm. On older Node versions only the module
file itself reloads, and the page and the terminal say so; restart the
preview after editing an imported file.

Several file events from one save are collapsed into one reload, a save
during a reload queues one more, and open pages reload through a
server-sent event when the new version is ready. Each reload is a fresh
module instance in the same process; the previous ones are not freed until
the preview stops, which is negligible for an editing session.

CommonJS modules (`.cjs`, or a `require` inside the module) are cached by
file name rather than URL, so a `require`d file does not reload; keep plate
code in ES modules while previewing. TypeScript modules load on the same
terms as [`metaplate render`](render-cli.md#loading-typescript-and-jsx).

### Plates written in JSX

Node does not transform JSX, so a `.tsx` render module needs a loader in the
preview's own process. Run the command in-process under
[`tsx`](https://www.npmjs.com/package/tsx), as for
[`metaplate render`](render-cli.md#loading-typescript-and-jsx). This works on
Windows, macOS, and Linux, and saves still reload the gallery, including saves to
files the module imports:

```ts
// scripts/preview-cards.mts
import { runCli } from "metaplate/cli";

process.exit(await runCli(["preview", "src/lib/og/cards.render.tsx"]));
```

```json
{ "scripts": { "cards:preview": "tsx scripts/preview-cards.mts" } }
```

Started without a loader, the preview reports that it cannot load the module, in
the terminal and on the page. The page says to restart under a loader rather
than to save, because no edit to the module can fix a missing loader.

## Command line

```text
metaplate preview [--host HOST] [--port N] [--target TARGET] [--max-file-size BYTES] <module>
```

| Option | Meaning |
| --- | --- |
| `<module>` | The render module, as for `metaplate render`. Relative to the current directory. |
| `--host HOST` | The address to listen on. Default `127.0.0.1`, reachable from this machine only. |
| `--port N` | The port, 0 to 65535. Default `4323`; `0` lets the system pick a free one, printed at start. |
| `--target TARGET` | Checks every image against a [compatibility profile](compatibility.md); repeatable. |
| `--max-file-size BYTES` | Reports every image larger than `BYTES`. |

A busy port is reported with the advice to pass `--port`. The command exits
`1` for an argument error, a module path that does not exist, or a port it
cannot listen on; a module that fails to load is shown in the gallery instead,
so it can be fixed without restarting.

## Security

The gallery renders your own code and shows its errors, so it is meant for
this machine only:

- It listens on `127.0.0.1` by default. Any other `--host` prints a warning:
  the preview has no authentication, and anyone who can reach the port can
  view every rendered image and error message.
- While listening on a loopback address it answers only requests whose
  `Host` header names this machine, so a web page cannot read it through a
  DNS-rebound host name.
- Every value from the module (routes, copy, alt text, URLs, error messages)
  is HTML-escaped. The page runs under a Content Security Policy that allows
  only its own script, stylesheet, images, and event stream, with no inline
  script or style, framing, or form submission. Responses are `no-store`,
  `nosniff`, and same-origin only.
- It accepts only `GET` and `HEAD` and serves nothing from disk: images come
  from the plates, and the page's script and stylesheet are built in.
