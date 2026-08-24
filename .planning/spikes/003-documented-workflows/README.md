---
spike: 003
name: documented-workflows
type: standard
validates: "Given README-style metadata, standalone render, Next adapter, font, response, and custom-output consumers, when run outside the repository, then observable output matches the documented contract."
verdict: VALIDATED
related: [001, 002]
tags: [docs, integration, rendering]
---

# Spike 003: Documented Workflows

## What This Validates

The published package works as an actual consumer integration with current compatible peers, real font bytes, real SVG/raster generation, Fetch responses, concurrent calls, custom encoding, and Next.js `ImageResponse`.

## Research

| Approach | Tool/Library | Pros | Cons | Status |
|----------|--------------|------|------|--------|
| SVG generation | [Satori](https://github.com/vercel/satori) | The package's documented layout engine; supports TTF/OTF/WOFF and plain element trees | CSS subset rather than browser layout | Chosen |
| PNG rasterization | [Resvg-js](https://github.com/thx/resvg-js) | The package's documented native raster peer and exposes PNG/pixel output | Native binary dependency | Chosen |
| JPEG encoding | [Sharp raw input](https://sharp.pixelplumbing.com/api-constructor/) | Accepts the documented RGBA `Uint8Array` shape directly | Additional native dependency | Chosen |
| Next integration | [Next.js ImageResponse](https://nextjs.org/docs/app/api-reference/functions/image-response) | Exercises the adapter's real upstream constructor and response semantics | Heavier install than a mock | Chosen |

## How to Run

```sh
node .planning/spikes/003-documented-workflows/run.mjs
```

## What to Expect

The harness installs current peer versions into a temporary consumer, renders and verifies actual image bytes, and prints a compact integration report.

## Investigation Trail

- Re-grounded against the manifest and carried forward Spike 002's distinction between valid produced bytes and malformed structural shells.
- Installed exact `metaplate@0.5.0` with current compatible peers: Satori 0.33.4, Resvg 2.6.2, React 19.2.8, Next 16.3.2, Sharp 0.35.3, and Fontsource Inter 5.3.0.
- Loaded and memoized a real 31,320-byte Inter WOFF face, then rendered a 17,594-byte SVG and a verified 16,313-byte PNG from a plain object tree.
- Rendered eight cards concurrently; every output verified as 1200×630 PNG.
- Exercised `response` and `handler`: the plate overrode a conflicting user `Content-Type`, preserved `Cache-Control`, and served valid bytes.
- Used Sharp's raw RGBA input to generate a verified 17,875-byte JPEG. Metadata carried `image/jpeg`, and a deliberately mismatched encoder was rejected.
- Built a real Next 16.3.2 `output: "export"` application using the README's `createNextOg`, `og.render`, `og.size`, and `og.contentType` pattern. The build succeeded and emitted a visually inspected, valid 1200×630 PNG plus Open Graph/Twitter metadata.
- Isolated one non-documented boundary: calling the Next adapter directly from plain Node ESM fails because Next ships `og.js` without an exports map while Metaplate imports `next/og`. Node suggests `next/og.js`; Next's own build pipeline resolves and bundles the documented specifier successfully.

## Results

VALIDATED. Every documented framework-neutral and Next application workflow produced the promised observable result with current peers.

No release-blocking integration defect was found. One low-priority 0.6 consideration remains: either document that `metaplate/next` must run through Next's build/runtime, or switch/test the optional-peer import in a way that also permits direct Node ESM execution if Next continues shipping `og.js` without a package exports map.
