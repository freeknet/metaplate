# Static Next.js site

A complete Next.js site with `output: "export"` and a social card for every page,
rendered by `metaplate render` before the build. The
[Static Next.js sites](../../docs/static-next-site.md) guide explains each file.

```sh
npm install
npm test
npm run build
```

`npm run build` runs three things in order:

1. `prebuild` renders each card into `public/<route>/og-image.png`, and fails if any
   card fails a guard.
2. `next build` exports the site to `out/`.
3. `postbuild` audits every exported page against the file its `og:image` names.

| File | What it does |
| --- | --- |
| `src/lib/site.ts` | Site values, brand colors, and the list of static routes |
| `src/content/guides.ts` | Stands in for a CMS |
| `src/lib/og/cards.ts` | What each card says |
| `src/lib/og/plate.tsx` | The design |
| `src/lib/og/cards.render.tsx` | Tells `metaplate render` which pages to draw |
| `src/lib/og/metadata.ts` | Each page's metadata, with its card |
| `scripts/render-cards.mts` | Runs the render under `tsx`, on any platform |
| `scripts/audit-export.mts` | Checks every exported page against its card |
| `tests/cards.test.ts` | Runs the guards and platform checks in the test suite |

This repository type-checks these files against `src/`, so a change to the public API
breaks the example instead of the people copying it. The site's own `tsconfig.json` is
for running it as a standalone project.
