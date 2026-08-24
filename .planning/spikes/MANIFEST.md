# Spike Manifest

## Idea

Audit the exact `metaplate@0.5.0` package that consumers receive from npm, using clean consumer projects and adversarial inputs, to identify confirmed defects and high-value missing workflows for a focused 0.6.0 release.

## Requirements

- Test the published npm artifact rather than relying only on the repository checkout.
- Separate confirmed defects from feature requests and rank both by consumer impact.
- Preserve every confirmed defect as a reproducible regression case.
- Keep the audit compatible with the documented Node.js `>=20` support floor.

## Spikes

| # | Name | Type | Validates | Verdict | Tags |
|---|------|------|-----------|---------|------|
| 001 | published-artifact | standard | Given clean consumer projects, when `metaplate@0.5.0` is installed, imported, and typechecked, then every documented entrypoint and optional-peer boundary works from the published package. | VALIDATED | npm, packaging, types, node |
| 002 | malformed-inputs | standard | Given malformed or adversarial PNG, JPEG, WebP, and CLI inputs, when 0.5.0 verifies them, then it terminates promptly and rejects structurally invalid data with actionable errors. | PENDING | security, parser, cli |
| 003 | documented-workflows | standard | Given README-style metadata, standalone render, Next adapter, font, response, and custom-output consumers, when run outside the repository, then observable output matches the documented contract. | PENDING | docs, integration, rendering |
| 004 | release-gaps | standard | Given common social-image release workflows, when attempted with 0.5.0, then workarounds and missing primitives reveal a prioritized, evidence-backed 0.6.0 scope. | PENDING | product, ergonomics, roadmap |
