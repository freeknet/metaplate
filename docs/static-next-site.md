# Static Next.js sites

Social cards for a Next.js site built with `output: "export"`, from the first
file to the post-deploy check. Every file below comes from
[`examples/next-static-site`](https://github.com/freeknet/metaplate/tree/main/examples/next-static-site),
which is type-checked in this repository, so copy it as a starting point.

You end up with:

- one plate that defines the design, and one module that holds what each card says;
- a real `og-image.png` beside each page, written before `next build` and served by any static host;
- metadata that cannot point at a file that does not exist, checked by an audit that fails the build;
- a route with no card as a type error, and a title that stops fitting as a build failure.

## Contents

- [Choose an approach](#choose-an-approach)
- [1. Install and configure](#1-install-and-configure)
- [2. Write what each card says](#2-write-what-each-card-says)
- [3. Define the plate](#3-define-the-plate)
- [4. Render before the build](#4-render-before-the-build)
- [5. Point each page at its card](#5-point-each-page-at-its-card)
- [6. Audit the export](#6-audit-the-export)
- [7. Check it after the deploy](#7-check-it-after-the-deploy)
- [Deploying under a `basePath`](#deploying-under-a-basepath)
- [Using route handlers instead](#using-route-handlers-instead)
- [Troubleshooting](#troubleshooting)

## Choose an approach

| Approach | Files per page | Formats | [Guards](rendering.md#render-guards) | Use it when |
| --- | --- | --- | --- | --- |
| **`metaplate render` before `next build`** (this guide) | None | Any | Yes | You have more than one card. This is the default. |
| [Route handlers with `createNodeOg`](#using-route-handlers-instead) | One route file | Any | Yes | You would rather have no step before the build. |
| [Route handlers with `createNextOg`](nextjs.md#nextjs-adapter) | One route file | PNG | No | PNG is enough, and you want no renderer outside Next. |
| [`opengraph-image.tsx`](nextjs.md#nextjs-static-export-and-basepath) | One metadata file | PNG | No | The site is at the root of its domain and your host handles a file with no extension. |
| [A build script](rendering.md#express-and-build-scripts) | None | Any | Yes | You have one card and no route to map it to. |

Rendering first has two advantages on a static site. No per-page route file has
to exist, so the tenth card costs one entry in a list. And the cards are ordinary
files at paths you choose, so a host needs no rule to serve them with the right
type.

## 1. Install and configure

```sh
npm install metaplate @fontsource/inter @fontsource/jetbrains-mono
npm install --save-dev tsx
```

`tsx` runs the JSX plate outside Next. Pages import the plate to build their
metadata, so Next has to be told not to bundle the renderer:

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // No image optimizer runs behind a static export.
  images: { unoptimized: true },
  // `/pricing/` is written as `pricing/index.html`, beside `pricing/og-image.png`.
  trailingSlash: true,
  // Pages import the plate to build their metadata. The renderer loads only when
  // something renders, but Turbopack still traces the import and cannot bundle
  // Resvg's native binary or Satori's Wasm.
  serverExternalPackages: ["@resvg/resvg-js", "satori"],
};

export default nextConfig;
```

`tsconfig.json` needs `"jsx": "react-jsx"`. With `"preserve"`, `tsx` compiles the
plate for the classic JSX runtime and every render fails with `React is not
defined`.

Site-wide values go in a module that both the pages and the plate can read.
Colors belong here too, because Satori does not read CSS custom properties:

```ts
// src/lib/site.ts
export const SITE = {
  name: "Fieldnotes",
  origin: "https://fieldnotes.example",
  locale: "en_US",
} as const;

/** Colors live in a module because Satori does not read CSS custom properties. */
export const BRAND = {
  ground: "#10201c",
  text: "#f2efe6",
  muted: "#a9b8b0",
  accent: "#e8a33d",
} as const;

/** Every route with hand-written copy. Adding one here requires a card in cards.ts. */
export const STATIC_ROUTES = ["/", "/pricing/"] as const;
export type StaticRoute = (typeof STATIC_ROUTES)[number];
```

## 2. Write what each card says

Keep the copy in one module rather than exporting it from each `page.tsx`. Two
programs read it, the pages and `metaplate render`, and only one of them is Next.
A `Record` over the route list makes a missing card a type error, and a page that
reads its card from data gets one the same way:

```ts
// src/lib/og/cards.ts
import { GUIDES, type Guide } from "../../content/guides";
import type { StaticRoute } from "../site";

/*
 * What each card says. Plain data with no import from Next or the renderer,
 * because two programs read it: the pages, for their metadata, and
 * `metaplate render`, through ./cards.render.tsx.
 */
export type CardCopy = {
  /** Small label above the title. */
  eyebrow: string;
  title: string;
  /** One sentence under the title. */
  description: string;
  /** Alternative text for the image itself, not a description of the page. */
  alt: string;
};

/** The `Record` makes a static route without a card a type error. */
export const CARDS: Record<StaticRoute, CardCopy> = {
  "/": {
    eyebrow: "Field guides",
    title: "Notes from people who have been there.",
    description: "Practical guides to coastal survey work, written after the trip.",
    alt: "Fieldnotes: notes from people who have been there.",
  },
  "/pricing/": {
    eyebrow: "Pricing",
    title: "One price for the whole crew.",
    description: "No seats and no per-site fees. Cancel at the end of any season.",
    alt: "Fieldnotes pricing: one price for the whole crew.",
  },
};

export const guideRoute = (guide: Guide) => `/guides/${guide.slug}/`;

export function guideCard(guide: Guide): CardCopy {
  return {
    eyebrow: "Guide",
    title: guide.title,
    description: guide.summary,
    alt: `Fieldnotes guide: ${guide.title}.`,
  };
}

/** Every page with a card: what `metaplate render` draws and the tests check. */
export const ALL_CARDS: readonly { route: string; copy: CardCopy }[] = [
  ...Object.entries(CARDS).map(([route, copy]) => ({ route, copy })),
  ...GUIDES.map((guide) => ({ route: guideRoute(guide), copy: guideCard(guide) })),
];
```

A card's headline and a page's `<title>` do different jobs. A title is read in a
list of search results, where a label such as "Pricing" works best. A card is read
in a chat window with nothing around it, where a full sentence works best. That is
why `pageMetadata` below takes them separately.

## 3. Define the plate

```tsx
// src/lib/og/plate.tsx
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";
import { BRAND, SITE } from "../site";
import type { CardCopy } from "./cards";

/** Drawn inline, so it needs no file. Geometry only: no `<title>`, no CSS classes. */
function Mark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="13" fill="none" stroke={BRAND.accent} strokeWidth="3" />
      <path d="M9 19c4-3 10-3 14 0" fill="none" stroke={BRAND.text} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export const og = createNodeOg<CardCopy>({
  alt: (copy) => copy.alt,
  // A real extension, so a static host knows the type without any header rules.
  imagePath: "og-image.png",
  // Absolute image URLs: crawlers require them, and the tests can check them as
  // they are published instead of relying on Next's `metadataBase`.
  origin: SITE.origin,
  // Crawlers cache an image by its URL, so a changed card gets a new `?v=`. Raise
  // `revision` when the layout changes what unchanged copy looks like.
  version: "copy",
  revision: "1",
  fonts: fontsourceFontLoader([
    { font: "inter", weight: 400 },
    { font: "inter", weight: 700 },
    { font: "jetbrains-mono", weight: 500 },
  ]),
  // A title that no longer fits, or a character no font covers, fails the build.
  guards: { missingGlyphs: "error", overflow: "error", safeArea: "error", blank: "error" },
  component: (copy) => (
    <div
      style={{
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px 72px",
        background: BRAND.ground,
        color: BRAND.text,
        fontFamily: "Inter",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Mark size={48} />
        <span style={{ fontSize: 30, fontWeight: 700 }}>{SITE.name}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span
          style={{
            fontFamily: "JetBrains Mono",
            fontWeight: 500,
            fontSize: 20,
            letterSpacing: 2,
            textTransform: "uppercase",
            color: BRAND.accent,
          }}
        >
          {copy.eyebrow}
        </span>
        <span style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.08, marginTop: 18 }}>
          {copy.title}
        </span>
        <span style={{ fontSize: 26, fontWeight: 400, lineHeight: 1.4, color: BRAND.muted, marginTop: 20 }}>
          {copy.description}
        </span>
      </div>
    </div>
  ),
});
```

This plate is PNG because it is flat color. A card with a photograph in it should
be JPEG; see [Text beside a photograph](recipes.md#text-beside-a-photograph). While
you design it, [`metaplate preview`](preview.md) shows every card with layout boxes
and crop overlays, and reloads on save.

## 4. Render before the build

A render module tells `metaplate render` which plate draws which pages:

```tsx
// src/lib/og/cards.render.tsx
import type { RenderJob, RenderModule } from "metaplate/node";
import { ALL_CARDS, type CardCopy } from "./cards";
import { og } from "./plate";

const job = { plate: og, pages: ALL_CARDS } satisfies RenderJob<CardCopy>;

export default [job] satisfies RenderModule;
```

Node cannot load JSX, so run the command in-process under `tsx`. This works the
same on Windows, macOS, and Linux:

```ts
// scripts/render-cards.mts
import { runCli } from "metaplate/cli";

/*
 * Runs `metaplate render` in-process under tsx, so the command's import of the
 * JSX module goes through tsx's loader. That needs no `NODE_OPTIONS=`, which an
 * npm script cannot set on Windows. The manifest stays out of `public/` so it is
 * not published.
 */
const code = await runCli([
  "render",
  "--out",
  "public",
  "--manifest",
  ".og-manifest.json",
  "src/lib/og/cards.render.tsx",
]);
process.exit(code);
```

Run it before both the dev server and the build. Use the `.mts` extension: without
`"type": "module"` in `package.json`, `tsx` compiles a `.ts` script to CommonJS and
rejects its top-level `await`.

```json
{
  "scripts": {
    "cards": "tsx scripts/render-cards.mts",
    "predev": "npm run cards",
    "prebuild": "npm run cards",
    "postbuild": "tsx scripts/audit-export.mts"
  }
}
```

The cards are build output, so keep them and the manifest out of git:

```text
.og-manifest.json
public/**/og-image.png
```

A successful run writes:

```text
public/og-image.png
public/pricing/og-image.png
public/guides/first-survey/og-image.png
public/guides/reading-the-tide-tables/og-image.png
.og-manifest.json
```

Next copies `public/` into `out/`, so each card lands beside its page. If any card
fails, every failure is reported, the command exits `1`, and `prebuild` stops the
build.

## 5. Point each page at its card

Next [shallow-merges metadata](nextjs.md#nextjs-adapter): a page that sets
`openGraph` replaces the layout's whole object. Nothing warns you, and the page
quietly loses `og:site_name` and `og:type`. So write the composition once and send
every page through it:

```ts
// src/lib/og/metadata.ts
import type { Metadata } from "next";
import { SITE } from "../site";
import type { CardCopy } from "./cards";
import { og } from "./plate";

type PageText = {
  /** The `<title>`, before any template the layout applies. A label, not a sentence. */
  title: string;
  description: string;
};

/*
 * Next shallow-merges metadata, so a page's `openGraph` replaces the layout's
 * whole object. Every page comes through here, which restates the site fields.
 */
export function pageMetadata(route: string, page: PageText, card: CardCopy): Metadata {
  const social = og.metadata(route, card);
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: route },
    openGraph: {
      siteName: SITE.name,
      type: "website",
      locale: SITE.locale,
      url: route,
      title: card.title,
      description: card.description,
      images: social.openGraph.images,
    },
    twitter: {
      ...social.twitter,
      title: card.title,
      description: card.description,
    },
  };
}
```

Importing the plate here does not load Satori or Resvg. They load on the first
render, which no page ever does.

The layout supplies the base URL for the relative `canonical` and `og:url`:

```tsx
// src/app/layout.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SITE } from "../lib/site";

export const metadata: Metadata = {
  // Resolves the relative `canonical` and `og:url` that pages state.
  metadataBase: new URL(SITE.origin),
  title: { default: SITE.name, template: `%s · ${SITE.name}` },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

A page with fixed copy is then three lines of metadata:

```tsx
// src/app/pricing/page.tsx
import { CARDS } from "../../lib/og/cards";
import { pageMetadata } from "../../lib/og/metadata";

export const metadata = pageMetadata(
  "/pricing/",
  { title: "Pricing", description: "One price for the whole crew, with no per-site fees." },
  CARDS["/pricing/"],
);

export default function Pricing() {
  return <h1>{CARDS["/pricing/"].title}</h1>;
}
```

A page generated from data derives its card from the same record that
`ALL_CARDS` rendered, so the two cannot disagree:

```tsx
// src/app/guides/[slug]/page.tsx
import { GUIDES, getGuide } from "../../../content/guides";
import { guideCard, guideRoute } from "../../../lib/og/cards";
import { pageMetadata } from "../../../lib/og/metadata";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return GUIDES.map((guide) => ({ slug: guide.slug }));
}

export async function generateMetadata({ params }: Props) {
  const guide = getGuide((await params).slug);
  return pageMetadata(
    guideRoute(guide),
    { title: guide.title, description: guide.summary },
    guideCard(guide),
  );
}

export default async function GuidePage({ params }: Props) {
  const guide = getGuide((await params).slug);
  return <h1>{guide.title}</h1>;
}
```

The routes passed to `pageMetadata` and to `metaplate render` have to match,
including the trailing slash, because the route decides both the file path and
the URL. Keeping `guideRoute` in one place is what guarantees that.

## 6. Audit the export

`metaplate render` proves the files are good. It cannot prove a page points at
them. The audit in [Testing your cards](testing.md#audit-the-whole-export) reads
every exported page, finds the file its `og:image` names, and verifies the bytes
against the tags, with no network and no server. `postbuild` above runs it, so a
page with a missing card fails the build:

```text
Social card audit failed:
  pricing/index.html: https://fieldnotes.example/pricing/og-image.png?v=00a25771 is not in the export
```

## 7. Check it after the deploy

The tags name your production origin, so the deployed site is the first place the
whole chain can be fetched as a crawler sees it:

```sh
npx metaplate verify-page --target linkedin --target slack https://fieldnotes.example/pricing/
```

[`verify-page`](verify-page.md) reads the page's tags, fetches every image they
name, and checks each one. A local run against `out/` fails to resolve the
production host, which is why step 6 works from the files instead.

## Deploying under a `basePath`

A GitHub Pages project site, for example, lives at `/project/`. Set the same prefix
in both places:

```ts
// In next.config.ts:
const nextConfig: NextConfig = { output: "export", basePath: "/project" /* ... */ };

// In src/lib/og/plate.tsx:
export const og = createNodeOg<CardCopy>({ basePath: "/project", origin: SITE.origin /* ... */ });
```

The tag gains the prefix, and the file does not, which is what the host expects:

| | Without `basePath` | With `basePath: "/project"` |
| --- | --- | --- |
| `og:image` | `https://example.github.io/pricing/og-image.png` | `https://example.github.io/project/pricing/og-image.png` |
| File | `public/pricing/og-image.png` | `public/pricing/og-image.png` |

In the audit, remove the prefix from the URL's `pathname` before joining it to
`out/`. Next's `opengraph-image.tsx` convention
[does not work under a prefix](nextjs.md#nextjs-static-export-and-basepath), so use
this approach or a route handler.

## Using route handlers instead

A route handler renders during `next build`, so no step runs before the build. The
cost is one route file per page. Name the folder after the file, so the export
writes a real `.jpg` or `.png`:

```ts
// src/app/pricing/og-image.png/route.ts
import { CARDS } from "@/lib/og/cards";
import { og } from "@/lib/og/plate";

export const dynamic = "force-static";
export const GET = og.handler(CARDS["/pricing/"]);
```

A dynamic segment needs `generateStaticParams` like any other static route, and
`handlerFrom` forwards Next's arguments to your resolver. `params` is a promise:

```ts
// src/app/guides/[slug]/og-image.png/route.ts
import { GUIDES, getGuide } from "@/content/guides";
import { guideCard } from "@/lib/og/cards";
import { og } from "@/lib/og/plate";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return GUIDES.map((guide) => ({ slug: guide.slug }));
}

export const GET = og.handlerFrom(
  async (_request: Request, { params }: { params: Promise<{ slug: string }> }) =>
    guideCard(getGuide((await params).slug)),
);
```

Everything else in this guide still applies: the plate, `pageMetadata`, and the
audit. With `createNextOg` the same two files work, without `serverExternalPackages`
but also without guards or JPEG.

A folder named just `og-image` exports a file with no extension. A static host then
has nothing to infer the type from, and may serve it as a generic download that
crawlers reject. Rename the folder, or add
[header rules](deployment.md#static-hosts) if the URL has to stay.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `render failed: React is not defined` | `tsx` compiled the plate for the classic JSX runtime. Set `"jsx": "react-jsx"` in `tsconfig.json`, and make sure its `include` covers the plate: `tsx` applies the setting only to files the config includes. |
| Vitest: `Failed to parse source for import analysis` | Same setting: Vitest cannot run JSX under `"jsx": "preserve"`. |
| `'NODE_OPTIONS' is not recognized` | An npm script on Windows runs through `cmd.exe`. Use the `tsx` script from [step 4](#4-render-before-the-build). |
| Build: `non-ecmascript placeable asset`, or `ENOENT ... hb.wasm` when rendering | A page or route reaches `metaplate/node`, and Turbopack is bundling the renderer. Add [`serverExternalPackages`](#1-install-and-configure). |
| The card is set in the wrong typeface, with no error | `fontFamily` must equal the family's name exactly, such as `"JetBrains Mono"`. See [Several fonts](recipes.md#several-fonts). |
| A shared link shows the old card | The crawler cached the old URL. `version: "copy"` gives changed copy a new URL; raise `revision` when only the layout changed. See [Versioned image URLs](metadata.md#versioned-image-urls). |
| `verify-page` cannot resolve your host on a local run | The tags name the production origin. Use [the audit](testing.md#audit-the-whole-export) before the deploy. |
| `verifySocialImage` reports an absolute HTTPS URL is required | The plate has no `origin`. See [Check bytes against the descriptor](testing.md#check-bytes-against-the-descriptor). |
| The overflow guard says the text needs more room than its container has | The text is too long for the card. See [Long titles](recipes.md#long-titles). |
