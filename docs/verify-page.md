# Verify a page's social preview

`metaplate verify-page` audits a deployed page the way a link-preview crawler
reads it. It fetches the page's HTML, extracts the Open Graph, X Card, and
Schema.org image metadata from it, resolves every image URL the page names,
and verifies each image with the same checks as
[`verify-url`](verification.md#verify-a-deployed-url):

```sh
npx metaplate verify-page https://example.com/blog/launch
```

```text
✓ https://example.com/blog/launch (3 image references)
  ✓ og:image[0] https://example.com/blog/launch/og-image.png 1200x630 png (48213 bytes)
  ✓ twitter:image https://example.com/blog/launch/og-image.png 1200x630 png (48213 bytes)
  ✓ json-ld[0] https://example.com/blog/launch/og-image.png 1200x630 png (48213 bytes)
```

Errors go to standard error, one per line, followed by
`N of M pages failed verification`; the process then exits 1. Warnings
(`!`) and findings that could not be confirmed (`?`) are printed under their
page on standard output and do not change the exit code. Several pages can be
checked in one run: `metaplate verify-page URL [URL ...]`.

## Contents

- [What is extracted](#what-is-extracted)
- [What is checked](#what-is-checked)
- [Compatibility targets](#compatibility-targets)
- [Crawler access (robots.txt)](#crawler-access-robotstxt)
- [Options](#options)
- [Network policy](#network-policy)
- [JSON report](#json-report)
- [Library API](#library-api)
- [Limitations](#limitations)
- [Specifications](#specifications)

## What is extracted

From the page's `<head>`:

| Tag | Read as |
| --- | --- |
| `og:image`, `og:image:url` | An image. Each `og:image` starts a new one; the first is preferred. `og:image:url` is identical to `og:image`. |
| `og:image:secure_url`, `:type`, `:width`, `:height`, `:alt` | Properties of the most recent `og:image`. A property before any `og:image` is ignored and reported. |
| `og:title`, `og:description` | Page fields, reported in `metadata`. |
| `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`, `twitter:image:alt` | X Card fields. |

Anywhere in the document:

| Element | Read as |
| --- | --- |
| `<base href>` | The first one sets the base URL for every relative URL. |
| `<script type="application/ld+json">` | Schema.org images: each `ImageObject`'s `contentUrl` (or `url`), `width`, `height`, and `encodingFormat`, and each URL given as an `image` property. |

The extractor follows the parts of the HTML tokenizer that decide what a
crawler sees:

- Tag and attribute names are case-insensitive, attributes may appear in any
  order, and values may be double-quoted, single-quoted, or unquoted. When an
  attribute is repeated, the first value wins.
- Social tags are read from `property` or `name`. When a tag carries both, such
  as `<meta name="twitter:description" property="og:description">`, both are
  read. A `<meta>` without `content` is ignored. Values are trimmed of ASCII
  whitespace only; a leading `&nbsp;` or other Unicode space is kept.
- Character references in attribute values are decoded: every numeric
  reference (`&#39;`, `&#x27;`), including the HTML replacements for invalid
  and windows-1252 code points, and the named references `amp`, `lt`, `gt`,
  `quot`, `apos`, `nbsp`, `copy`, `reg`, `trade`, `hellip`, `mdash`, `ndash`,
  `lsquo`, `rsquo`, `ldquo`, `rdquo`, `laquo`, `raquo`, `middot`, `bull`,
  `euro`, `pound`, `yen`, `cent`, `sect`, `deg`, `times`, and `divide`. As in
  HTML, `&amp` without a semicolon is decoded, but `?a=1&copy=2` is left as
  written. Other named references are left as written.
- Comments (closed by `-->` or `--!>`; `<!-->` and `<!--->` are empty
  comments), doctypes, and the contents of `<script>`, `<style>`, `<title>`,
  `<noscript>`, `<textarea>`, and similar raw-text elements are skipped, so a
  tag quoted in a script is not read. `<noscript>` is raw text because
  browsers parse with scripting enabled, so an analytics pixel's
  `<noscript><img></noscript>` in the head neither ends the head nor hides
  the tags after it. JSON-LD script content is raw text and is not
  entity-decoded. `<template>` contents are inert and never read.
- The head ends where the HTML tree builder ends it: at `<body>`, at any
  start tag that cannot appear in a head, at `</body>`, `</html>`, or `</br>`,
  and at text that is not whitespace. Between `</head>` and the body, a
  `<meta>`, `<link>`, `<base>`, `<script>`, `<style>`, `<title>`, or
  `<template>` is still placed in the head, so its tags are read. Social tags
  after the head ends are ignored, and the report says how many were found.
- The body is decoded with its byte order mark, the `charset` in its
  `Content-Type`, or a `<meta charset>` (or `http-equiv` Content-Type) in the
  first 1024 bytes, in that order, and as UTF-8 otherwise. A UTF-16 label in
  `Content-Type` is used as given; one found by the `<meta>` prescan means
  UTF-8, and `x-user-defined` there means windows-1252, as the HTML encoding
  sniffing algorithm says.
- Relative URLs resolve against the document base URL: the first
  `<base href>`, resolved against the page's final URL after redirects, or the
  final URL itself. A `<base>` that does not parse, or whose scheme is not
  http or https, is ignored. HTML itself ignores only `data:` and
  `javascript:` bases; any other non-http(s) base would make every relative
  image unfetchable, so it is ignored too.

The scanner runs in linear time: it uses no regular expressions over page
content, never backtracks, and bounds JSON-LD nesting to 32 levels and
10,000 values.

## What is checked

Page findings:

| Code | Severity | When |
| --- | --- | --- |
| `og-image-missing` | error | The page declares no `og:image`. Open Graph requires one. |
| `twitter-card-missing` | warning, or an `x` target error | The page declares no `twitter:card`. |
| `twitter-card-unknown` | warning | `twitter:card` is not `summary`, `summary_large_image`, `player`, or `app`. |
| `twitter-image-missing` | error | A card, or the `x` target, is present, but there is neither a `twitter:image` nor an `og:image` for X to fall back to. App cards are exempt. |
| `orphan-property`, `meta-outside-head` | warning | Tags that were ignored, as described above. |
| `json-ld` | warning | A JSON-LD script that is not valid JSON, or one too large to read in full. |
| `image-limit` | unknown | More distinct image URLs than `--max-images`; the rest are listed but not fetched. Or more than 64 image references; the rest are counted but not inspected. |
| `html-limit` | warning, under each Meta target when given | Open Graph tags that only appear after the first 1,000,000 bytes of HTML, which Meta's crawler does not read; or, with `--target whatsapp`, a `<head>` that does not end within the first 300,000 bytes. |
| `robots-disallowed`, `robots-unreachable`, `robots-unknown` | see [Crawler access](#crawler-access-robotstxt) | A crawler's robots.txt rules keep it from the page. |

Each image reference (`og:image`, `og:image:secure_url`, `twitter:image`, and
each JSON-LD image) is verified separately. A URL named by several tags is
fetched once:

| Code | Severity | When |
| --- | --- | --- |
| `invalid-url` | error | The value is empty or does not parse as a URL. |
| `relative-url` | warning | An `og:` or `twitter:` URL is relative. Open Graph URL values are absolute http(s) URLs. JSON-LD URLs may be relative. |
| `insecure-url` | warning, or error for `og:image:secure_url` | The resolved URL is `http:`. |
| `alt` | warning | An `og:image` without `og:image:alt`, or a `twitter:image` without `twitter:image:alt`. |
| `declared-dimensions` | error, or warning for only one axis | The declared width or height is not an integer from 1 to 65535, or only one of the two is declared. |
| `dimensions`, `format` | error | The declared width and height, or the declared type, disagree with the image bytes. |
| `file-size` | error | The image is larger than `--max-file-size`. |
| `image` | error | The bytes are not a complete SVG, PNG, JPEG, WebP, or GIF. |
| `content-type`, `address`, `scheme`, `status`, `byte-limit`, ... | error | The fetch failed or was refused; these are the stable [`verify-url` codes](verification.md#verify-a-deployed-url). |
| `robots-disallowed`, `robots-unreachable`, `robots-unknown` | see [Crawler access](#crawler-access-robotstxt) | A crawler's robots.txt rules keep it from the image. |

The page is `valid` when no untargeted page finding is an error and every
image is `valid`.

## Compatibility targets

`--target NAME` (repeatable) evaluates the same
[compatibility profiles](compatibility.md) as
`verify`, against the image each consumer would choose rather than every
image on the page:

- The first `og:image`, and its `og:image:secure_url`, are evaluated for every
  target. X is the exception when the page has a `twitter:image`.
- `twitter:image` is evaluated for `x`.
- Later `og:image` entries and JSON-LD images get the structural and
  declared-metadata checks only, so a square fallback is not judged against
  LinkedIn's minimum size.

Targets judge the URL as the page publishes it, so a relative `og:image`
fails a target that needs a crawler-ready absolute https URL. With a target,
missing alt text is an error under that target, as it is for `verify --alt`.
With `x`, a missing `twitter:card` is an `x` target error. A page target is
compatible only when its page findings and every image chosen for it are.

## Crawler access (robots.txt)

A preview can only be built from what the platform's crawler is allowed to
fetch. With a `--target`, or `--crawler TOKEN`, `verify-page` reads
`/robots.txt` once for every origin the page and its images were served from
(each redirect included) and evaluates each crawler's rules for the page URL
and every fetched image URL:

```text
✓ https://example.com/blog/launch (1 image reference)
  ✓ og:image[0] https://cdn.example.com/og.png 1200x630 png (48213 bytes)
  ✗ robots.txt disallows Twitterbot (X) on 1 of 2 URLs
```

Crawlers are evaluated from the rules alone. No request is ever sent with a
crawler's user agent; robots.txt is fetched by the same hardened fetcher, as
`metaplate-verify/<version>`, with `Accept: text/plain`.

Each target implies the crawler its platform documents:

| Target | Product token | robots.txt | Source |
| --- | --- | --- | --- |
| `x` | `Twitterbot` | obeys | [X cards: getting started](https://developer.twitter.com/en/docs/twitter-for-websites/cards/guides/getting-started) |
| `facebook`, `instagram`, `threads` | `facebookexternalhit` | obeys | [Meta web crawlers](https://developers.facebook.com/docs/sharing/webmasters/web-crawlers) |
| `linkedin` | `LinkedInBot` | not documented | [LinkedIn: sharing content](https://www.linkedin.com/help/linkedin/answer/a521928) |
| `discord` | `Discordbot` | not documented | [Discord: component embeds](https://docs.discord.com/developers/link-previews/component-embeds) |
| `whatsapp` | `WhatsApp` | not documented | [WhatsApp link previews](https://developers.facebook.com/documentation/business-messaging/whatsapp/link-previews/) |
| `pinterest` | `Pinterestbot` | obeys | [Pinterestbot](https://help.pinterest.com/en/business/article/pinterestbot) |
| `slack` | `Slackbot-LinkExpanding` | ignores | [Slack robots](https://api.slack.com/robots) |

The finding's severity follows what the platform documents:

| robots.txt | Disallowed or unreachable | Not read |
| --- | --- | --- |
| obeys (and every `--crawler` token) | error | unknown |
| not documented | warning | unknown |
| ignores | not reported; the crawler summary line still shows the rules | not reported |

A target's findings land under that target: on the page, and on an image only
when it is the image that target reads. A `--crawler` token's findings are
untargeted and apply to every image, so a disallowed page or image makes the
page not `valid`. `--crawler` takes an RFC 9309 product token (letters, `-`,
and `_`), compared case-insensitively; a documented crawler named this way is
reported with its platform.

The file is fetched and read as RFC 9309 describes:

- A `200` is parsed. Groups name product tokens; every group naming the token
  is merged, the `*` group applies only when none does, and with neither
  everything is allowed. The rule matching the most octets wins, and `allow`
  wins a tie. `*` matches any characters and a final `$` anchors the end;
  `%2A` and `%24` match a literal `*` and `$`. Paths and patterns are compared
  in one percent-encoded form, query included, and `/robots.txt` itself is
  always allowed.
- Up to five redirects are followed, each re-checked by the address policy;
  more than five means the file is unavailable. The page's `--max-redirects`
  does not apply.
- A `4xx` means the file is unavailable, and every URL is allowed.
- A `5xx`, a timeout, or a network failure means it is unreachable, and every
  URL is disallowed (`robots-unreachable`).
- A file larger than 500 KiB is cut there and the part read is used
  (`truncated` in the report).
- A file the fetch policy refuses (a private address, a disallowed port, a
  non-http scheme) cannot be judged: every check against it is `null` and a
  `robots-unknown` finding is reported.

Platforms that are not in the table:

- Bluesky: each client fetches card metadata when a post is written and
  stores it in the post record, so there is no single crawler to evaluate.
- Mastodon: each server fetches previews with a
  `Mastodon/<version> (+https://<instance>/)` user agent, and its
  documentation says nothing about robots.txt.
- Telegram and iMessage: neither documents a crawler user agent or
  robots.txt behavior.

## Options

| Flag | Default | Effect |
| --- | --- | --- |
| `--json` | | Print one JSON report for every page (below). |
| `--target NAME` | | Evaluate a compatibility profile, and its crawler's robots.txt rules. Repeatable. |
| `--crawler TOKEN` | | Also evaluate robots.txt for this product token. Repeatable. |
| `--max-file-size N` | | Fail any image larger than `N` bytes. |
| `--max-html-bytes N` | 4 MiB | Abort a page larger than `N` bytes. |
| `--max-images N` | 8 | Fetch at most `N` distinct image URLs per page (1 to 100). |
| `--max-bytes N` | 16 MiB | Abort an image larger than `N` bytes. |
| `--max-redirects N` | 3 | Follow at most `N` redirects per request, each re-checked. |
| `--timeout MS` | 10000 | Time budget for each request, its redirects included. |
| `--allow-port PORT` | | Allow a port besides 80 and 443. Repeatable. |
| `--allow-private` | | Allow loopback and private addresses, for local development only. |

`--size`, `--format`, and `--alt` are rejected: those facts come from the
page.

## Network policy

The page and every image are fetched by the same hardened fetcher as
`verify-url`. Only `http:` and `https:` on default or explicitly allowed
ports; no URLs with credentials; every hop's resolved addresses must be
public, and the checked address is dialed directly; redirects are re-checked;
bodies are capped while they stream; and requests carry a fixed
`User-Agent: metaplate-verify/<version>`, no cookies, and no `Authorization`.
The page request sends `Accept: text/html,application/xhtml+xml` and must be
answered with a `200` whose `Content-Type` is `text/html` or
`application/xhtml+xml`. Image requests send `Accept: image/*`, and
robots.txt requests `Accept: text/plain`.

A page is untrusted input that chooses which URLs are fetched next, so the
address policy matters more here than for `verify-url`. A public page whose
`og:image` points at `http://169.254.169.254/` or `http://10.0.0.5/` gets an
`address` finding for that image, and the request is never sent. Credentials
embedded in an image URL are removed from every report field.

Local development needs both allowances:

```sh
npx metaplate verify-page --allow-private --allow-port 3000 http://127.0.0.1:3000/blog/launch
```

## JSON report

`--json` prints `{ "schemaVersion": 1, "pages": [...] }`, one entry per page
URL in argument order, shaped like the `verify-url` report:

```json
{
  "schemaVersion": 1,
  "pages": [
    {
      "url": "https://example.com/blog/launch",
      "finalUrl": "https://example.com/blog/launch",
      "redirects": [],
      "contentType": "text/html; charset=utf-8",
      "bytes": 18342,
      "baseUrl": "https://example.com/blog/launch",
      "valid": true,
      "metadata": {
        "openGraph": {
          "title": "Launch",
          "images": [{ "url": "https://example.com/blog/launch/og-image.png", "type": "image/png", "width": "1200", "height": "630", "alt": "Launch card" }]
        },
        "twitter": { "card": "summary_large_image" },
        "jsonLd": { "scripts": 0, "images": [] }
      },
      "globalIssues": [],
      "targets": { "x": { "compatible": true, "issues": [] } },
      "images": [
        {
          "source": "og:image",
          "index": 0,
          "declared": { "url": "https://example.com/blog/launch/og-image.png", "width": "1200", "height": "630", "type": "image/png", "alt": "Launch card" },
          "url": "https://example.com/blog/launch/og-image.png",
          "finalUrl": "https://example.com/blog/launch/og-image.png",
          "redirects": [],
          "contentType": "image/png",
          "bytes": 48213,
          "valid": true,
          "image": { "format": "png", "width": 1200, "height": 630, "bytes": 48213 },
          "globalIssues": [],
          "targets": { "x": { "compatible": true, "issues": [] } }
        }
      ]
    }
  ]
}
```

- Page fields: `url` (requested), `finalUrl`, `redirects`, `contentType`
  (verbatim, or `null`), `bytes` (HTML size), `baseUrl`, `valid`, `metadata`
  (what was extracted, with `baseHref` when the page has a `<base href>`),
  `globalIssues`, `targets`, and `images`.
- Image fields: `source` (`og:image`, `og:image:secure_url`, `twitter:image`,
  or `json-ld`), `index` (position among `og:image` entries or JSON-LD
  images; 0 for `twitter:image`), `declared` (the tag values as written;
  dimensions stay strings), `url` (resolved, or `null` when it does not
  resolve), `valid`, `globalIssues`, and `targets`. Once an image is fetched,
  `finalUrl`, `redirects`, `contentType`, and `bytes` are added, and `image`
  is added once its bytes are recognized.
- Every issue is `{ "severity", "code", "message" }`, plus `target` under a
  target. `severity` is `error`, `warning`, or `unknown`.
- `robots`, present when a crawler was evaluated:
  `{ "files": [...], "crawlers": [...] }`. Each file is `{ "origin", "url",
  "status" }` (`parsed`, `unavailable`, `unreachable`, or `unknown`) with
  `httpStatus`, `finalUrl`, `bytes`, `truncated`, and `message` when known.
  Each crawler is `{ "token", "platform", "robots", "targets", "requested",
  "allowed", "checks" }`, where `robots` is `honors`, `ignores`,
  `undocumented`, or `requested`, `allowed` is `true`, `false`, or `null`
  (unknown), and each check is `{ "resource": "page" | "image", "url",
  "robotsUrl", "allowed" }` plus `references` for images and the deciding
  `group` and `rule` (`{ "kind", "pattern", "line" }`) when the file was
  parsed.
- A page that could not be fetched is
  `{ "url", "valid": false, "globalIssues": [{ "severity": "error", "code", "message" }], "targets": {}, "images": [] }`.

The exit code is 1 when any page is not `valid` or any page target is not
`compatible`, and 0 otherwise. Argument errors also exit 1 and print the
usage.

## Library API

`verifyRemotePage` from `metaplate/node` returns the JSON report's page
entry. It throws `RemoteImageError` when the page itself cannot be fetched or
is not HTML, and returns every image finding in the report:

```ts
import { RemoteImageError, verifyRemotePage } from "metaplate/node";

try {
  const report = await verifyRemotePage("https://example.com/blog/launch", {
    targets: ["universal", "x"],
    maxHtmlBytes: 1_000_000,
    maxImages: 4,
  });
  const compatible = Object.values(report.targets).every((target) => target.compatible);
  if (!report.valid || !compatible) console.error(JSON.stringify(report, null, 2));
} catch (error) {
  if (error instanceof RemoteImageError) console.error(error.code, error.message);
  throw error;
}
```

Options are the `verifyRemoteImage` fetch options (`allowPrivate`,
`allowedPorts`, `maxRedirects`, `maxBytes` per image, `timeoutMs`,
`connectionTimeoutMs`, `resolve`), plus `maxHtmlBytes`, `maxImages`,
`maxImageReferences` (default 64; the first `og:image`, its
`og:image:secure_url`, and `twitter:image` are always inspected), `targets`,
`crawlers`, and `maxFileSize`. `REMOTE_PAGE_DEFAULTS` holds the page
defaults, `REMOTE_ROBOTS_DEFAULTS` the robots.txt limits, and
`CRAWLER_HTML_LIMITS` the Meta and WhatsApp read limits.

`parseRobotsTxt(text)` and `evaluateRobots(robots, token, url)` are the
RFC 9309 parser and matcher on their own, with no network access; both run in
linear time and use no regular expressions over the file or the URL.
`SOCIAL_CRAWLERS` and `findSocialCrawler(token)` expose the crawler table
above.

`extractPageSocialMetadata(html, documentUrl)` is the extractor on its own:
it takes HTML you already have and returns the `metadata` fields plus
`documentUrl`, `baseUrl`, and markup `issues`, without any network access.
Values are returned as written; resolve them against `baseUrl`.

[`examples/api/page-verification.ts`](../examples/api/page-verification.ts) is a
post-deploy check built on `verifyRemotePage`.

## Limitations

- The page is read as served. Tags added by client-side JavaScript are not
  seen, which matches crawlers that do not run scripts.
- Only the named references listed above are decoded. The extractor is a
  tokenizer that tracks only the tree builder's head and body decision: it
  does not otherwise implement the HTML parser's error recovery.
- robots.txt is evaluated, not obeyed: the page and images are fetched first
  as `metaplate-verify`, and robots.txt only decides the findings. Only
  `allow` and `disallow` are read; `crawl-delay` and `sitemap` are ignored.
  Pinterest reads robots.txt only from the main domain, not subdomains; that
  is not modeled.
- JSON-LD is read as plain JSON: `@context` term definitions and `@base` are
  not applied, so only the literal `ImageObject` types and `image`,
  `contentUrl`, `url`, `width`, `height`, and `encodingFormat` keys are
  recognized. `width` and `height` are compared only when given as pixel
  numbers or `QuantitativeValue`s with unit `E37`.
- Each request gets its own `--timeout` budget, so a page with `N` images can
  take up to `N + 1` budgets. Images are fetched one at a time.
- A page larger than `--max-html-bytes` fails rather than being read in part.
- `twitter:image:src` and other legacy aliases are not read, and
  `<meta http-equiv="refresh">` redirects are not followed; only HTTP
  redirects are.

## Specifications

- [The Open Graph protocol](https://ogp.me/): the four required properties
  including `og:image`; the `og:image` structured properties (`url`,
  `secure_url`, `type`, `width`, `height`, `alt`), with `og:image:url`
  identical to `og:image`; arrays, where structured properties follow their
  root tag, a new root ends the previous one, and the first tag is preferred
  on conflict; URL values as http(s) URLs; and the guidance that a page with
  an `og:image` should give `og:image:alt`.
- X Cards markup, cited from the last published versions of the
  [Cards markup reference](https://developer.x.com/en/docs/x-for-websites/cards/overview/markup)
  as in the [X cards guide](x-cards.md); those pages now
  redirect away from the card documentation. They define the `twitter:card`
  values and the fallback from `twitter:title`, `twitter:description`, and
  `twitter:image` to their Open Graph counterparts, which is why an absent
  `twitter:image` is accepted when an `og:image` exists.
- HTML Living Standard: the
  [`base` element](https://html.spec.whatwg.org/multipage/semantics.html#the-base-element)
  (the first `base` with `href` sets the frozen base URL, parsed against the
  fallback base URL, with `data:` and `javascript:` refused; this tool also
  refuses any other non-http(s) scheme), the
  [document base URL](https://html.spec.whatwg.org/multipage/urls-and-fetching.html#document-base-url)
  (the document's URL when there is no such `base`), the
  [`meta` element](https://html.spec.whatwg.org/multipage/semantics.html#the-meta-element)
  (names compared ASCII case-insensitively), and the
  [tokenizer](https://html.spec.whatwg.org/multipage/parsing.html#tokenization)
  rules for attributes, raw-text elements, and character references.
- [JSON-LD 1.1, Embedding JSON-LD in HTML Documents](https://www.w3.org/TR/json-ld11/#embedding-json-ld-in-html-documents):
  `<script type="application/ld+json">` data blocks, every such script
  processed, and the HTML document base URL as the base for relative
  references.
- [RFC 9309, Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309):
  groups and product tokens (2.2.1), longest-match rules with `allow` winning
  ties (2.2.2), `*` and `$` (2.2.3), the access results for redirects,
  unavailable, and unreachable files (2.3.1), and the 500 KiB parsing minimum
  (2.5).
- Meta's crawler reads the first 1 MB of a page
  ([Meta web crawlers](https://developers.facebook.com/docs/sharing/webmasters/web-crawlers));
  WhatsApp requires the `<head>` within the first 300KB
  ([WhatsApp link previews](https://developers.facebook.com/documentation/business-messaging/whatsapp/link-previews/)).
- [Schema.org `ImageObject`](https://schema.org/ImageObject): `contentUrl`
  ("actual bytes of the media object") preferred over `url`; `width` and
  `height` as `Distance` or `QuantitativeValue`; `encodingFormat` as a media
  type; and [`image`](https://schema.org/image), whose value is an
  `ImageObject` or a URL.
