# Next.js

The `metaplate/next` adapter, static export with `basePath`, and JPEG or WebP cards in Next.js.
## Next.js adapter

Next applications can use the native `next/og` pipeline while keeping the same
route and metadata pattern. Read this alongside Next's official
[Metadata and OG images](https://nextjs.org/docs/app/getting-started/metadata-and-og-images)
and
[`opengraph-image` file convention](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/opengraph-image):

```tsx
// src/lib/og.tsx
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNextOg } from "metaplate/next";

export type OgCopy = {
  eyebrow: string;
  title: string;
  description: string;
  alt: string;
};

export const og = createNextOg<OgCopy>({
  alt: (copy) => copy.alt,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  component: (copy) => (
    <div style={{ width: "100%", height: "100%", display: "flex" }}>
      {copy.title}
    </div>
  ),
});
```

Next [shallow-merges metadata](https://nextjs.org/docs/app/api-reference/functions/generate-metadata):
a page that sets `openGraph` **replaces** the root layout's rather than extending
it. Spreading `og.metadata()` straight into
a page therefore drops every other Open Graph field the layout contributed —
`siteName`, `type`, `locale`, `url` — from that page's tags. Nothing errors and
the build stays green; the loss shows only in the emitted HTML.

Write the composition once, next to the plate, and call it from each page:

```tsx
// src/lib/metadata.ts
import type { Metadata } from "next";
import { og, type OgCopy } from "./og";

/** Site-level fields the root layout spreads into its own `openGraph`. */
export const openGraph = {
  siteName: "Example",
  type: "website",
  locale: "en_US",
};

export function pageMetadata(route: string, copy: OgCopy): Metadata {
  const social = og.metadata(route, copy);

  return {
    title: copy.title,
    description: copy.description,
    openGraph: {
      ...openGraph,
      // `url` is per-route, so it cannot live in the shared constant, and the
      // layout's own `url` is replaced along with everything else.
      url: route,
      // Without this, Next fills `og:title` from the document title, including
      // any `title.template` suffix the layout defines.
      title: copy.title,
      description: copy.description,
      images: social.openGraph.images,
    },
    twitter: social.twitter,
  };
}
```

Keep the copy next to the page it describes:

```tsx
// src/app/roadmap/page.tsx
import { pageMetadata } from "@/lib/metadata";

export const copy = {
  eyebrow: "What comes next",
  title: "Roadmap",
  description: "A dependency-ordered view of the work ahead.",
  alt: "Project roadmap",
};

export const metadata = pageMetadata("/roadmap", copy);
```

One function rather than a spread per page is deliberate: the fields above have
to be restated on every route that sets `openGraph` at all, and a route that
forgets one loses it silently.

To validate these page fields rather than write them by hand,
`nextPageMetadata` maps `socialMetaTags`' page options (including `locale`,
the `article:` fields, and Discord's `og:pubdate`) onto `openGraph` and
`other`, and `nextPageViewport` puts `themeColor` in the `viewport` export,
where Next 14 moved it. See [page-level tags](metadata.md#page-level-tags).

If the layout sets no Open Graph fields and neither does the page, spreading
the whole result stays correct:

```tsx
export const metadata = { title: copy.title, ...og.metadata("/roadmap", copy) };
```

Then expose the predictable route:

```tsx
// src/app/roadmap/og-image/route.tsx
import { og } from "@/lib/og";
import { copy } from "../page";

export const dynamic = "force-static";
export const GET = og.handler(copy);
```

For Next's `opengraph-image.tsx` convention, call `og.render(copy)` from the
default export and re-export `og.size` and `og.contentType` as its constants.
That convention assumes a root-deployed app; see
[Next.js static export and `basePath`](#nextjs-static-export-and-basepath)
before using it behind a deployment prefix.

Each view of a plate renders exactly one size. `plate.size` is both the
definition size and the size `render`/`renderSvg`/`response` use, so the bytes
Metaplate produces and the dimensions it advertises (`og:image:width`/`height`)
can never disagree. A plate that needs a second size declares it as a
[variant](variants.md), whose view keeps the same rule. Size values must be integers between 1 and 65535; `socialImage`,
`socialImageMetadata`, and every plate definition reject anything else at the
boundary.

### Next.js static export and `basePath`

Next's special `app/opengraph-image.tsx` file suits a root-deployed app: set
`dynamic = "force-static"` and Next prerenders the `ImageResponse` during
`next build` with [`output: "export"`](https://nextjs.org/docs/app/guides/static-exports)
enabled.

Under a deployment `basePath`, that file still prerenders and the build still
reports success, but the card is unusable for two independent reasons:

- **The emitted file has no extension.** `out/opengraph-image` holds PNG bytes
  with nothing to tell a static host so. The
  [Static hosts](deployment.md#static-hosts) section fixes that for route handlers with
  per-path headers, which GitHub Pages project sites cannot set at all.
- **The emitted metadata drops the prefix.** Next resolves special-file
  metadata against `metadataBase` without applying `basePath`, so the tag reads
  `https://example.github.io/opengraph-image` and 404s on a project site. The
  build stays green, so this surfaces only once a crawler follows the link.

Under `basePath`, render the card into `public/` during the build instead, as
in [Authoring without a JSX toolchain](rendering.md#authoring-without-a-jsx-toolchain), and
describe the result with the framework-neutral metadata helper:

```ts
// app/layout.tsx
import type { Metadata } from "next";
import { socialImageMetadata } from "metaplate";

const social = socialImageMetadata("/", "Project home card", {
  basePath: "/project",
  imagePath: "og-image.png",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://example.github.io"),
  openGraph: social.openGraph,
  twitter: social.twitter,
};
```

This emits `/project/og-image.png`, which Next resolves against
`metadataBase` into
`https://example.github.io/project/og-image.png`. Verify both
`public/og-image.png` and the copied `out/og-image.png`, and inspect the
exported HTML to confirm its social tags carry the deployment prefix.

### JPEG or WebP cards in Next.js

`metaplate/next` renders through `next/og`, which always produces PNG. A card
that composites a photograph is usually several times smaller as JPEG (see
[Other output formats](rendering.md#other-output-formats)), and that needs the Node
renderer's `output` encoder. `createNodeOg` works inside a Next route handler
with one piece of configuration.

Next 16 builds with Turbopack, which cannot bundle the two renderer peers:
Resvg ships a native `.node` binary, and Satori locates its HarfBuzz `.wasm`
relative to its own file. Next's
[built-in external list](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages)
covers `sharp` but not these, so without configuration the build fails with:

```
./node_modules/@resvg/resvg-js/js-binding.js
Error: non-ecmascript placeable asset
```

and, once Resvg is external, every render aborts with:

```
Error: ENOENT: no such file or directory, open '…/node_modules/harfbuzzjs/hb.wasm'
```

List both in
[`serverExternalPackages`](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages)
so Next requires them from `node_modules` instead of bundling them:

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@resvg/resvg-js", "satori"],
};

export default nextConfig;
```

This applies to any module graph that reaches `metaplate/node`, including a
page that imports the plate only to call `og.metadata()`: the renderer loads
lazily at runtime, but the bundler still traces the import.

Name the route folder after the file the plate writes. With
`imagePath: "og-image.jpg"`, the handler lives at
`app/<route>/og-image.jpg/route.ts`, so a static export emits a real
`og-image.jpg` and static hosts serve it as `image/jpeg` without the
per-path header rules in [Static hosts](deployment.md#static-hosts):

```ts
// app/roadmap/og-image.jpg/route.ts
import { og } from "@/lib/og";
import { copy } from "../page";

export const dynamic = "force-static";
export const GET = og.handler(copy);
```

### Render guards in Next.js

[Render guards](rendering.md#render-guards) are not available through
`createNextOg`: `next/og`'s `ImageResponse` takes the element and options and
returns the response, exposing neither Satori's `loadAdditionalAsset` and
`onNodeDetected` callbacks nor the rendered pixels. `createNextOg` therefore
rejects a `guards` option rather than ignoring it. A card that must be
guarded renders through `createNodeOg` in a route handler, configured as
above, with `guards` on that plate.
