# Next.js on Cloudflare Workers

A Next.js app deployed to Cloudflare Workers with
[`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare) runs its pages in
workerd, where neither `metaplate/node` nor `metaplate/edge` can render (see
[Edge runtimes](deployment.md#edge-runtimes)). The pattern that works is hybrid:

- the cards are rendered with [`metaplate render`](render-cli.md) into `public/`
  before the build, and served as static files;
- the pages stay server-rendered on the Worker, and build their metadata from a
  [plate contract](#1-define-the-contract) in the root `metaplate` entry, which
  imports no renderer.

The contract is what keeps the two halves in step. The pages and the render step
read the same `imagePath`, `version`, and `revision`, so a page cannot point at a
URL the build did not write.

To render on the Worker itself instead, use the experimental
[`metaplate/takumi`](takumi.md), which runs on Workers. Its plates take the same
contract.

## Contents

- [1. Define the contract](#1-define-the-contract)
- [2. Add the renderer for the build](#2-add-the-renderer-for-the-build)
- [3. Render before the build](#3-render-before-the-build)
- [4. Point each page at its card](#4-point-each-page-at-its-card)
- [5. Deploy and check](#5-deploy-and-check)
- [What not to do](#what-not-to-do)

## 1. Define the contract

`definePlate` takes the options that decide a plate's URLs and metadata, and
nothing that renders. It comes from the root entry, which imports no Satori,
Resvg, React, Next, or Takumi, so it is safe in any server bundle:

```ts
// src/lib/og/contract.ts
import { definePlate } from "metaplate";

export type CardCopy = { title: string; description: string };

export const card = definePlate({
  alt: (copy: CardCopy) => `${copy.title}: ${copy.description}`,
  imagePath: "og-image.png",
  version: "copy",
  revision: "2026-11",
});
```

Give `imagePath` a real extension: static assets get their `Content-Type` from it.
`version: "copy"` adds `?v=<token>` to each image URL in the metadata, derived from
the copy and `revision`, so a crawler that cached an old card fetches the new one.
The files on disk never carry the token.

The contract also takes `size`, `variants`, `basePath`, `origin`, and
`contentType`. Set `contentType: "image/jpeg"` when the renderer encodes JPEG
(see [Other output formats](rendering.md#other-output-formats)); the renderer
refuses a contract whose type it does not produce.

## 2. Add the renderer for the build

The renderer lives in its own module, which only the render step imports. Spread
the contract in and add what draws the card:

```tsx
// src/lib/og/plate.tsx
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";
import { card } from "./contract";

export const og = createNodeOg({
  ...card,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  component: (copy) => (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", padding: 72 }}>
      <div style={{ fontSize: 72, fontFamily: "Inter" }}>{copy.title}</div>
      <div style={{ fontSize: 36, fontFamily: "Inter" }}>{copy.description}</div>
    </div>
  ),
});
```

The copy type comes from the contract's `alt`, so `component` is typed without an
annotation, and an option the renderer does not take is still a type error. Both
`og.metadata(route, copy)` and `card.metadata(route, copy)` run the same code and
return the same result, for every size, variant, and version option.

## 3. Render before the build

Keep each card's copy in a module that both the pages and the render step import,
as [Static Next.js sites](static-next-site.md#2-write-what-each-card-says) does:

```ts
// src/lib/og/cards.ts
import type { CardCopy } from "./contract";

export const CARDS = {
  "/": { title: "Field Notes", description: "Survey notes for small crews." },
  "/pricing/": { title: "Pricing", description: "One price for the whole crew." },
} satisfies Record<string, CardCopy>;
```

The render module, which only `metaplate render` loads, pairs the plate with those
pages:

```tsx
// src/lib/og/cards.render.tsx
import type { RenderJob, RenderModule } from "metaplate/node";
import { CARDS } from "./cards";
import type { CardCopy } from "./contract";
import { og } from "./plate";

const pages = Object.entries(CARDS).map(([route, copy]) => ({ route, copy }));

export default [{ plate: og, pages } satisfies RenderJob<CardCopy>] satisfies RenderModule;
```

Then run `metaplate render` into `public/` from `prebuild`, the same way
[Render before the build](static-next-site.md#4-render-before-the-build) does for a
static export (that section's `scripts/render-cards.mts` runs the command under
`tsx` so the JSX module loads on every platform):

```json
{
  "scripts": {
    "cards": "tsx scripts/render-cards.mts",
    "predev": "npm run cards",
    "build": "next build",
    "prebuild": "npm run cards",
    "preview": "opennextjs-cloudflare build && opennextjs-cloudflare preview",
    "deploy": "opennextjs-cloudflare build && opennextjs-cloudflare deploy"
  }
}
```

The [OpenNext get-started guide](https://opennext.js.org/cloudflare/get-started)
says the `build` script must run the Next.js build, and that
`opennextjs-cloudflare build` invokes it. Because npm runs it as a script,
`prebuild` runs first, so every deploy renders the cards before Next builds. If a
card fails, `metaplate render` exits `1` and the deploy stops.

Files in `public/` are served as
[Workers static assets](https://developers.cloudflare.com/workers/static-assets/):
a request that matches a file is answered with it, without running the Worker.
OpenNext's [caching guide](https://opennext.js.org/cloudflare/caching) notes that
the Worker does not run in front of static assets and that `public/` files keep
Next's default caching. Keep the cards and the manifest out of git, as build
output:

```text
.og-manifest.json
public/**/og-image.png
```

## 4. Point each page at its card

Pages import the contract, never the plate:

```tsx
// src/app/pricing/page.tsx
import type { Metadata } from "next";
import { card } from "../../lib/og/contract";
import { CARDS } from "../../lib/og/cards";

const copy = CARDS["/pricing/"];
const social = card.metadata("/pricing/", copy);

export const metadata: Metadata = {
  title: "Pricing",
  openGraph: { title: copy.title, description: copy.description, images: social.openGraph.images },
  twitter: { ...social.twitter, title: copy.title, description: copy.description },
};
```

`generateMetadata` works the same way for dynamic routes, provided the render
module lists the same routes and copy. Set `metadataBase` in the layout so Next
resolves the root-relative image URLs, or give the contract an `origin`. Next
shallow-merges `openGraph`, so a shared helper that restates the site fields, like
[`pageMetadata`](static-next-site.md#5-point-each-page-at-its-card), is still worth
writing; build it on `card.metadata` instead of the plate.

Open Graph video and audio URLs passed through `media` must be absolute, because
Next emits them without resolving `metadataBase`. `createNextOg` checks this;
`card.metadata` does not.

## 5. Deploy and check

```sh
npm run deploy
npx metaplate verify-page --target linkedin --target slack https://fieldnotes.example/pricing/
```

[`verify-page`](verify-page.md) reads the deployed page's tags, fetches every image
URL they name, including the `?v=` token, and checks each one, so it confirms that
the Worker serves the HTML and that the static assets serve the cards it names.

## What not to do

- **Do not import the plate into a page or layout.** The plate imports
  `metaplate/node`, so the Worker's server bundle would depend on a renderer that
  cannot run in workerd, and on the bundler to leave it out. Import the contract.
- **Do not copy `serverExternalPackages: ["@resvg/resvg-js", "satori"]`.** That
  setting in the [static-site guide](static-next-site.md#1-install-and-configure)
  is for pages that import the plate, so Next loads the renderer at run time
  instead of bundling it. With the contract, no page reaches the renderer, and
  there is nothing to keep external.
- **Do not restate `imagePath`, `version`, or `revision` in page code.** Building
  metadata from `socialImageMetadata` and `socialImageVersion` by hand works until
  the plate changes and the pages do not. Spread the contract into the plate
  instead.
