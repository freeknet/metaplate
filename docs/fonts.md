# Fonts

Loading font bytes for Satori from project files, Fontsource, npm packages, or your own bytes.

[Satori](https://github.com/vercel/satori#fonts) needs the actual bytes of every
rendered face and accepts TTF, OTF, and WOFF, but not WOFF2. This is separate
from a framework's CSS font setup:
[`next/font`](https://nextjs.org/docs/app/getting-started/fonts), for example,
self-hosts and exposes class names but does not expose its transformed font
bytes to `ImageResponse`. Reuse the same source file or npm package for the
plate; do not attempt to extract it from the framework's generated CSS.

Choose the loader that matches where the project already owns the font:

| Existing source | Loader | What you specify |
| --- | --- | --- |
| Fontsource npm package | `fontsourceFontLoader` | Font id plus optional weight/style/subset |
| Local project file | `fileFontLoader` | Relative/absolute path or co-located `file:` URL |
| Existing bytes or framework fetch/import | `fontLoader` | Bytes or a lazy byte callback |
| Any other npm package | `packageFontLoader` | Package name and package-relative file |

All loaders memoize successful bytes across renders and retry after a failed
load. Fontsource is the shortest npm-managed path; it reads the installed
package's family and default subset from `metadata.json` and selects its WOFF
face, so no internal filename needs to be copied into application code:

```ts
import { fontsourceFontLoader } from "metaplate/fonts";

const fonts = fontsourceFontLoader([
  { font: "inter", weight: 400 },
  { font: "inter", weight: 700 },
]);
```

Install the corresponding package once (`npm install @fontsource/inter`). This
uses [Fontsource's official npm self-hosting model](https://fontsource.org/docs/getting-started/introduction)
while selecting WOFF instead of the WOFF2 normally used by browser CSS.

For a font already checked into the project, point at it directly in a
Node-compatible renderer:

```ts
import { fileFontLoader } from "metaplate/fonts";

const fonts = fileFontLoader([
  {
    name: "Brand Sans",
    file: new URL("../assets/brand-sans.woff", import.meta.url),
    weight: 700,
  },
]);
```

For an edge runtime or a framework that already resolves/fetches an asset,
give Metaplate the resulting bytes. The callback stays lazy and is evaluated
once:

```ts
import { fontLoader } from "metaplate/font-data";

const fonts = fontLoader([
  {
    name: "Brand Sans",
    weight: 700,
    data: async () => {
      const response = await fetch(new URL("../assets/brand-sans.woff", import.meta.url));
      if (!response.ok) throw new Error(`Unable to load font: ${response.status}`);
      return response.arrayBuffer();
    },
  },
]);
```

[Vite documents asset URL imports](https://vite.dev/guide/assets.html), but also
notes that `new URL(..., import.meta.url)` has different semantics in SSR. In
Astro and React Router Node deployments, prefer `fileFontLoader` for
server-owned files; use `fontLoader` only when the framework/deployment already
gives the server a fetchable URL or bytes.

`packageFontLoader` remains the escape hatch for other npm font packages. It
resolves through the active runtime first (npm, Yarn classic, pnpm, and hoisted
workspaces), then falls back to an upward `node_modules` walk:

Install layouts without a physical `node_modules` — Yarn Plug'n'Play — cannot
be read by path at all. Supply a `resolvePackage` hook that maps a package
name to a readable directory (an unplugged path, or a zipfs-backed view of
the archive):

```ts
import { packageFontLoader } from "metaplate/fonts";

const fonts = packageFontLoader([
  { name: "Inter", package: "@fontsource/inter", file: "files/inter-latin-700-normal.woff", weight: 700 },
], {
  resolvePackage: (name) => zipfsResolveToReadableDir(name),
});
```

Return `undefined` to fall back to the default resolution.
