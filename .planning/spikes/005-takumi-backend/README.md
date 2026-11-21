---
spike: 005
name: takumi-backend
type: standard
validates: "Given metaplate's own { type, props } trees, when rendered by metaplate/node (Satori+resvg) and by takumi-js 2.22.1, then the images match closely enough, Takumi's layout data can drive metaplate's render guards, and the Wasm build runs within Cloudflare Workers limits."
verdict: PARTIAL
related: []
tags: [rendering, takumi, workers, guards]
---

# Spike 005: Takumi backend

Results and recommendation:
[`.planning/research/takumi-spike-2026-11-20.md`](../../research/takumi-spike-2026-11-20.md).

## What This Validates

- **Parity.** 19 fixtures covering fonts and fallback, CJK, Arabic, emoji,
  images, gradients, `inset`, line clamp and ellipsis, overflow, shadows, flex
  and four sizes, compared with metaplate's `compareImages`.
- **Guard hooks.** What `measure()`, `loadFallbackFonts`, the `takumi:` warnings,
  and `format: "raw"` expose for each render guard.
- **Hosted CPU.** A real Workers deploy of the same card (`worker/`).

## How to Run

```sh
node .planning/spikes/005-takumi-backend/run.mjs
```

It creates a temporary consumer, installs the pinned versions (the native
bindings come from optional dependencies), and copies `tests/fixtures/card.jpg`
and `tests/fixtures/card.png` (deliberately truncated). It then draws a valid
`photo.png` with resvg-js and runs:

- `parity.mjs wasm` and `parity.mjs native`: Satori and Takumi renders,
  `compareImages` diffs, Takumi `measure()` trees, and warnings, written to
  `<consumer>/out/`;
- `sheet.mjs`: side-by-side contact sheets of the diffs;
- `probe.mjs`: the `loadFallbackFonts` hook, box-sizing default, invalid styles,
  raw output, and an off-canvas blank frame.

It prints a JSON summary and the output directory.

The hosted test is manual, because it needs a Cloudflare login:

```sh
cd .planning/spikes/005-takumi-backend/worker
npm install
npx --yes wrangler@4.156.0 deploy
npx --yes wrangler@4.156.0 tail metaplate-takumi-spike --format json > tail.jsonl
# request /og/<title> repeatedly, then:
node parse-tail.mjs
npx --yes wrangler@4.156.0 delete --name metaplate-takumi-spike --force
```

## Results

Verdict PARTIAL. The renderer matches closely, runs in workerd, and can feed
five of the six guards. Uncached renders exceed the Workers Free plan's 10 ms
CPU limit on most requests (p50 13–14 ms warm, 88–243 ms cold), and `avoid`
needs a key mapping Takumi does not provide. Full tables are in the research
note.
