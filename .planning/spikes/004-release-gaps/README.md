---
spike: 004
name: release-gaps
type: standard
validates: "Given common social-image release workflows, when attempted with 0.5.0, then workarounds and missing primitives reveal a prioritized, evidence-backed 0.6.0 scope."
verdict: VALIDATED
related: [001, 002, 003]
tags: [product, ergonomics, roadmap]
---

# Spike 004: Release Gaps

## What This Validates

Common workflows adjacent to the documented product can either be completed cleanly with existing composition points or expose small, repeated gaps worth including in 0.6.0.

## Research

Satori's current contract supports language-tagged font faces, while Metaplate's structural `SatoriFont` mirror already carries `lang`. Next's current `ImageResponse` supports response status, status text, and headers. Metaplate's current custom-output example explicitly permits AVIF, while its verifier recognizes only PNG, JPEG, and WebP.

The approach is an API-surface and runtime asymmetry probe against exact 0.5.0, backed by the successful consumer integrations from Spike 003. Broad product ideas without an observed workaround or asymmetric existing contract are excluded.

## How to Run

```sh
node .planning/spikes/004-release-gaps/run.mjs
```

## What to Expect

The report lists public exports, CLI discovery behavior, custom-format verification behavior, and whether package-font language metadata survives loading.

## Investigation Trail

- Re-grounded against all three prior verdicts: package delivery and normal integrations are sound; verifier hardening is already the dominant 0.6 work.
- Favored small features that close an existing asymmetric workflow over new rendering abstractions.
- `metaplate --help` and `metaplate --version` both returned error status 1 and printed the verify usage line; the CLI has no successful discovery path.
- Metaplate can render SVG and `detectFormat` returns `"svg"`, but `imageDimensions`, `verifyImage`, and the CLI cannot verify SVG dimensions or structure.
- `SatoriFont` exposes Satori's `lang`, but `PackageFont` omits it and `loadPackageFonts` drops a JavaScript caller's `lang` property. The package helper therefore cannot express Satori's language-specific font selection without being replaced by a custom loader.
- The documented unknown-format encoder can emit AVIF by opting out of signature checks, but the verifier and CLI cannot recognize it.
- `createNodeOg` responses accept headers only, unlike Next's upstream response controls; static generation still requires consumer-owned directory creation, file writes, batching, and post-write verification.

## Results

VALIDATED. The audit found three small, evidence-backed feature additions suitable for 0.6.0:

1. **Package-font language passthrough.** Add optional `lang` to `PackageFont` and `LoadedFont`, preserve it in `loadPackageFonts`, and test multilingual selection. This closes a gap in an already mirrored Satori field with almost no new API surface.
2. **CLI discovery.** Add successful `--help` and `--version` handling. Consider `--format jpg` only as an alias; keep the canonical public format name `jpeg`.
3. **SVG verification.** Extend the verifier to the package's own SVG output, including width/height parsing and safe root-element validation. `detectFormat` already recognizes SVG, so the current split is surprising.

Defer unless a concrete consumer requests them:

- **AVIF verification.** The custom encoder supports it and Google Search recognizes AVIF, but cross-social-crawler compatibility and ISO-BMFF parsing make this larger than a focused 0.6 hardening release.
- **Built-in file/batch output.** `render`, standard `writeFile`, and `Promise.all` already compose clearly; a writer would add filesystem policy and overwrite behavior to the API.
- **Node response status/statusText.** Useful for symmetry, but successful image responses are normally 200 and route-level wrappers can own error responses.
- **Direct Node ESM execution of the Next adapter.** Document the Next build/runtime boundary and add a real Next build smoke first; the supported Next application workflow already succeeds.
