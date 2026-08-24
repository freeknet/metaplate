# Spike Conventions

Patterns and stack choices established across spike sessions. New spikes follow these unless the question requires otherwise.

## Stack

- Use Node.js ESM scripts that match the package's supported Node `>=20` runtime.
- Install the exact published Metaplate version into a fresh temporary consumer; do not resolve the package under test from the checkout.
- Use current compatible peer versions for integration probes, and record the resolved versions in results.

## Structure

- Keep one self-contained `run.mjs` and one evidence-focused `README.md` per spike.
- Write disposable installations and generated binaries under the operating-system temporary directory; retain only reproducible source and conclusions in `.planning/spikes/`.
- Emit compact JSON reports so behavior can be compared across versions.

## Patterns

- Exercise both runtime JavaScript and published declaration files where the contract includes types.
- Prefer real fonts, encoders, framework builds, and encoder-produced fixtures over mocks for integration claims.
- For parsers, use normative format specifications to determine conformance; permissive third-party decoder behavior is supporting evidence, not the definition of validity.
- Separate header/container validation from full payload decoding whenever the public contract does.

## Tools & Libraries

- Node.js 20, 22, and 24 for supported-runtime probes.
- TypeScript 5.9 with `skipLibCheck: false` and `types: []` for dependency-free declaration probes.
- Satori, Resvg-js, Sharp, Next.js, React, and Fontsource only when a real workflow requires them.
- FFmpeg `ffprobe` and Node zlib as secondary format diagnostics.
