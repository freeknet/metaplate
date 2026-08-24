# Metaplate vX.Y.Z

One paragraph explaining what this release means for users. Lead with the outcome, not the commit history.

> **Upgrade recommendation:** Say who should upgrade and call out any migration risk.

## Why upgrade

Explain the two or three user problems this release solves. This is the executive summary a user should be able to read without opening the changelog.

## Highlights

### User-facing capability

- Describe the benefit and the workflow it unlocks.
- Link the relevant Metaplate section and the exact official upstream framework
  reference when the capability maps to framework routing, metadata, build, or
  deployment behavior.

### Reliability and safety

- Summarize meaningful fixes by their effect on users, not by internal filenames.

## Breaking changes

State migrations explicitly. If there are none, write: `None.`

## Install or upgrade

```sh
npm install metaplate@X.Y.Z
```

The command above must remain sufficient for the framework-neutral renderer.
Explain any peer-range or install-footprint change here; only show a separate
framework install when that framework remains application-supplied (for
example, Next.js).

## Verification

- List the release gates and meaningful integration environments exercised.
- Include package/provenance status when it is known.

## Documentation and support

- [README](https://github.com/lnorton89/metaplate#readme)
- Add direct links to official framework documentation used by this release.
- [npm package](https://www.npmjs.com/package/metaplate)
- [Report a problem](https://github.com/lnorton89/metaplate/issues/new/choose)

## Full changelog

- [Compare vPREVIOUS...vX.Y.Z](https://github.com/lnorton89/metaplate/compare/vPREVIOUS...vX.Y.Z)
- [Detailed changelog](https://github.com/lnorton89/metaplate/blob/vX.Y.Z/CHANGELOG.md)
