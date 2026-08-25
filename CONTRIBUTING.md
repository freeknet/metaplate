# Contributing to Metaplate

Thanks for helping improve Metaplate. The project is a small TypeScript library
with framework-neutral entry points and optional adapters. Keep changes focused,
preserve that separation, and include the reason behind a change as well as the
implementation.

## Reporting issues

Use the GitHub issue forms for bugs and feature requests. A useful bug report
includes the Metaplate version, Node.js version, operating system, package
manager, framework or runtime, affected entry point, and a minimal reproduction.

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md)
instead.

## Development

Metaplate requires Node.js 20 or newer. Install the locked dependency tree:

```sh
npm ci
```

Run the full local gate before opening a pull request:

```sh
npm run check
npm run check:package
```

`npm run check` lints, type-checks, tests, builds, and inspects the npm package
contents. `npm run check:package` goes further: it creates the tarball, checks
that every declared export is present, and installs it into two temporary
consumers. The lean consumer imports every framework-neutral entry point, proves
that no optional renderer peer was pulled in, and confirms the install guidance
a peer-less render reports. The standalone consumer installs the renderer peers
and renders real PNG bytes.

Useful individual commands are:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run check:dependencies
npm run check:deployment
```

## Design constraints

- The root entry point stays framework-neutral. Do not make consumers load
  Next.js, React, Satori, or Resvg merely to construct metadata.
- `next`, `react`, `satori`, and `@resvg/resvg-js` remain optional peer
  dependencies, and the standalone renderer imports Satori and Resvg on first
  use so a lean install stays importable. Test behavior both with and without
  optional peers when changing package boundaries.
- Public APIs need type coverage, behavior tests, and README documentation.
- `examples/` is documentation that compiles. It type-checks against `src/`
  through `tsconfig.examples.json`, so renaming or resigning a public export
  breaks the example rather than the consumer who copied it.
- Do not commit `dist/`, coverage output, logs, `node_modules/`, or `.tgz`
  package archives.
- Keep Node.js 20 compatibility. CI also exercises current LTS lines and the
  platform-specific Resvg package on Linux, macOS, and Windows.

## Dependencies and supply chain

Dependabot opens weekly npm and GitHub Actions updates. Production dependency
updates receive closer review because they become part of the consumer-facing
runtime. Workflow actions are pinned to immutable commit SHAs; update the SHA
and its trailing version comment together. Temporary compatibility ignores are
documented in `.github/dependabot.yml` and should be removed as soon as the
blocking peer dependency supports the newer release.

Install lifecycle scripts are disabled in CI and release verification because
this repository does not require them. A dependency that begins requiring a
script needs an explicit review before that policy changes. The dependency
inventory command classifies lockfile packages by published/runtime reachability,
native-code indicators, install scripts, and non-registry resolutions so Socket
alerts can be triaged without treating expected native rendering packages as
automatic malware findings.

## Releases

1. Update `version` in `package.json` and `package-lock.json` in a pull request.
2. Merge only after CI and CodeQL pass.
3. Create a GitHub release from a matching semver tag such as `v0.2.0`.
4. The publish workflow verifies that the tag matches the package version,
   builds and tests the package without npm credentials, and uploads the exact
   tarball to a separate publish job.
5. Stable versions publish under npm's `latest` tag; prereleases publish under
   `next`. The npm release includes provenance.

The publish job uses the protected GitHub `npm` environment. Configure npm
trusted publishing for that environment when possible. Until then, the job
expects an environment secret named `NPM_TOKEN`; keep it scoped to this package
and rotate it if it is ever exposed.

## Pull requests and commits

Explain what changed, why it changed, and what you ran. Add tests for behavior
changes and update the README for public API changes. Focused commits with
conventional subjects such as `fix:`, `feat:`, `docs:`, `test:`, `build:`, or
`ci:` keep release history readable.
