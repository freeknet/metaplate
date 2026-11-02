# Edge runtimes

Rendering on Deno-based edges with `metaplate/edge` and its WebAssembly renderer, and where it cannot run.
## Edge runtimes with `metaplate/edge`

`metaplate/edge` renders the same plates to PNG through
[`@resvg/resvg-wasm`](https://www.npmjs.com/package/@resvg/resvg-wasm), the
WebAssembly build of the Resvg release behind `@resvg/resvg-js`. It imports no
Node built-ins, so it can run on Deno-based edges where `metaplate/node`
cannot: [Netlify Edge Functions](https://docs.netlify.com/build/edge-functions/overview/),
hosted-certified on 2026-11-01, and [Deno](https://docs.deno.com/runtime/),
which allow WebAssembly to be compiled at run time. `@resvg/resvg-wasm` is an
optional peer that `npm install metaplate` does not add; install it for this
entry:

```sh
npm install @resvg/resvg-wasm
```

**Cloudflare Workers are not supported.** Satori shapes text with a HarfBuzz
build bundled into `satori/standalone`, which compiles its WebAssembly from
embedded bytes on first use and, in a worker-shaped isolate, reads
`self.location.href`. Workers define no `location` and
[accept only pre-compiled Wasm modules](https://developers.cloudflare.com/workers/runtime-apis/webassembly/),
so under `wrangler dev` every render fails, first with
`TypeError: Cannot read properties of undefined (reading 'href')` and, once
`location` exists, with `Wasm code generation disallowed by embedder`. Satori
takes no precompiled HarfBuzz module, and every Satori release that exports
`satori/layout.wasm` (0.35.2 and later) bundles this build, so the caller
cannot work around it; `metaplate/edge` reports either failure as an error
naming this limitation. [Vercel's Edge runtime](https://vercel.com/docs/functions/runtimes/edge)
also forbids compiling Wasm from bytes and is expected to fail the same way
(not observed: its deployment was refused for size first). On those platforms,
use `metaplate/node` on the provider's Node runtime or generate images at
build time. The [Workers reproduction](https://github.com/lnorton89/metaplate/tree/main/examples/hosted/cloudflare)
runs locally with `wrangler dev`.

Every edge plate needs two WebAssembly modules: Resvg's,
`@resvg/resvg-wasm/index_bg.wasm`, and Satori's Yoga layout engine,
`satori/layout.wasm`. `metaplate/edge` lays out through `satori/standalone`
only, never Satori's default build, which embeds its own Yoga copy and would
otherwise ship in the same bundle. Edge runtimes cannot locate a package's
`.wasm` files on their own, so the caller supplies both. A
[Netlify Edge Function](https://docs.netlify.com/build/edge-functions/api/)
has no filesystem, so serve both modules and the font as static files of the
same site and fetch them as bytes on the first render; `fetchableFrom` returns
the `{ fetch }` object the function delegates to:

```ts
// netlify/edge-functions/og.ts
import { createEdgeOg } from "metaplate/edge";
import { fontLoader } from "metaplate/font-data";

type Context = { params: Record<string, string | undefined> };

// public/wasm/resvg.wasm is copied from @resvg/resvg-wasm/index_bg.wasm,
// public/wasm/layout.wasm from satori/layout.wasm, and the font from
// @fontsource/inter, so all three are served by the same site.
let origin = "";

async function asset(path: string): Promise<ArrayBuffer> {
  const response = await fetch(new URL(path, origin));
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.arrayBuffer();
}

const og = createEdgeOg({
  alt: (copy: { title: string }) => `${copy.title} social card`,
  resvg: { wasm: () => asset("/wasm/resvg.wasm") },
  layout: { wasm: () => asset("/wasm/layout.wasm") },
  fonts: fontLoader([
    { name: "Inter", weight: 700, data: () => asset("/fonts/inter-latin-700-normal.woff") },
  ]),
  headers: { "Cache-Control": "public, max-age=86400" },
  component: (copy: { title: string }) => ({
    type: "div",
    props: {
      style: { width: "100%", height: "100%", display: "flex", fontFamily: "Inter", fontSize: 64 },
      children: copy.title,
    },
  }),
});

const route = og.fetchableFrom((request: Request, context: Context) => {
  origin ||= new URL(request.url).origin;
  return { title: (context.params.slug ?? "home").slice(0, 80) };
});

export default (request: Request, context: Context) => route.fetch(request, context);

export const config = { path: "/og/:slug" };
```

npm packages in `node_modules` are imported by name and the Netlify CLI
bundles them. The audited Satori 0.63.2 exports both `satori/standalone` and
`satori/layout.wasm`. In Deno, copy the same two files next to the module and
fetch them on the first render instead:

```ts
// vendor/index_bg.wasm is copied from @resvg/resvg-wasm/index_bg.wasm,
// vendor/layout.wasm from satori/layout.wasm.
const vendored = (file: string) => () => fetch(new URL(`./vendor/${file}`, import.meta.url));

const og = createEdgeOg({
  ...plate,
  resvg: { wasm: vendored("index_bg.wasm") },
  layout: { wasm: vendored("layout.wasm") },
});
```

`resvg.wasm` and `layout.wasm` accept a `WebAssembly.Module`, bytes, a
`Response`, a `URL`, a promise of one, or a function returning one; a function
runs on the first render. Each Wasm module is a single instance per isolate,
so the first source supplied wins, and a source whose initialisation fails is
tried again on the next render. To supply both once for every plate, call
`initEdgeRenderer(resvgWasm, { layout: layoutWasm })` at module scope instead.
A render with either module missing fails with an error naming it and where to
pass it.

The boundary is deliberately narrow:

- **PNG only.** `@resvg/resvg-wasm` has no JPEG or WebP encoder, so
  `metaplate/edge` rejects `output` encoders. `renderPixels` still returns raw
  RGBA for a Wasm encoder of your own.
- **The caller supplies both Wasm modules.** Nothing is fetched from
  `node_modules` or a CDN on your behalf.
- **Runtimes that compile Wasm at run time.** Satori's bundled HarfBuzz needs
  it, so Deno-based edges such as Netlify Edge Functions work and Cloudflare
  Workers do not (above).
- **About 1.6 MB gzip per edge function.** An esbuild bundle of a minimal
  consumer measures 414 KB gzip of JavaScript (1.13 MB minified, mostly
  `satori/standalone`) plus the two Wasm modules, `@resvg/resvg-wasm`'s
  959 KB gzip (2.48 MB raw) and `satori/layout.wasm`'s 213 KB gzip (521 KB
  raw). The certified Netlify Edge bundle was 462 KB gzip, with both Wasm
  modules served as static files, against a 20 MB limit. Check your platform's script-size limit before choosing this entry,
  or generate images at build time instead.
- **Fonts arrive as bytes**, through `metaplate/font-data` loaders, never file
  paths; `resvg.font` is not available because Satori outlines text first.
- **Fetch-shaped API.** `fetchable`, `fetchableFrom`, `handlerFrom`,
  `response`, `render`, `renderPixels`, and `artifact` behave as in
  `metaplate/node`, with the same owned headers and ETags (computed with Web
  Crypto). The copy-bound `handler` is not provided.
- **Tested in Node against the Wasm renderer, and hosted on Netlify Edge.**
  The test suite renders through `@resvg/resvg-wasm` and `satori/standalone` in
  Node and checks dimensions, media type, headers, and ETags against
  `metaplate/node`, and the package gate renders from the packed tarball. A
  Netlify Edge Functions deployment of 2026-11-01 is hosted-certified, with the
  Wasm modules and font fetched from the site's own static files
  ([fixture](https://github.com/lnorton89/metaplate/tree/main/examples/hosted/netlify/edge)).
  A Deno Deploy production build of 2026-11-01 is hosted-certified too, with
  the Wasm modules read from its `node_modules`
  ([fixture](https://github.com/lnorton89/metaplate/tree/main/examples/hosted/deno-deploy)).
  Cloudflare Workers fail every render (above).
