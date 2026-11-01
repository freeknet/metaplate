# Cloudflare Workers reproduction fixture

`worker/` is a Cloudflare Worker that serves `metaplate/edge` cards at
`/og/:slug`. It does not certify Workers: it reproduces why `metaplate/edge`
does not run there. The dated record is
[`.planning/hosted-evidence/cloudflare-workers-2026-11-01.json`](../../../.planning/hosted-evidence/cloudflare-workers-2026-11-01.json),
which `deployment-evidence.json` references from the `cloudflare-workers`
route (`not-supported`).

| Directory | Route | Result on 2026-11-01 |
| --- | --- | --- |
| `worker/` | Cloudflare Worker, `metaplate/edge` `fetchableFrom` with both Wasm modules imported as `WebAssembly.Module` values and the Inter WOFF bundled as data | Not supported: every render returns 500 under `wrangler dev --local` (workerd) |

It is excluded from `tsconfig.examples.json` because it is a separate app that
resolves `metaplate` from an installed tarball, not from `src/`.

## Why it fails

Satori shapes text with a HarfBuzz Emscripten build bundled into
`satori/standalone`. In workerd, `WorkerGlobalScope` exists, so the glue reads
`self.location.href`, and Workers define no `location`:

```text
TypeError: Cannot read properties of undefined (reading 'href')
```

With `globalThis.location` defined as a probe, the glue gets further and
compiles HarfBuzz from embedded bytes, which Workers forbid:

```text
RuntimeError: Aborted(CompileError: WebAssembly.instantiate(): Wasm code generation disallowed by embedder)
```

Satori takes no precompiled HarfBuzz module (its `init` accepts only
`layout.wasm`), and every Satori release that exports `satori/layout.wasm`
(0.35.2 and later) bundles this glue, so the caller cannot work around it.
`metaplate/edge` rethrows either failure as an error naming the limitation,
with the original error as its `cause`.

## Running it locally

Run it only locally; nothing here contacts a Cloudflare account. Copy the
fixture out of the repository first, so `.wrangler/` and `node_modules/`
never land here:

```sh
npm run build && npm pack --pack-destination /tmp/metaplate-pack
cp -r examples/hosted/cloudflare/worker /tmp/metaplate-cf-worker
cp /tmp/metaplate-pack/metaplate-<version>.tgz /tmp/metaplate-cf-worker/
cd /tmp/metaplate-cf-worker
# Point the dependency at the tarball you packed if the version changed.
npm install
npm run bundle   # wrangler deploy --dry-run: prints the upload size, uploads nothing
npm run dev      # wrangler dev --local on http://127.0.0.1:8797
curl -sS -i http://127.0.0.1:8797/og/check
```

The response is `500` and its body (Wrangler's local error page) starts with
`Error: metaplate/edge cannot render text in this runtime: Satori's bundled
HarfBuzz text shaper ...`. The `wrangler dev` console prints the same error
followed by `Caused by: TypeError: Cannot read properties of undefined (reading
'href')`.
