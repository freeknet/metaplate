---
spike: 001
name: published-artifact
type: standard
validates: "Given clean consumer projects, when metaplate@0.5.0 is installed, imported, and typechecked, then every documented entrypoint and optional-peer boundary works from the published package."
verdict: VALIDATED
related: []
tags: [npm, packaging, types, node]
---

# Spike 001: Published Artifact

## What This Validates

The exact npm artifact installs independently of the repository and exposes usable JavaScript, declarations, CLI files, and optional-peer failure messages from every public entrypoint.

## Research

The package declares Node.js `>=20`, ESM-only conditional exports, seven public entrypoints, one CLI binary, and optional peers for Satori, Resvg, Next.js, and React. The chosen approach is a clean temporary consumer installed from `metaplate@0.5.0`, followed by runtime and declaration probes against only that installation.

## How to Run

Run from the repository root:

```sh
node .planning/spikes/001-published-artifact/run.mjs
```

## What to Expect

Imports and declaration resolution succeed without optional peers; invoking peer-backed operations fails with the documented install guidance; the tarball contains every exported target and executable CLI.

## Investigation Trail

- Started from a clean `main` checkout and treated the npm registry artifact as authoritative.
- Installed only `metaplate@0.5.0` and TypeScript with npm's optional dependencies omitted. None of Satori, Resvg, Next.js, or React appeared at the consumer's top level.
- Imported all seven public entrypoints and exercised all three optional-peer failure boundaries on Node 20.20.2, 22.19.0, and 24.19.0.
- Typechecked the core, font, image, PNG, SVG-renderer, and Node-renderer declarations with `types: []`, no React types, and no Node types.
- Packed the registry release: 28 files, including each JavaScript export, declaration, source map, README, changelog, license, and executable CLI target.
- Ran `npm audit signatures`: both installed packages had verified registry signatures and Metaplate had a verified provenance attestation.

## Results

VALIDATED. The published artifact matched the package contract across all tested supported Node lines. No packaging, entrypoint, optional-peer, type-surface, CLI-publication, integrity, or provenance defect was found.

Evidence from the clean consumer:

- Registry version: `0.5.0`
- Tarball: 73,782 bytes compressed; 307,520 bytes unpacked; 28 files
- Supported runtime probes: Node 20.20.2, 22.19.0, and 24.19.0
- Declaration probe: passed without `@types/node`, React, or `@types/react`
- Optional-peer diagnostics: Satori-only, Satori plus Resvg, and Next.js cases all named the correct install command
