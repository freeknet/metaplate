# Metadata

Open Graph and X metadata without a renderer, per-channel images, the `<meta>` tags themselves, and video and audio.
## Metadata without a renderer

The root `metaplate` entry has no framework dependency. It can describe a
hand-authored or pre-rendered image, like a conventional `public/og.png`:

```ts
import { socialImageMetadata } from "metaplate";

const metadata = socialImageMetadata("/", "Project home card", {
  imagePath: "og.png",
  size: { width: 1200, height: 630 },
});
```

Relative paths are the default because Next's Metadata API resolves them against
`metadataBase`. A framework-neutral consumer that writes tags directly can pass
an `origin` for crawler-ready absolute URLs; `basePath`, route, and `imagePath`
compose beneath it:

```ts
const metadata = socialImageMetadata("/docs", "Docs card", {
  origin: "https://example.com",
  basePath: "/project",
  imagePath: "og-image.jpg",
});
// https://example.com/project/docs/og-image.jpg
```

Metadata helpers accept `route`/`basePath`/`imagePath` as pathnames only:
query strings, fragments, and `.`/`..` segments are rejected rather than
silently producing a URL that normalizes somewhere else.

### Channel-specific images and X Cards

Metaplate configures two published webpage metadata channels, not one platform:

| Metaplate option | Emitted/returned channel | Typical consumers |
| --- | --- | --- |
| `openGraph` / `OpenGraphImageOptions` | `og:image` and its structured properties | Facebook, LinkedIn, Slack, Mastodon, Discord, and other Open Graph readers |
| `twitter` / `XImageOptions` | `twitter:card`, `twitter:image`, and identity fields | X Cards |

The public option remains named `twitter` because `twitter:*` is still the X
Card wire protocol and because frameworks such as Next.js expose the same
`twitter` metadata field. `XCard` and `XImageOptions` are the preferred
human-facing type names; `TwitterCard` and `TwitterImageOptions` remain exact
aliases for existing code and framework terminology. Platform-specific
delivery rules are selected separately with `SocialTarget` in
`socialImageCompatibility`.

The one-image call remains unchanged. When the extra images are other sizes
of the same card, declare them as
[`variants`](variants.md) instead. When a landscape Open
Graph image, a square fallback, and an X-specific composition differ, override
only those channels. Open Graph ordering is preserved and the first descriptor remains
the preferred image:

```ts
const metadata = socialImageMetadata("/docs", "Docs card", {
  origin: "https://example.com",
  imagePath: "og-image.png",
  openGraph: { images: [landscape, square] },
  twitter: {
    card: "summary",
    image: xCard,
    site: "@example",
    creator: "@author",
  },
});
```

Supported X identity fields are `site`, `siteId`, `creator`, and `creatorId`.
Overrides are copied into independent descriptors, so mutating a source object
later cannot silently change or desynchronize the two channels. Metaplate does
not generate fictional `discord:*` or `instagram:*` tags; those consumers use
Open Graph or undocumented heuristics rather than a separate page schema.

### Emitting the meta tags yourself

Frameworks with a metadata API should keep receiving the metadata object:
pass `openGraph` and `twitter` to Next's `metadata`, as `metaplate/next`
does, so Next can merge them with layout metadata. When a page writes its own
`<head>`, as React Router `meta`, Astro and SvelteKit templates, or a static
HTML build do, `socialMetaTags` turns the same metadata into the tags
themselves:

```ts
import { socialImageMetadata, socialMetaHtml, socialMetaTags } from "metaplate";

const social = socialImageMetadata("/blog/launch", "Launch card", { type: "image/png" });
const page = {
  title: "Launch notes",
  description: "What shipped this week.",
  url: "https://example.com/blog/launch",
  siteName: "Example",
};

// React Router: the objects are valid `meta` descriptors as-is.
export const meta = () => [{ title: page.title }, ...socialMetaTags(social, page)];

// Plain HTML: escaped `<meta>` elements, one per line.
const head = socialMetaHtml(social, { ...page, indent: "    " });
```

In an Astro or Svelte template, loop over the array and bind the attributes;
the framework escapes them:

```astro
{socialMetaTags(social, page).map((tag) => <meta {...tag} />)}
```

`socialMetaTags` returns `{ property, content }` for Open Graph tags and
`{ name, content }` for X Card tags, in this fixed order:

1. Each Open Graph image, in caller order: `og:image`, `og:image:width`,
   `og:image:height`, `og:image:type`, `og:image:alt`. Repeating the group is
   how Open Graph expresses several images; a group whose URL repeats an
   earlier one is dropped.
2. `twitter:card`, `twitter:image`, `twitter:image:alt`, `twitter:site`,
   `twitter:site:id`, `twitter:creator`, `twitter:creator:id`. X reads one
   image, so only the first X Card image is used. Player and app cards then
   add their own tags, in the order listed under
   [X player and app cards](x-cards.md).
3. Page-level fields from the options: `og:title`, `og:description`,
   `og:url`, `og:site_name`, `og:type`.

A tag whose value is undefined or empty is left out, so metadata alone never
gains page-level tags. `og:type` defaults to `website` only when `title` or
`url` is supplied. Dimensions are emitted as integer strings.

`url` is the canonical page URL and must be an absolute http(s) URL. When it
is supplied, relative image URLs are resolved against it with standard URL
resolution, as a crawler on that page would; absolute image URLs are never
rewritten. Without `url`, image URLs are emitted exactly as the metadata holds
them.

`socialMetaHtml` renders the same tags in the same order and guarantees that
its output contains only `<meta>` elements: each has exactly a `property` or
`name` attribute followed by `content`, the key must match a strict
`og:`/`twitter:` pattern, and the content is escaped for a double-quoted
attribute (`&`, `<`, `>`, `"`, and `'`, plus line breaks so each element stays
on one line). `indent` accepts only spaces and tabs. It does not emit
`<title>` or `<link rel="canonical">`; those belong to the page, which must
escape its own title text.

Next.js `generateMetadata` can carry the tags through `other`, as
[`examples/social-meta-tags.ts`](../examples/social-meta-tags.ts) shows, but Next
renders every `other` entry with a `name` attribute and groups repeated keys.
That is faithful for a single Open Graph image only; with several images, use
Next's `openGraph` and `twitter` fields.

### Video and audio previews

The [Open Graph protocol](https://ogp.me/#structured) defines `og:video` and
`og:audio` as optional properties with structured properties: a video has the
same five as an image (`url`, `secure_url`, `type`, `width`, `height`), and
audio has only `url`, `secure_url`, and `type`. Pass them as `media`; they are
copied onto `metadata.openGraph.videos` and `metadata.openGraph.audio`, beside
the images:

```ts
import { socialImageMetadata, socialMetaTags } from "metaplate";

const social = socialImageMetadata("/launch", "Launch card", {
  origin: "https://example.com",
  media: {
    videos: [
      {
        url: "https://cdn.example.com/trailer.mp4",
        secureUrl: "https://cdn.example.com/trailer.mp4",
        type: "video/mp4",
        width: 1280,
        height: 720,
      },
    ],
    audio: [{ url: "https://cdn.example.com/theme.mp3", type: "audio/mpeg" }],
  },
});

socialMetaTags(social, { url: "https://example.com/launch" });
```

`socialMetaTags` and `socialMetaHtml` emit them after every `og:image` group
and before the `twitter:*` tags:

1. For each video, in caller order: `og:video`, `og:video:secure_url`,
   `og:video:type`, `og:video:width`, `og:video:height`.
2. Then for each audio item: `og:audio`, `og:audio:secure_url`,
   `og:audio:type`.

```html
<meta property="og:image" content="https://example.com/launch/og-image">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Launch card">
<meta property="og:video" content="https://cdn.example.com/trailer.mp4">
<meta property="og:video:secure_url" content="https://cdn.example.com/trailer.mp4">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="1280">
<meta property="og:video:height" content="720">
<meta property="og:audio" content="https://cdn.example.com/theme.mp3">
<meta property="og:audio:type" content="audio/mpeg">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://example.com/launch/og-image">
<meta name="twitter:image:alt" content="Launch card">
<meta property="og:url" content="https://example.com/launch">
<meta property="og:type" content="website">
```

As with images, a missing field emits no tag, a relative `url` is resolved
against the canonical page `url`, and a group whose resolved URL repeats an
earlier one of the same kind is dropped. Metadata without `media` emits
exactly the tags it did before. Validation runs in both `socialImageMetadata`
and `socialMetaTags`:

- `url` must be non-empty, and an absolute `url` must be a credential-free
  http(s) URL.
- `secureUrl` (`secure_url`) must be an absolute, credential-free https URL.
- `type` must be a media type such as `video/mp4` or `audio/mpeg`.
- Video `width` and `height` must be integers from 1 to 65535, the same range
  as image dimensions. Audio has no dimensions.

Plates accept the same option per call, for the default size and for a
variant: `plate.metadata(route, copy, { media: { videos, audio } })`.

**Next.js.** The descriptor fields match Next's
[`openGraph.videos` and `openGraph.audio`](https://nextjs.org/docs/app/api-reference/functions/generate-metadata#opengraph)
(`url`, `secureUrl`, `type`, `width`, `height`), so `openGraph: social.openGraph`
passes them through unchanged, and Next renders the same tag order. Next
resolves only images against `metadataBase` and documents video and audio URLs
as "Must be an absolute URL", so `metaplate/next`'s `metadata()` rejects a
relative video or audio URL instead of emitting one a crawler cannot follow.
[`examples/og-media.ts`](../examples/og-media.ts) shows both paths.

**Where they render.** Open Graph defines the tags; it does not promise any
client plays them. Meta's [sharing guide](https://developers.facebook.com/docs/sharing/webmasters)
documents `og:video` and its structured properties, asks for secure URLs in
both `og:video:url` and `og:video:secure_url`, and notes that a video "is not
guaranteed to play in-line". That guide does not document `og:audio`. X Cards
describe video with their own Player Card (`twitter:player`), which `media`
does not emit. Metaplate makes no rendering claim for other platforms; check
each one's debugger after deployment.
