# Deployment routes

Metaplate deployment support depends on the runtime, not only the hosting
brand. Choose the route that matches the entry point you use.

## Runtime decision tree

1. **Can the image be generated during the build?** Render it into the site's
   public/output directory and deploy the resulting `.png` or `.jpg` as a
   static file. This is the most portable route and works on Netlify, GitHub
   Pages, and CDN/static hosting.
2. **Does the provider run standard Node.js?** Use `metaplate/node` with a Web
   `Response` handler, a provider function, or raw bytes in Express. Set the
   provider to its Node runtime, not its Edge runtime.
3. **Does the provider run only an edge runtime?** `metaplate/node` is not
   supported there because it loads the native `@resvg/resvg-js` binding. Use
   static generation or a separately tested edge/Wasm renderer. Web
   `Request`/`Response` support alone is not enough.

Generated responses are buffered and rendering is CPU/memory intensive. For
public dynamic routes, bound route text, use stable path keys, set cache headers,
and configure provider timeouts/concurrency. Never pass an arbitrary request URL
into an image or asset element; allowlist remote assets or keep them local.

## Deployment matrix

| Deployment shape | API | Runtime | Recommended output | Support status |
| --- | --- | --- | --- | --- |
| Static site/CDN | `render()` or `renderSvg()` in a build script | Node at build time only | `public/og-image.png` or `.jpg` | Supported |
| Vercel Function | `handler()` / `handlerFrom()` or `response()` | Vercel Node.js runtime | `/api/og` or framework route | Locally certified provider-shaped contract; hosted provider certification is separate |
| Netlify Function | `handler()` / `handlerFrom()` or `response()` | Netlify Node.js Function | Function path or custom path | Locally certified provider-shaped contract; generated framework functions use project settings |
| Railway/Render service | `response()` or `render()` + `Buffer.from()` | Long-lived Node.js service | Application route | Locally certified generic Node contract; provider deployment remains a recipe |
| Next.js native route | `metaplate/next` | Next build/Node runtime | Metadata file or route handler | Supported by the Next integration contract |
| Cloudflare Workers / Vercel Edge / Netlify Edge | Not `metaplate/node` | Edge/Wasm renderer required | Provider route | Not supported by the current native renderer |

## Static generation

Create the image during the provider's build, write it to the published output,
and point metadata at the resulting file. Use a real filename extension so static
hosts infer `Content-Type` correctly:

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

## Vercel Node.js Functions

Vercel's Node.js runtime supports standard Node APIs and Web Standard function
exports. Put a function in `api/og.ts` and keep the route on the Node runtime:

```ts
// api/og.ts
import { og } from "../src/lib/og";

export const GET = og.fetchableFrom((request: Request) => {
  const slug = new URL(request.url).searchParams.get("slug")?.slice(0, 80) ?? "home";
  return { title: slug, alt: `${slug} card` };
});
```

The first resolver argument is the Web `Request`; route data is read from its
URL or from the framework's documented request context. `fetchableFrom` returns
an object with a `fetch` method, so it can be exported directly by Fetch-style
runtimes without an adapter wrapper.

If a framework supplies generated route types, use those types rather than the
structural example above. Do not mark this function for Vercel Edge when the
plate imports `metaplate/node`; use the Vercel Node.js runtime instead.

The packed-package release gate locally exercises the Vercel-style Web Standard
handler, Netlify-style `context.params` handler/config shape, and generic Node
service over HTTP. This proves Metaplate's contract and bytes from the exact npm
artifact; it does not prove a hosted provider build or account configuration.

- [Vercel Functions](https://vercel.com/docs/functions)
- [Vercel Node.js runtime](https://vercel.com/docs/functions/runtimes/node-js)
- [Vercel runtimes](https://vercel.com/docs/functions/runtimes)
- [Vercel Edge runtime](https://vercel.com/docs/functions/runtimes/edge)

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

- [Netlify Functions overview](https://docs.netlify.com/build/functions/overview/)
- [Netlify Functions configuration](https://docs.netlify.com/build/functions/configuration/)
- [Netlify Express deployment](https://docs.netlify.com/build/frameworks/framework-setup-guides/express/)

## Railway, Render, and generic Node services

For a long-lived service, expose a health endpoint, listen on `process.env.PORT`,
and use a graceful shutdown path. `response()` owns `Content-Type` and computes
`Content-Length`; configure cache and other non-representation headers through
`headers`, but do not provide `Content-Type`, `Content-Length`, or
`Content-Encoding` yourself. Set `etag: "sha256"` when a deterministic strong
ETag derived from the final bytes is useful. The provider only needs the normal Node build
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
methods may throw. A future edge integration must use a separately tested
Wasm-compatible renderer, font loader, and asset policy.

Until that exists:

- generate images during a Node build and publish static files; or
- run the image route on the provider's Node runtime/service.

- [Cloudflare Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Cloudflare Workers WebAssembly](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)
