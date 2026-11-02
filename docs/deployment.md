# Deployment routes

Metaplate deployment support depends on the runtime, not only the hosting
brand. Choose the route that matches the entry point you use.

## Runtime decision tree

1. **Can the image be generated during the build?** Render it into the site's
   public/output directory, with [`metaplate render`](render-cli.md) or a build
   script, and deploy the resulting `.png` or `.jpg` as a static file. This is the most portable route and works on Netlify, GitHub
   Pages, and CDN/static hosting.
2. **Does the provider run standard Node.js, Bun, or Deno?** Use
   `metaplate/node` with a Web `Response` handler, a provider function, or raw
   bytes in Express. Set the provider to its Node runtime, not its Edge
   runtime. Deno Deploy runs `metaplate/node` through Deno's Node
   compatibility.
3. **Does the provider run only an edge runtime?** `metaplate/node` is not
   supported there because it loads the native `@resvg/resvg-js` binding. Use
   static generation or, on a Deno-based edge such as Netlify Edge Functions,
   `metaplate/edge`, which renders PNG through `@resvg/resvg-wasm`. Cloudflare
   Workers run neither entry (see [Edge runtimes](#edge-runtimes)). Web
   `Request`/`Response` support alone is not enough for `metaplate/node`.

Generated responses are buffered and rendering is CPU/memory intensive. For
public dynamic routes, bound route text, use stable path keys, set cache headers,
and configure provider timeouts/concurrency. Never pass an arbitrary request URL
into an image or asset element; allowlist remote assets or keep them local.
[Signed image routes](signed-routes.md) make a dynamic route render only the
URLs your pages emitted.

## Deployment matrix

| Deployment shape | API | Runtime | Recommended output | Support status |
| --- | --- | --- | --- | --- |
| Static site/CDN | [`metaplate render`](render-cli.md), or `render()` / `renderSvg()` in a build script | Node at build time only | `public/og-image.png` or `.jpg` | Supported |
| Vercel Function | `handler()` / `handlerFrom()` or `response()` | Vercel Node.js runtime | `/api/og` or framework route | Hosted-certified on a dated Vercel production deployment (2026-11-01, Node.js runtime); Next.js 16.4.3 on Vercel likewise |
| Netlify Function | `handler()` / `handlerFrom()` or `response()` | Netlify Node.js Function | Function path or custom path | Hosted-certified on a dated Netlify production deployment (2026-11-01, Functions Node.js runtime `nodejs24.x`); generated framework functions use project settings |
| Deno Deploy | `metaplate/edge` or `metaplate/node`, both `fetchableFrom()` | Deno Deploy, built from GitHub | App route | Hosted-certified on a dated Deno Deploy production build (2026-11-01), both renderers |
| Railway/Render service | `response()` or `render()` + `Buffer.from()` | Long-lived Node.js service | Application route | Locally certified generic Node contract; provider deployment remains a recipe |
| Next.js native route | `metaplate/next`, or `metaplate/node` in a route handler | Next build/Node runtime | Metadata file or route handler | Static export and `next start` server output locally certified from the packed artifact; hosted Next deployment is separate |
| Astro on-demand endpoint | `handlerFrom()` as the endpoint `GET` | `@astrojs/node` standalone server | `src/pages/[slug]/og-image.png.ts` | Locally certified from the packed artifact through the built `entry.mjs`; hosted Astro adapters are separate |
| SvelteKit `+server` route | `handlerFrom()` as the `GET` `RequestHandler` | `adapter-node` on Node.js | `src/routes/[slug]/og-image.png/+server.ts` | Locally certified framework contract; hosted deployment of the Node server remains a recipe |
| Netlify Edge Functions and other Deno-based edges | `metaplate/edge` (`fetchable()` / `fetchableFrom()`), not `metaplate/node` | `@resvg/resvg-wasm` with caller-supplied `index_bg.wasm` and `satori/layout.wasm`, on a runtime that compiles Wasm at run time | Provider route | Tested in Node against the Wasm renderer; hosted-certified on Netlify Edge Functions (2026-11-01) |
| Cloudflare Workers / Vercel Edge | None: not `metaplate/edge`, not `metaplate/node` | Isolates that forbid compiling Wasm from bytes | Static files, or the provider's Node runtime | Not supported. Workers fail every render under `wrangler dev` (workerd) because Satori's bundled HarfBuzz reads `self.location.href` and compiles its Wasm at run time (2026-11-01, local reproduction). Vercel Edge forbids the same compilation and is expected to fail likewise; its 2026-11-01 deploy was refused for size (2.13 MB gzip against Hobby's 1 MB) before any render |

## Static generation

Create the image during the provider's build, write it to the published output,
and point metadata at the resulting file. Use a real filename extension so static
hosts infer `Content-Type` correctly.

For more than one card, or any plate with size variants, use
[`metaplate render`](render-cli.md) as the build step: it writes every page at
every size to the path the plate's metadata URL names (without `basePath`, so
the output can be published under a project-site prefix), verifies each file on
disk, writes a manifest with each file's SHA-256, and exits non-zero on any
failure. A single card needs no more than a script like this one:

```ts
// scripts/build-og.ts
import { mkdir, writeFile } from "node:fs/promises";
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

const og = createNodeOg({
  alt: () => "Project card",
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  component: (copy: { title: string }) => ({
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        background: "#111827",
        color: "#fff",
        fontFamily: "Inter",
        fontSize: 64,
      },
      children: copy.title,
    },
  }),
});

await mkdir("public", { recursive: true });
await writeFile("public/og-image.png", await og.render({ title: "Project" }));
```

Run the script before the host's static build command. Verify the file and the
published HTML together:

```sh
npx metaplate verify --format png --size 1200x630 public/og-image.png
```

For a project-site prefix, pass the public origin and `basePath` to
`socialImageMetadata` and verify the emitted HTML contains the prefixed URL.
The path is owned by the application; Metaplate does not infer provider domains.

### GitHub Pages

GitHub Pages publishes static files and recommends a GitHub Actions workflow for
custom build processes. It does not run server-side languages and does not allow
custom MIME types per file/repository. Use extensionful files such as
`og-image.png`, not extensionless dynamic handlers.

A typical workflow is:

```yaml
- run: npm ci
- run: npm run build:og
- run: npm run build
- uses: actions/upload-pages-artifact@v3
  with:
    path: ./dist
```

For a repository site, include the repository name in the site's `basePath` and
use `metadataBase`/`origin` for the public URL. Enable HTTPS and inspect the
published HTML after deployment; a successful build does not prove that a
crawler can fetch the final image URL.

- [Creating a GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
- [Publishing sources](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [GitHub Pages HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)

### Netlify static hosting

Use the normal build command to generate an extensionful file in the publish
directory. If an extensionless route is unavoidable, set its exact content type
in `netlify.toml`; extensionful output remains preferable:

```toml
[[headers]]
for = "/og-image"
  [headers.values]
  Content-Type = "image/png"
```

- [Netlify Functions and configuration](https://docs.netlify.com/build/functions/configuration/)
- [Netlify build dependencies](https://docs.netlify.com/build/configure-builds/manage-dependencies/)

## Static hosts

Extension-free route-handler output may be served as a generic download by a
static host. Set the `Content-Type` explicitly for `/og-image` and `/*/og-image`
— `image/png` by default, or the `plate.contentType` of a custom-output plate
(`image/jpeg`, `image/webp`, …). For Netlify, a PNG plate:

```toml
[[headers]]
for = "/og-image"
  [headers.values]
  Content-Type = "image/png"

[[headers]]
for = "/*/og-image"
  [headers.values]
  Content-Type = "image/png"
```

A JPEG plate uses `Content-Type = "image/jpeg"` for the same two paths.

## Vercel Node.js Functions

Vercel's Node.js runtime supports standard Node APIs and Web Standard function
exports. Put a function in `api/og.ts` and keep the route on the Node runtime:

```ts
// api/og.ts
import { og } from "../src/lib/og";

// Named method handler: use handlerFrom for a GET export.
export const GET = og.handlerFrom((request: Request) => {
  const slug = new URL(request.url).searchParams.get("slug")?.slice(0, 80) ?? "home";
  return { title: slug, alt: `${slug} card` };
});
```

The first resolver argument is the Web `Request`; route data is read from its
URL or from the framework's documented request context. For a named method export
such as `GET`, use `handlerFrom` as shown above. For a Fetch-style default export,
use the object returned by `fetchableFrom` directly:

```ts
// api/og-fetch.ts
import { og } from "../src/lib/og";

export default og.fetchableFrom((request: Request) => {
  const slug = new URL(request.url).searchParams.get("slug")?.slice(0, 80) ?? "home";
  return { title: slug, alt: `${slug} card` };
});
```

`fetchableFrom` returns an object with a `fetch` method, so it can be exported
directly by Fetch-style runtimes without an adapter wrapper.

If a framework supplies generated route types, use those types rather than the
structural example above. Do not mark this function for Vercel Edge when the
plate imports `metaplate/node`; use the Vercel Node.js runtime instead.

The packed-package release gate locally exercises the Vercel-style Web Standard
handler, Netlify-style `context.params` handler/config shape, and generic Node
service over HTTP. This proves Metaplate's contract and bytes from the exact npm
artifact; it does not prove a hosted provider build or account configuration.

### Hosted Vercel evidence

The `vercel-node` and `vercel-next` routes in `deployment-evidence.json` are
certified from real production deployments made on 2026-11-01 from the packed
0.8.0 tarball, each to a new Vercel project. The deployed sources are in
[`examples/hosted/vercel`](https://github.com/lnorton89/metaplate/tree/main/examples/hosted/vercel) and the raw
`verify-url` output, response headers, build logs, and deployment IDs are in
`.planning/hosted-evidence/vercel-2026-11-01.json`.

- **Vercel Function, Node.js runtime.** `api/og/[slug].mjs` exports
  `GET = og.handlerFrom(...)` and reads the slug from the request path. Vercel's
  install picks the Linux `@resvg/resvg-js` binding and file tracing copies the
  native `.node` file into the function without configuration. Tracing cannot
  see `fontsourceFontLoader`'s run-time read, so `vercel.json` adds the font
  with `functions["api/og/*.mjs"].includeFiles`. Vercel's CDN consumes
  `s-maxage` and forwards the rest of the plate's `Cache-Control`.
- **Next.js 16.4.3 on Vercel.** A dynamic `[slug]/opengraph-image.tsx` through
  `createNextOg` and an `[slug]/og-image.jpg/route.ts` through `createNodeOg`
  with a sharp JPEG encoder, configured as in the README with
  `serverExternalPackages: ["@resvg/resvg-js", "satori"]`. The font needs
  `outputFileTracingIncludes`, whose keys are picomatch globs over route paths:
  `"/*/og-image.jpg"` matches, a literal `"/[slug]/og-image.jpg"` does not.
  The page's `og:image` (with Next's `?<hash>` query) and `twitter:image` were
  fetched exactly as advertised.
- **Vercel Edge, `metaplate/edge`: not supported.** Edge cannot compile Wasm
  from bytes, so both modules were `?module` imports
  (`@resvg/resvg-wasm/index_bg.wasm?module` as `resvg.wasm`,
  `satori/layout.wasm?module` as `layout.wasm`). The build accepted them, but
  the deploy was rejected: the function is 2.13 MB after gzip and the Hobby
  plan's Edge limit is 1 MB. The Resvg Wasm alone is 0.95 MB gzip, and the
  bundle also carries Satori's default build beside `satori/standalone`. A
  smaller bundle would not help: Vercel documents that `WebAssembly.instantiate`
  on the Edge runtime "requires the Wasm source code to be provided using the
  import statement", and Satori's bundled HarfBuzz compiles its Wasm from
  embedded bytes, the failure reproduced on Cloudflare Workers (see
  [Edge runtimes](#edge-runtimes)). Not observed on Vercel, because no render
  ran. Use the Node.js runtime on Vercel.

Each certification covers that dated deployment, its runtime, and the packed
version; it is not a guarantee for later Vercel or Next releases.

- [Vercel Functions](https://vercel.com/docs/functions)
- [Vercel Node.js runtime](https://vercel.com/docs/functions/runtimes/node-js)
- [Vercel runtimes](https://vercel.com/docs/functions/runtimes)
- [Vercel Edge runtime](https://vercel.com/docs/functions/runtimes/edge)
- [Vercel WebAssembly](https://vercel.com/docs/functions/runtimes/wasm)
- [Vercel `functions` configuration and `includeFiles`](https://vercel.com/docs/project-configuration/vercel-json)
- [Next.js on Vercel](https://vercel.com/docs/frameworks/full-stack/nextjs)

## Netlify Functions

Netlify Functions run on Node.js and can use the same Web `Response` returned by
Metaplate. The default URL is `/.netlify/functions/<name>`; Netlify also supports
custom paths and named path parameters:

```ts
// netlify/functions/og.mts
import type { Config } from "@netlify/functions";
import { og } from "../../src/lib/og";

export default og.handlerFrom((_request, { params }: { params: Record<string, string | undefined> }) => {
  const slug = (params.slug ?? "home").slice(0, 80);
  return { title: slug, alt: `${slug} card` };
});

export const config: Config = {
  path: "/og/:slug",
  method: "GET",
};
```

Netlify documents a default 1024 MB function allocation and a 60-second
synchronous execution limit. These are provider constraints, not Metaplate
guarantees; use static generation or cache aggressively when rendering is not
request-specific. For framework-generated functions, configure the project-level
runtime/region because the generated file cannot be edited safely.

### Hosted Netlify evidence

The `netlify-node` and `netlify-edge` routes in `deployment-evidence.json` are
certified from production deployments made on 2026-11-01 from the packed 0.8.0
tarball, each to a new Netlify site, with the Netlify CLI
(`netlify deploy --prod --no-build`). The deployed sources are in
[`examples/hosted/netlify`](https://github.com/lnorton89/metaplate/tree/main/examples/hosted/netlify)
and the raw `verify-url` output, response headers, content checks, and
deployment IDs are in `.planning/hosted-evidence/netlify-2026-11-01.json`.

- **Netlify Functions, Node.js runtime.** `netlify/functions/og.mjs`
  default-exports `og.handlerFrom((_request, context) => ...)` with
  `config.path = "/og/:slug"`. The CLI bundles locally, so the install must
  target Netlify's Linux x64 runtime (`npm install --os=linux --cpu=x64
  --libc=glibc`) to get `@resvg/resvg-js-linux-x64-gnu`. `netlify.toml` sets
  `node_bundler = "esbuild"`, lists both Resvg packages in
  `external_node_modules` (Netlify's documented setting for native add-ons),
  and adds Fontsource's `package.json`, `metadata.json`, and the font file
  through `included_files`; without `metadata.json` the function returned 502.
  The function ran on `nodejs24.x` and streamed its response, so no
  `Content-Length` arrives.
- **Netlify Edge Functions, `metaplate/edge`.** `netlify/edge-functions/og.ts`
  returns `createEdgeOg(...).fetchableFrom(...)` at `/og-edge/:slug`. npm
  packages installed in `node_modules` are imported by name, as Netlify
  documents, and the CLI bundles them. Edge functions have no filesystem, so
  `@resvg/resvg-wasm/index_bg.wasm`, `satori/layout.wasm`, and the font are
  static files in the publish directory, fetched as bytes from the request
  origin on first render and passed as `resvg.wasm`, `layout.wasm`, and font
  data. The bundle is 462 KB gzip (limit 20 MB), and the documented 50 ms CPU limit did
  not stop any observed render (CPU time was not measured).
- **Caveat.** The edge site's first deploy served two uniform, text-free cards
  with valid format, size, and headers. The cause was the fixture's layout:
  Satori sizes boxes as content-box, so a 100% card with 64px padding grew
  past the canvas and a one-line, bottom-aligned title was drawn below it.
  The fixture now sets `boxSizing: "border-box"`, and the site was redeployed
  and re-certified with one-line titles. The evidence also decodes each image
  and requires it not to be uniform.

Each certification covers that dated deployment, its runtime, and the packed
version; it is not a guarantee for later Netlify releases.

- [Netlify Functions get started](https://docs.netlify.com/build/functions/get-started/)
- [Netlify Functions API](https://docs.netlify.com/build/functions/api/)
- [Netlify file-based configuration](https://docs.netlify.com/build/configure-builds/file-based-configuration/)
- [Netlify Edge Functions API](https://docs.netlify.com/build/edge-functions/api/)
- [Netlify Edge Functions limits](https://docs.netlify.com/build/edge-functions/limits/)
- [Netlify Functions overview](https://docs.netlify.com/build/functions/overview/)
- [Netlify Functions configuration](https://docs.netlify.com/build/functions/configuration/)
- [Netlify Express deployment](https://docs.netlify.com/build/frameworks/framework-setup-guides/express/)

## Deno Deploy

One Deno Deploy app runs both renderers: `metaplate/edge` at `/og/:slug`,
reading `@resvg/resvg-wasm/index_bg.wasm` and `satori/layout.wasm` from its
`node_modules` with `Deno.readFile`, and `metaplate/node` at `/og-node/:slug`,
loading the native `@resvg/resvg-js` binding through Deno's Node
compatibility. Deno Deploy builds the app from the GitHub repository, so a
deployment is reproducible from a commit:

- The app directory is the fixture directory, and `deno.json`'s `deploy`
  section sets the build, which Deno Deploy reads on every build.
- The install step installs the repository root from its lockfile, builds and
  packs metaplate, installs the app against that tarball, then deletes the
  root dependencies. With them, the deployment's files reach about 940 MB,
  near Deno Deploy's documented 1 GB limit, and the build failed while
  preparing its artifact. Without them the artifact is 26.6 MB.
- Deno Deploy's builder fetches the newest npm (12), whose `npm pack --json`
  prints an object keyed by package name rather than an array.
- Builds and logs are read from the REST API (`https://api.deno.com/v2`) with an
  organization access token.

The fixture deploys from GitHub, not by uploading a local directory with
`deno deploy`; uploads stalled on Deno Deploy's side when this was set up
([denoland/deploy_feedback#954](https://github.com/denoland/deploy_feedback/issues/954)).

### Hosted Deno Deploy evidence

The `deno-deploy-edge` and `deno-deploy-node` routes in
`deployment-evidence.json` are certified from the production build of `main`
at `36be0e9` on 2026-11-01, served at
`https://metaplate-deno-github.metaplate.deno.net` on Deno 2.9.8. Each route
was checked with a one-line title and a wrapped title: `verify-url`, a plain
GET for status and headers, distinct bytes per slug, and a decoded check that
each image is not uniform. The fixture is
[`examples/hosted/deno-deploy`](https://github.com/lnorton89/metaplate/tree/main/examples/hosted/deno-deploy),
and the build log, build history, and raw outputs are in
`.planning/hosted-evidence/deno-deploy-2026-11-01.json`.

The certification covers that dated build, Deno Deploy's runtime at the time,
and the packed version; it is not a guarantee for later Deno Deploy releases.

- [Deno Deploy builds](https://docs.deno.com/deploy/reference/builds/)
- [Deno Deploy apps](https://docs.deno.com/deploy/reference/apps/)
- [Deno Deploy timelines](https://docs.deno.com/deploy/reference/timelines/)
- [Deno Deploy REST API](https://api.deno.com/v2/docs)

## Railway, Render, and generic Node services

For a long-lived service, expose a health endpoint, listen on `process.env.PORT`,
and use a graceful shutdown path. `response()` owns `Content-Type` and computes
`Content-Length`; configure cache and other non-representation headers through
`headers`, but do not provide `Content-Type`, `Content-Length`, or
`Content-Encoding` yourself; configuring one throws when the plate is defined.
Set `etag: "sha256"` (or `etag: true`) when a deterministic strong ETag derived
from the final bytes is useful. The provider only needs the normal Node build
and start commands; no Railway or Render SDK is required:

```ts
import express from "express";
import { og } from "./og.js";

const app = express();
app.get("/health", (_request, response) => response.json({ ok: true }));
app.get("/og/:slug", async (request, response, next) => {
  try {
    const slug = request.params.slug.slice(0, 80);
    response.type(og.contentType);
    response.set("Cache-Control", "public, max-age=86400");
    response.send(Buffer.from(await og.render({ title: slug })));
  } catch (error) {
    next(error);
  }
});

const server = app.listen(Number(process.env.PORT ?? 3000));
const shutdown = () => server.close(() => process.exit(0));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
```

Use a production install that includes the renderer peers and font assets. Do not
assume the working directory is writable at request time; package or deploy
assets as files and load them using stable URLs/paths.

- [Railway Express deployment](https://docs.railway.com/guides/express)
- [Render Node/Express deployment](https://render.com/docs/deploy-node-express-app)
- [Render web services](https://render.com/docs/web-services)

## Edge runtimes

Cloudflare Workers, Vercel Edge, and Netlify Edge implement Web APIs, but that
does not make the native Resvg binding executable there. Cloudflare documents
that Node compatibility includes both supported APIs and importable shims whose
methods may throw. `metaplate/edge` is the Wasm path: it renders PNG through
`@resvg/resvg-wasm` and lays out through `satori/standalone`, takes both Wasm
modules (`@resvg/resvg-wasm/index_bg.wasm` and `satori/layout.wasm`) and fonts
as bytes from the caller, and imports no Node built-ins. It runs on Deno-based
edges, which allow WebAssembly to be compiled at run time: it is tested in Node
against the Wasm renderer and from the packed tarball, and hosted-certified on
Netlify Edge Functions (see [Hosted Netlify evidence](#hosted-netlify-evidence)).
A minimal edge function is about 1.6 MB gzip, mostly the two Wasm modules; the
certified Netlify Edge bundle was 462 KB gzip against a 20 MB limit. See the
README section
[Edge runtimes with `metaplate/edge`](edge.md).

**Cloudflare Workers are not supported.** Satori shapes text with a HarfBuzz
build bundled into `satori/standalone`. In a worker-shaped isolate it reads
`self.location.href`, and it compiles HarfBuzz from embedded bytes on first
use. Workers define no `location` and accept only pre-compiled Wasm modules, so
a Worker built from the packed 0.8.0 tarball returned 500 for every render
under `wrangler dev --local` (workerd, Wrangler 4.156.0) on 2026-11-01: first
`TypeError: Cannot read properties of undefined (reading 'href')`, then, with
`location` defined as a probe, `Wasm code generation disallowed by embedder`.
Satori takes no precompiled HarfBuzz module, and every Satori release that
exports `satori/layout.wasm` (0.35.2 and later) bundles this build, so the
caller cannot work around it. `metaplate/edge` reports either failure as an
error naming this limitation. The reproduction is
[`examples/hosted/cloudflare`](https://github.com/lnorton89/metaplate/tree/main/examples/hosted/cloudflare),
and the `cloudflare-workers` route in `deployment-evidence.json` records it.
Vercel's Edge runtime also refuses to compile Wasm from a buffer, so it is
expected to fail the same way (see [Vercel](#hosted-vercel-evidence)); that was
not observed, because the deployment was refused for size first.

On those runtimes, or where JPEG or WebP output is required:

- generate images during a Node build and publish static files; or
- run the image route on the provider's Node runtime/service.

- [Cloudflare Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Cloudflare Workers WebAssembly](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)
- [Cloudflare Workers web standards (`WebAssembly.compile` and `WebAssembly.instantiate` with a buffer are not allowed)](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)
- [Vercel Edge runtime unsupported APIs](https://vercel.com/docs/functions/runtimes/edge#unsupported-apis)
- [Netlify Edge Functions overview](https://docs.netlify.com/build/edge-functions/overview/)
