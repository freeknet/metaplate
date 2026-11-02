# API reference

Every export, by entry point, with the guide that documents it. The constants
and small helpers that no guide covers are described below the table.

| Entry point | Exports | Guide |
| --- | --- | --- |
| `metaplate` | `socialImage`, `socialImagePath`, `variantImagePath`, `socialImageMetadata`, `assertImageSize`, `OG_SIZE`, `OG_CONTENT_TYPE`, `MAX_IMAGE_DIMENSION` | [Metadata](metadata.md), [Variants](variants.md) |
| | `socialMetaTags`, `socialMetaHtml` | [Metadata](metadata.md) |
| | `socialImageVersion`, `IMAGE_VERSION_PARAMETER` | [Versioned image URLs](metadata.md#versioned-image-urls) |
| | `signImagePath`, `verifyImageSignature`, `MIN_IMAGE_SIGNING_SECRET_BYTES` | [Signed image routes](signed-routes.md) |
| | `X_APP_PLATFORMS` | [X player and app cards](x-cards.md) |
| | `socialImageJsonLd`, `socialImageJsonLdScript`, `serializeJsonLd` | [Schema.org JSON-LD](json-ld.md) |
| | `socialImageAdaptiveCard`, `ADAPTIVE_CARD_CONTENT_TYPE`, `ADAPTIVE_CARD_SCHEMA`, `ADAPTIVE_CARD_VERSION`, `ADAPTIVE_CARD_VERSIONS`, `TEAMS_ADAPTIVE_CARD_LIMITS` | [Teams, Slack, and Discord previews](adaptive-cards.md) |
| | `socialImageCompatibility`, `verifySocialImage` | [Compatibility](compatibility.md), [Verification](verification.md) |
| `metaplate/render` | `createSvgOg`, `RenderGuardError`, `SVG_CONTENT_TYPE` | [Rendering](rendering.md) |
| `metaplate/node` | `createNodeOg`, `RenderGuardError`, `memoryRenderCache`, `MEMORY_RENDER_CACHE_DEFAULTS` | [Rendering](rendering.md) |
| | `fetchRemoteImage`, `verifyRemoteImage`, `RemoteImageError`, `REMOTE_FETCH_DEFAULTS`, `REMOTE_USER_AGENT` | [Verification](verification.md#verify-a-deployed-url) |
| | `verifyRemotePage`, `extractPageSocialMetadata`, `REMOTE_PAGE_DEFAULTS`, `CRAWLER_HTML_LIMITS`, `SOCIAL_CRAWLERS`, `findSocialCrawler`, `parseRobotsTxt`, `evaluateRobots`, `isRobotsProductToken`, `REMOTE_ROBOTS_DEFAULTS` | [Page audits](verify-page.md) |
| `metaplate/edge` | `createEdgeOg`, `initEdgeRenderer`, `RenderGuardError`, `memoryRenderCache`, `MEMORY_RENDER_CACHE_DEFAULTS` | [Edge runtimes](edge.md) |
| `metaplate/next` | `createNextOg`, `nextPageMetadata`, `nextPageViewport`, `nextTwitterMetadata`, `NEXT_OPEN_GRAPH_TYPES` | [Next.js](nextjs.md) |
| `metaplate/fonts` | `fileFontLoader`, `packageFontLoader`, `fontsourceFontLoader`, `fontLoader`, their `load*` forms, `findPackageDirectory`, `fontsourceLanguageFontLoader`, `languageFontLoader`, `packageEmojiLoader` | [Fonts](fonts.md), [Emoji](emoji.md) |
| `metaplate/font-data` | `fontLoader`, `loadFonts`, `languageFontLoader` | [Fonts](fonts.md#edge-runtimes-and-other-byte-sources) |
| `metaplate/emoji` | `emojiLoader`, `twemojiName`, `emojiKey`, `emojiCodepoints` | [Emoji](emoji.md) |
| `metaplate/image` | `imageDimensions`, `verifyImage`, `detectFormat`, `imageContentType`, `imageAsset`, `imageAssetLoader`, `IMAGE_ASSET_DEFAULTS` | [Verification](verification.md), [Images and assets](rendering.md#images-and-assets) |
| `metaplate/png` | `pngDimensions`, `verifyPng` | Below |
| `metaplate/assets` | `readImageAsset`, `fileImageLoader`, `remoteImageLoader`, `imageAsset`, `imageAssetLoader`, `RemoteImageError`, `IMAGE_ASSET_DEFAULTS`, `REMOTE_IMAGE_LOADER_DEFAULTS` | [Images and assets](rendering.md#images-and-assets) |

The `metaplate preview` and `metaplate render` commands are documented in
[Live preview](preview.md) and [Render CLI](render-cli.md).

## Constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `OG_SIZE` | `{ width: 1200, height: 630 }` | The default plate size. |
| `OG_CONTENT_TYPE` | `"image/png"` | The default plate media type. |
| `SVG_CONTENT_TYPE` | `"image/svg+xml"` | The media type of `createSvgOg` plates. |
| `MAX_IMAGE_DIMENSION` | `65535` | The largest width or height any plate, descriptor, or check accepts. |
| `X_APP_PLATFORMS` | `["iphone", "ipad", "googleplay"]` | The X App Card platforms, in tag order. |
| `ADAPTIVE_CARD_SCHEMA` | `"https://adaptivecards.io/schemas/adaptive-card.json"` | The `$schema` of generated Adaptive Cards. |
| `ADAPTIVE_CARD_VERSION` | `"1.6"` | The default Adaptive Card `version`. |
| `ADAPTIVE_CARD_VERSIONS` | `["1.0"` ... `"1.6"]` | Every version `socialImageAdaptiveCard` accepts. |
| `TEAMS_ADAPTIVE_CARD_LIMITS` | `{ imageMaxDimension: 1024, imageMaxBytes: 1000000, imageTypes: ["image/png", "image/jpeg", "image/gif"], webhookMessageBytes: 28000 }` | The Teams image and webhook limits the Adaptive Card checks apply. |
| `MEMORY_RENDER_CACHE_DEFAULTS` | `{ maxBytes: 33554432, maxEntries: 1000 }` | The default render cache store's bounds (32 MiB, 1,000 entries). |
| `REMOTE_FETCH_DEFAULTS` | `{ maxRedirects: 3, maxBytes: 16777216, timeoutMs: 10000, connectionTimeoutMs: 10000 }` | The remote fetch limits when an option is omitted. |
| `REMOTE_USER_AGENT` | `"metaplate-verify/<version>"` | The fixed `User-Agent` of every remote fetch. |
| `IMAGE_ASSET_DEFAULTS` | `{ formats: ["png", "jpeg", "svg"], maxBytes: 4194304 }` | The formats and size (4 MiB) `imageAsset` accepts by default. |
| `REMOTE_IMAGE_LOADER_DEFAULTS` | `{ cacheSize: 64, maxBytes: 4194304 }` | `remoteImageLoader`'s cache entries and per-image byte limit. |

## Helpers

- `assertImageSize(size)` throws unless `width` and `height` are integers from
  1 to `MAX_IMAGE_DIMENSION`. Every public function that takes a size runs it.
- `detectFormat(bytes)` names the format from the file signature alone
  (`"svg"`, `"png"`, `"jpeg"`, `"webp"`, or `"gif"`), or returns `undefined`.
  It checks no structure; use `imageDimensions` or `verifyImage` for that.
- `imageContentType(format)` maps a format to its media type, such as
  `"jpeg"` to `"image/jpeg"`.
- `pngDimensions(bytes)` (`metaplate/png`) walks a PNG's chunk stream and
  returns its width and height, throwing for a truncated or malformed file;
  `verifyPng(bytes, { width, height })` also throws when the dimensions
  differ. `metaplate/image`'s `verifyImage` does the same for every format.
- `isRobotsProductToken(name)` reports whether `name` is a valid RFC 9309
  product token, the form a `--crawler` value takes.
