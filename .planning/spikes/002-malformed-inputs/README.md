---
spike: 002
name: malformed-inputs
type: standard
validates: "Given malformed or adversarial PNG, JPEG, WebP, and CLI inputs, when 0.5.0 verifies them, then it terminates promptly and rejects structurally invalid data with actionable errors."
verdict: PARTIAL
related: [001]
tags: [security, parser, cli]
---

# Spike 002: Malformed Inputs

## What This Validates

The published verifier terminates promptly, rejects truncated containers, and enforces the format-header and chunk invariants that fall within its documented structural (not full-decode) scope.

## Research

- [PNG Specification, Third Edition](https://www.w3.org/TR/png-3/) defines the legal IHDR field combinations, critical-chunk ordering, required PLTE for indexed images, unknown-critical-chunk behavior, and the maximum zlib window.
- [RFC 9649](https://datatracker.ietf.org/doc/html/rfc9649) defines WebP RIFF padding, extended-canvas limits, animation control requirements, and frame containment.
- [ITU-T T.81](https://www.itu.int/rec/T-REC-T.81) is the normative JPEG-1 definition.

The chosen approach uses exact 0.5.0 APIs and CLI from a clean npm install. It generates valid checksummed PNG chunks, minimal JPEG/WebP headers, exhaustive truncation samples from real encoder fixtures, and malformed length shells. FFmpeg's `ffprobe` and Node's zlib provide secondary decoder signals, while the specifications decide header/container conformance.

## How to Run

```sh
node .planning/spikes/002-malformed-inputs/run.mjs
```

## What to Expect

The harness reports truncation coverage, runtime, and every specification-invalid container that 0.5.0 nevertheless accepts. The script exits successfully when it reproduces the audited 0.5.0 behavior.

## Investigation Trail

- Re-grounded against Spike 001: the registry artifact is usable, so parser results are not checkout/build artifacts.
- Scoped findings to format headers and container topology. CRC verification and full payload decoding are explicitly outside 0.5.0's documented contract and are not classified as defects.
- Sampled 316 truncation points across real PNG, baseline JPEG, lossy WebP, lossless WebP, and alpha WebP fixtures. Every truncation was rejected, the sweep completed in about 11 ms, and no input hung or crashed the process.
- Generated checksummed PNGs whose IHDR fields, critical chunks, or zlib window violated normative format rules. The 0.5.0 API accepted all nine, and its published CLI exited 0 for an unsupported PNG compression method.
- Generated a zero-width JPEG frame. `imageDimensions` returned width 0 even though a JPEG line cannot contain zero samples.
- Generated WebP containers with non-zero RIFF padding, a canvas area above `2^32 - 1`, an animation flag without its mandatory `ANIM` control chunk, and a frame outside its canvas. The 0.5.0 API accepted all four.

## Results

PARTIAL. Truncation resistance and termination behavior are validated, but the verifier's structural contract is not fully enforced.

Confirmed 0.6.0 defects, in priority order:

1. **High — PNG header and critical-chunk validation is incomplete.** Unsupported bit-depth/color combinations, compression/filter/interlace methods, an oversized zlib CINFO window, duplicate IHDR, missing or late PLTE, and unknown critical chunks all verify. These are header/container rules, not full-decode concerns.
2. **Medium — WebP extended-container topology is incomplete.** Canvas area overflow, missing animation control, and out-of-canvas frames verify despite normative `MUST` constraints.
3. **Medium — JPEG zero width is accepted.** The public reader can return `{ width: 0 }`, and `verifyImage` can accept it if called with the same invalid expectation.
4. **Low — non-zero WebP RIFF padding is accepted.** RFC 9649 requires an odd-sized chunk's padding byte to be zero.

Non-findings:

- No truncated real fixture verified successfully.
- No parser hang, unbounded loop, or crash was found.
- CRC mismatch and compressed-payload decode failures remain deliberately outside the documented lightweight-verifier contract.
