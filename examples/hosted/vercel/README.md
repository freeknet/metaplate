# Hosted Vercel certification fixtures

These are the exact sources deployed for the dated Vercel evidence in
[`.planning/hosted-evidence/vercel-2026-11-01.json`](../../../.planning/hosted-evidence/vercel-2026-11-01.json),
which `deployment-evidence.json` references from the `vercel-node`,
`vercel-next`, and `vercel-edge` routes.

| Directory | Route | Result on 2026-11-01 |
| --- | --- | --- |
| `function/` | Vercel Function, Node.js runtime, `metaplate/node` `handlerFrom` as a named `GET` export | Certified |
| `next/` | Next.js 16.4.3 on Vercel: `metaplate/next` `opengraph-image` and a `metaplate/node` JPEG route handler | Certified |
| `edge/` | Vercel Edge Function, `metaplate/edge` with `?module` Wasm imports | Not certified: rejected by the Hobby plan's 1 MB Edge size limit (2.13 MB) |

They are excluded from `tsconfig.examples.json` because each one is a separate
app that resolves `metaplate` from an installed tarball, not from `src/`.

## Redeploying

Every deployment goes to a new project whose name starts with
`metaplate-cert-`. The Vercel CLI names a new project after the directory it
deploys, so copy a fixture out of the repository (its `.vercel/` link file must
never land here) into a directory named for the new project:

```sh
npm run build && npm pack --pack-destination /tmp/metaplate-pack
cp -r examples/hosted/vercel/function /tmp/metaplate-cert-fn-<suffix>
cp /tmp/metaplate-pack/metaplate-<version>.tgz /tmp/metaplate-cert-fn-<suffix>/
cd /tmp/metaplate-cert-fn-<suffix>
# Point the dependency at the tarball you packed if the version changed.
npm install                       # writes package-lock.json for the upload
npx --yes vercel@latest deploy --prod --yes
```

Confirm the CLI prints `Created <scope>/metaplate-cert-…`: a `Linked` line
means an existing project was reused. For `edge/`, also copy
`node_modules/@fontsource/inter/files/inter-latin-700-normal.woff` from this
repository into `public/fonts/`, which the function fetches from its own origin.

Then check two slugs per image URL with the packed CLI and a plain GET:

```sh
node dist/cli.js verify-url --json --size 1200x630 --format png https://<project>.vercel.app/api/og/hello-world
curl -sS -o /dev/null -D - https://<project>.vercel.app/api/og/hello-world
```

For `next/`, read `og:image` and `twitter:image` from `/<slug>` and fetch the
exact advertised URLs, including Next's `?<hash>` query on the metadata image.

## What each fixture needs on Vercel

- **`function/`**: `@resvg/resvg-js` needs nothing extra. Vercel's npm install
  selects the Linux binding and file tracing copies the `.node` binary into the
  function. `fontsourceFontLoader` reads the font at run time, which tracing
  cannot see, so `vercel.json` adds it with `includeFiles`.
- **`next/`**: `serverExternalPackages: ["@resvg/resvg-js", "satori"]` as in the
  README, plus `outputFileTracingIncludes` for the font. Its keys are picomatch
  globs over route paths, so `"/*/og-image.jpg"` works and a literal
  `"/[slug]/og-image.jpg"` matches nothing.
- **`edge/`**: Edge cannot compile Wasm from bytes, so both modules are
  `?module` imports (`@resvg/resvg-wasm/index_bg.wasm?module` and
  `satori/layout.wasm?module`). The build accepts them, but the function is
  2.13 MB after gzip: the resvg Wasm alone is 0.95 MB, and Satori's default
  build is bundled beside `satori/standalone`. It cannot fit a Hobby plan's
  1 MB limit. Without the duplicate Satori build it would be about 1.6 MB,
  which fits Pro's 2 MB limit, but no Pro deployment has been tested.
