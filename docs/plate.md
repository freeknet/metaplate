# Plate reference

Every option a plate takes and everything it returns, in one place. The factories
are `createSvgOg` (`metaplate/render`), `createNodeOg` (`metaplate/node`),
`createEdgeOg` (`metaplate/edge`), and `createNextOg` (`metaplate/next`). Start with
[Rendering](rendering.md) to learn how they fit together.

## Which factory

| Factory | Output | Formats | Guards | Runs on |
| --- | --- | --- | --- | --- |
| `createNodeOg` | Bytes, `Response` | PNG, plus anything an `output` encoder produces | Yes, including `blank` | Node, Bun, Deno |
| `createNextOg` | `next/og` `ImageResponse` | PNG | No | Next route handlers and metadata files |
| `createEdgeOg` | Bytes, `Response` | PNG | Yes, including `blank` | [Deno-based edges](edge.md) |
| `createSvgOg` | SVG text | SVG | Yes, except `blank` | Anywhere Satori runs |

Only `createNodeOg` and `createEdgeOg` plates work with
[`metaplate render`](render-cli.md).

## Definition options

### Every factory

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `component` | `(copy, { variant, size }) => element` | Required | The design. May be `async`. See [Plate constraints](rendering.md#plate-constraints). |
| `alt` | `(copy) => string` | Required | Alternative text for the image, from the same copy. |
| `size` | `{ width, height }` | `OG_SIZE` (1200x630) | The default canvas. Integers from 1 to 65535. |
| `imagePath` | `string` | `"og-image"` | The file name under each route. Give it a real extension on a static host. |
| `basePath` | `string` | None | A deployment prefix for published URLs. File paths never include it. |
| `origin` | `string` | None | Scheme and host for absolute image URLs. Without it, URLs are root-relative. |
| `variants` | `{ [name]: { size, imagePath?, alt? } }` | None | [Other sizes](variants.md) of the same card. |
| `version` | `"copy"` | None | Adds `?v=<token>` to published URLs, [derived from the copy](metadata.md#versioned-image-urls). |
| `revision` | `string` | None | Names the design's version. Raise it when a helper or theme the component imports changes. |

### `createSvgOg`, `createNodeOg`, and `createEdgeOg`

| Option | Type | Meaning |
| --- | --- | --- |
| `fonts` | `() => fonts` | Required. See the [fonts guide](fonts.md). |
| `guards` | [`RenderGuards`](rendering.md#render-guards) | Fail (`"error"`) or report (`"warn"`) a broken card. All off by default. |
| `emoji` | `EmojiLoader` | [Draws emoji as images](emoji.md). |
| `languageFonts` | `LanguageFontLoader` | [Fonts for other scripts](fonts.md#other-scripts). |
| `satori` | `SatoriOptions` | Passed to Satori, such as `debug`. |

### `createNodeOg` and `createEdgeOg`

| Option | Type | Meaning |
| --- | --- | --- |
| `resvg` | Resvg options | Rendering controls such as `background`. Settings that change the size are rejected. |
| `headers` | `HeadersInit` | Added to responses. `Content-Type`, `Content-Length`, and `Content-Encoding` are owned by the plate, and setting them throws. |
| `etag` | `boolean \| "sha256"` | Adds a strong ETag computed from the final bytes. |

### `createNodeOg` only

| Option | Type | Meaning |
| --- | --- | --- |
| `output` | `{ format, encode }`, or `{ contentType, checkSignature: false, encode }` | [Another format](rendering.md#other-output-formats). `encode` receives `{ pixels, width, height }` and returns the bytes. |

### `createEdgeOg` only

| Option | Type | Meaning |
| --- | --- | --- |
| `layout` | `{ wasm }` | Satori's Yoga module. See [Edge runtimes](edge.md). |

The edge `resvg` option also takes the `@resvg/resvg-wasm` module.

### `createNextOg` only

| Option | Type | Meaning |
| --- | --- | --- |
| `fonts` | `() => fonts` | Optional here: without it, `next/og` uses its default font. |
| `response` | `ImageResponse` options | Everything but `width`, `height`, and `fonts`. |

Setting `guards` on `createNextOg` throws, because `next/og` exposes nothing they can
run on.

## What a plate returns

Each cell says whether that factory's plate has the member. Every member of a variant
view (`plate.variant("square")`) behaves the same way, for that size.

| Member | `createSvgOg` | `createNodeOg` | `createEdgeOg` | `createNextOg` |
| --- | --- | --- | --- | --- |
| `size` | Yes | Yes | Yes | Yes |
| `contentType` | Yes | Yes | Yes | Yes |
| `variantName`, `variants`, `variant` | Yes | Yes | Yes | Yes |
| `image`, `metadata`, `sitePath` | Yes | Yes | Yes | Yes |
| `signedMetadata` | | Yes | Yes | Yes |
| `renderSvg` | Yes | Yes | Yes | |
| `render` | | Yes | Yes | Yes |
| `renderPixels`, `artifact`, `response` | | Yes | Yes | |
| `fingerprint`, `cached` | | Yes | Yes | |
| `handler` | | Yes | | Yes |
| `handlerFrom`, `fetchable`, `fetchableFrom` | | Yes | Yes | Yes |

### Describing the image

These build no image and load no renderer, so a page can call them freely.

| Member | Returns |
| --- | --- |
| `size` | `{ width, height }` of this view. |
| `contentType` | The media type, such as `"image/png"`. |
| `image(route, copy, { version }?)` | One descriptor: `{ url, width, height, alt, type }`. |
| `metadata(route, copy, { version, media, twitter }?)` | `{ openGraph: { images }, twitter }`, with one image per variant. See [Metadata](metadata.md). |
| `signedMetadata(route, copy, keys, options?)` | The same as a promise, with [signed](signed-routes.md) image URLs. |
| `sitePath(route)` | The file's path relative to the deployment root, with no `basePath`, `origin`, or `?v=`. |

### Rendering

| Member | Returns |
| --- | --- |
| `render(copy)` | `Promise<Uint8Array>` of the encoded bytes. On `createNextOg`, a promise of the `ImageResponse` instead. |
| `renderSvg(copy, { debug }?)` | `Promise<string>` of the Satori SVG. |
| `renderPixels(copy)` | `Promise<{ pixels, width, height }>` of raw RGBA. |
| `artifact(route, copy, { version }?)` | `Promise` of `{ bytes, byteLength, contentType, format, size, image, metadata, etag? }`: the bytes with the metadata that describes them. |

### Serving

| Member | Returns |
| --- | --- |
| `response(copy)` | `Promise<Response>` with `Content-Type`, `Content-Length`, the plate's `headers`, and any ETag. |
| `handler(copy)` | `() => Promise<Response>`, for a route with fixed copy. |
| `handlerFrom(resolve, { signed }?)` | A handler that passes every framework argument to `resolve`, which returns the copy. See [Fetch-based routes](rendering.md#fetch-based-framework-routes). |
| `fetchable(copy)`, `fetchableFrom(resolve, options?)` | The same as `{ fetch }`, for runtimes that take that shape. |

### Variants

| Member | Returns |
| --- | --- |
| `variantName` | This view's variant, or `undefined` for the default size. |
| `variants` | Every declared name, in order. |
| `variant(name)` | The same plate at that variant's size, path, and alt. |

### Caching

| Member | Returns |
| --- | --- |
| `fingerprint()` | `Promise<string>` identifying what this view renders, apart from copy. Code the component imports is not seen, which is what `revision` is for. |
| `cached(options?)` | A view that renders each distinct copy once, with the plate's route forms; its `handlerFrom` and `fetchableFrom` take the same `{ signed }` option. See [Caching renders](rendering.md#caching-renders). |

## Calling members on their own

Plate members are not methods that need `this`, so they can be passed or renamed:

```ts
export const renderOgImage = og.render;
export const GET = og.handler(copy);
```
