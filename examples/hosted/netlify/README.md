# Hosted Netlify certification fixtures

These are the exact sources deployed for the dated Netlify evidence in
[`.planning/hosted-evidence/netlify-2026-11-01.json`](../../../.planning/hosted-evidence/netlify-2026-11-01.json),
which `deployment-evidence.json` references from the `netlify-node` and
`netlify-edge` routes.

| Directory | Route | Result on 2026-11-01 |
| --- | --- | --- |
| `functions/` | Netlify Function, Node.js runtime (`nodejs24.x`), `metaplate/node` `handlerFrom` as the default export with `config.path = "/og/:slug"` | Certified |
| `edge/` | Netlify Edge Function, `metaplate/edge` `fetchableFrom` at `/og-edge/:slug`, with both `resvg.wasm` and `layout.wasm` | Certified, with a recorded caveat (below) |

They are excluded from `tsconfig.examples.json` because each one is a separate
app that resolves `metaplate` from an installed tarball, not from `src/`.

## Redeploying

Deploy each fixture to a new, empty Netlify site created for the purpose, and
never to an existing site. Copy the fixture out of the repository first, so the
CLI's `.netlify/` state never lands here:

```sh
npm run build && npm pack --pack-destination /tmp/metaplate-pack
cp -r examples/hosted/netlify/functions /tmp/netlify-functions
cp /tmp/metaplate-pack/metaplate-<version>.tgz /tmp/netlify-functions/
cd /tmp/netlify-functions
# Point the dependency at the tarball you packed if the version changed.
npm install --os=linux --cpu=x64 --libc=glibc
netlify sites:create --account-slug <team> --disable-linking --json
netlify deploy --prod --no-build --site <new site id> --dir public --functions netlify/functions
```

For `edge/`, run `npm install` (no platform flags; nothing native is
involved), then `npm run assets`, then
`netlify deploy --prod --no-build --site <new site id> --dir public`. The CLI
bundles `netlify/edge-functions` during a `--no-build` deploy.

Then check two never-requested slugs per site with the packed CLI and a plain
GET, and decode each image to confirm it is not uniform:

```sh
node dist/cli.js verify-url --json --size 1200x630 --format png https://<site>.netlify.app/og/<slug>
curl -sS -o /dev/null -D - https://<site>.netlify.app/og/<slug>
```

## What each fixture needs on Netlify

- **`functions/`**: the Netlify CLI bundles functions on the machine that
  deploys, so the install must target Netlify's Linux x64 runtime to get
  `@resvg/resvg-js-linux-x64-gnu`. `netlify.toml` uses `node_bundler = "esbuild"`
  and lists both Resvg packages in `external_node_modules`, the setting Netlify
  documents for native add-ons. `fontsourceFontLoader` reads
  `@fontsource/inter`'s `package.json`, `metadata.json`, and the font file at
  run time, so all three are in `included_files`; without `metadata.json` the
  function returns 502. Netlify streams the response, so it arrives without
  `Content-Length`.
- **`edge/`**: npm packages in `node_modules` are imported by name, which is
  Netlify's documented npm support for Edge Functions; there is no import map.
  Edge functions have no filesystem, so `npm run assets` copies
  `@resvg/resvg-wasm/index_bg.wasm`, `satori/layout.wasm`, and the Inter WOFF
  into `public/`, and `og.ts` fetches them as bytes from the request origin on
  first render. Both Wasm modules are passed to `createEdgeOg`, as `resvg.wasm`
  and `layout.wasm`. The bundle was 1.10 MB gzip against Netlify's 20 MB limit,
  and the documented 50 ms CPU limit did not stop any
  observed render (CPU time was not measured).
  `X-Metaplate-Runtime` reads `deno:` because Netlify's `Deno.version.deno` is
  an empty string.

## Edge caveat

The edge site's first deploy served `/og-edge/hosted` and `/og-edge/edge` as
identical, uniform cards with no text: valid PNG, 1200x630, correct headers.
Later cold renders, including the certified ones, drew text, and a diagnostic
deploy showed every asset fetch returning the right bytes. The most likely
cause is a first-deploy propagation race on the same-origin font fetch, which
Satori turned into a card without glyphs instead of an error. It was not
reproduced on demand. Check that a fresh deployment's images are not uniform,
not just their format and size, and request new slugs: the CDN caches each
response for 24 hours.
