# Upgrading

How to move a project from an older Metaplate to the current one, and what each
breaking change needs from you. The [changelog](../CHANGELOG.md) has the full history.

## Why upgrades do not arrive on their own

Metaplate is before 1.0, where npm treats each minor version as breaking. A range
such as `^0.5.0` means `>=0.5.0 <0.6.0`, so `npm update` never leaves 0.5. Moving
forward always takes an explicit install:

```sh
npm install metaplate@latest
```

## A safe upgrade

The risk in an upgrade is usually not a thrown error. Newer peers change how text is
laid out, so every card can shift with nothing failing. Compare before and after.

**1. Record the cards you have.** Build with the version you are on, then record them
with the newest CLI. `npx` fetches it for this one command, and it can read cards
rendered by any version:

```sh
npm run build
npx metaplate@latest verify --baseline og-baseline --update-baseline --size 1200x630 "out/**/og-image.png"
```

**2. Upgrade Metaplate and its peers.** npm moves the peers it installed for you,
such as Satori, along with Metaplate. If you list one in your own `package.json`, raise
it there too. Then check that nothing is below the ranges in the next section:

```sh
npm install metaplate@latest
npm ls metaplate satori @resvg/resvg-js next
```

**3. Fix what the type checker and build report**, using the
[breaking changes](#breaking-changes-by-version) below.

**4. Compare.** Rebuild, then check the new cards against the record:

```sh
npm run build
npx metaplate verify --baseline og-baseline --write-diff og-diff --size 1200x630 "out/**/og-image.png"
```

Files match by their path below `out/`. Each card that changed fails, and `og-diff/`
gets a picture of the change. Look at them, because crossing several Satori releases
often moves text a little. If they look right, you are done: record the new cards with
`--update-baseline`, or delete `og-baseline`.

**5. Publish new URLs if the cards changed.** Crawlers cache images by URL, so a
visibly different card at the same URL can stay stale for a long time. With
[`version: "copy"`](metadata.md#versioned-image-urls), raise `revision`.

## Current requirements

| Package | Range | Notes |
| --- | --- | --- |
| Node.js | `>=20` | |
| `satori` | `>=0.38.2 <1` | Installed for you. Older releases drop content with no error. |
| `@resvg/resvg-js` | `>=2.6.2 <3` | Installed for you. |
| `react` | `>=18.2.0 <20` | Installed for you. |
| `next` | `>=16.3.2 <17` | Only for `metaplate/next`. |

A project below the Next range has to upgrade Next first. If npm reports a peer
conflict, fix the version rather than forcing past it, because these ranges are what
each release was tested against.

## Breaking changes by version

Work through every row newer than the version you are on.

| Since | What changed | What to do |
| --- | --- | --- |
| 0.2.0 | `metaplate/next` no longer re-exports `ImageResponse`. | Import it from `next/og`. |
| 0.5.0 | The per-render `size` option is gone. | [Declare a variant](#per-render-size). |
| 0.5.0 | `output` takes `format`; a bare `contentType` is rejected. | [Use `format`](#output-encoders). |
| 0.6.0 | `metaplate/next` needs Next `>=16.3.2 <17`. | Upgrade Next. |
| 0.6.0 | `fitTo` settings that change the size, and every `crop` setting, are rejected in `resvg`. | Set the plate's `size`, or declare a variant. |
| 0.6.0 | Satori, Resvg, and React are required peers again, after being optional from 0.2.0. | Nothing with npm 7+ or pnpm 8+. Yarn adds them by hand. |
| 0.7.0 | `headers` containing `Content-Type`, `Content-Length`, or `Content-Encoding` throws when the plate is defined, as does `ETag` while `etag` is on. | Remove them. The plate sets them from the bytes. |
| 0.7.0 | `output.contentType` must be a valid media type. | Correct it, or use `format`. |
| 0.7.0 | `socialImageCompatibility` throws a `TypeError` for a descriptor with no `width` or `height`. | Pass both. |
| 0.8.1 | The `satori` peer floor rises to 0.38.2. | Upgrade Satori. Below it, `inset` and fragments misbehave with no error. |
| 0.8.4 | `cached()` throws a `TypeError` for copy that holds a function, and `--incremental` always renders such a page, because a function's captured values cannot be keyed. | Pass the data the function uses instead of the function. |

Upgrading to 0.8.4 also changes every render-cache key and `--incremental` input
hash once, because both now keep the copy's key order. A shared cache store misses
once, and the first `--incremental` build renders every image. Published `?v=`
tokens do not change.

### Per-render size

A plate now renders one size per view, so the bytes and the advertised dimensions can
never disagree. A second size is declared up front:

```tsx
// Before
const banner = await og.render(copy, { size: { width: 1280, height: 640 } });

// After
export const og = createNodeOg<Copy, "banner">({
  alt: (copy) => copy.alt,
  fonts,
  variants: { banner: { size: { width: 1280, height: 640 }, imagePath: "banner.png" } },
  // The component receives the canvas, instead of reading it from the copy.
  component: (copy, { size }) => <Card copy={copy} width={size.width} height={size.height} />,
});

const banner = await og.variant("banner").render(copy);
```

Declared variants appear in the page's `og:image` tags. If a size is only a downloadable
asset, give it a [separate plate](recipes.md#another-size-for-another-platform) that
shares the component. On `createNextOg`, `render` returns a `Response`, so read its bytes
with `new Uint8Array(await response.arrayBuffer())`.

### Output encoders

```ts
// Before
output: { contentType: "image/jpeg", encode },

// After
output: { format: "jpeg", encode },
```

`format` makes each render check that the bytes really are JPEG, and carries the type
into the metadata. Set `imagePath: "og-image.jpg"` to match. For a format Metaplate does
not recognize, keep `contentType` and add `checkSignature: false`.

## Optional improvements

Nothing here is required, but older code often has a shorter form now.

| If you have | Consider | Since |
| --- | --- | --- |
| `packageFontLoader` pointing at `@fontsource/*` files | [`fontsourceFontLoader`](fonts.md), which finds the file and family name itself | 0.6.0 |
| `readFile` and a hand-built font array | [`fileFontLoader`](fonts.md), which keeps one copy across renders and retries after a failure | 0.6.0 |
| A build script with its own queue and error handling | [`metaplate render`](render-cli.md), and [One card per record](recipes.md#one-card-per-record) if you swap files in | 0.8.0 |
| One route file per page | [Rendering before the build](static-next-site.md) | 0.8.0 |
| A base64 data URI built by hand | [`readImageAsset`](rendering.md#project-files-with-metaplateassets), which checks the file first | 0.8.0 |
| `fetch` for an avatar during the build | [`remoteImageLoader`](recipes.md#a-remote-image-that-may-be-missing), with an allowlist and a byte cap | 0.8.0 |
| Resolving images before calling `render` | An [`async` component](rendering.md#async-components) | 0.8.0 |
| `createNextOg` with no checks on the result | [Render guards](rendering.md#render-guards) through `createNodeOg` | 0.8.0 |
| A script scraping `og:image` with a regular expression | [`extractPageSocialMetadata`](testing.md#audit-the-whole-export) | 0.8.0 |
| A hand-made `?v=` on image URLs | [`version: "copy"`](metadata.md#versioned-image-urls) | 0.8.0 |
| `spawn` of the `metaplate` binary, or `NODE_OPTIONS=` in an npm script | [`runCli`](render-cli.md#loading-typescript-and-jsx) | 0.8.1 |
| A `metaplate verify --target` step after `metaplate render`, repeating each size | [`metaplate render --target`](render-cli.md#formats-and-verification) | 0.8.3 |
| A test that drops or rewrites `url` so `verifySocialImage` skips the HTTPS rule | [`checkUrl: false`](testing.md#check-bytes-against-the-descriptor) | 0.8.4 |
| A signed route that left out `cached()` because it dropped `{ signed }` | [`cached().handlerFrom(resolve, { signed })`](signed-routes.md) | 0.8.4 |

## Workarounds you can delete

These limits were real on older Satori releases, and code comments tend to outlive
them. On the current floor:

- A fragment no longer lays out as a box of its own, so absolutely positioned children
  of a fragment anchor to the positioned parent. Fixed in Satori 0.38.2.
- `inset` works, so an overlay no longer needs explicit `left`, `top`, `width`, and
  `height`. Fixed in Satori 0.38.2.
- Text with `color: "transparent"` draws, so outline type works. Fixed in Satori 0.35.2.
- WOFF2 fonts parse, from Satori 0.55.0. The Fontsource loaders still read WOFF, so they
  work at the bottom of the range.
