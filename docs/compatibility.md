# Social compatibility profiles

Checking an image descriptor against each platform's published preview rules.

`socialImageCompatibility` checks local descriptor facts without making
network requests. The conservative `universal` profile requires an absolute
HTTPS URL and PNG/JPEG media type; named profiles add documented checks,
including LinkedIn's minimum dimensions, a 1.91:1 aspect-ratio warning, and
optional 5 MB limit:

```ts
import { socialImageCompatibility } from "metaplate";

const report = socialImageCompatibility(metadata.openGraph.images[0], {
  targets: ["universal", "facebook", "linkedin", "slack"],
  fileSize: generatedBytes.byteLength,
});

if (!report.compatible) throw new Error(JSON.stringify(report.issues));
```

Pass `checkUrl: false` or `checkAlt: false` to evaluate a descriptor that has
not been assigned a URL or alt text yet; the input type,
`SocialCompatibilityImage`, makes both fields optional.

Issues are `error`, `warning`, or `unknown`. The `discord` profile checks the
image formats Discord's
[link-preview contract](https://docs.discord.com/developers/link-previews/overview)
supports (PNG, GIF, JPEG, WebP, and AVIF); Discord sets no image size limit and
accepts root-relative image URLs. Instagram checks are reported as unknown
because Instagram publishes no webpage image-tag contract. SVG remains useful as renderer output, but it is not a universal
social delivery format; use PNG or JPEG for broad crawler compatibility.

The messaging and social profiles below encode only what each platform's own
documentation states. A property a platform does not document is not checked,
and a platform that documents no image contract is reported as `unknown`:

| Target | Checks | Not published, so not checked | Source |
| --- | --- | --- | --- |
| `whatsapp` | `og:image` must be an absolute URL; the image must be under 600KB (600,000 bytes), at least 300px wide, and no wider than 4:1. A miss is an `error`: WhatsApp shows the large preview only when these are met, and its relaxed fallback "should not be relied on". | Image format (its own example `og:image` is an SVG), HTTPS, a height minimum | [Link previews](https://developers.facebook.com/documentation/business-messaging/whatsapp/link-previews/) |
| `bluesky` | Each posting client fetches the page and uploads the `og:image` as the card's thumbnail blob, which the `app.bsky.embed.external` lexicon limits to `image/*` and 1,000,000 bytes. A larger file is a `warning`, because the client may re-encode it before upload. | Dimensions, aspect ratio, a format narrower than `image/*`, an image URL rule | [Website card embeds](https://bsky.network/docs/about-bluesky-content/posts#website-card-embeds), [`app.bsky.embed.external` lexicon](https://github.com/bluesky-social/atproto/blob/main/packages/api/lexicons/app/bsky/embed/external.json) |
| `telegram` | `unknown`: Telegram documents link-preview options for bots and Instant View templates, not the page tags or image an ordinary preview reads. | Everything | [Bot API `LinkPreviewOptions`](https://core.telegram.org/bots/api#linkpreviewoptions), [Instant View](https://instantview.telegram.org/docs) |
| `threads` | `unknown`: the Threads API says a link is "displayed as a link preview" but not which tags or image it reads. | Everything | [Threads posts](https://developers.facebook.com/documentation/threads/posts) |
| `pinterest` | `unknown`: Rich Pins read up to six `og:image` tags, each "a high-resolution image", with no format, size, or URL requirement. | Everything | [Article Rich Pins](https://developers.pinterest.com/docs/web-features/article-rich-pins/), [Product Rich Pins](https://developers.pinterest.com/docs/web-features/product-rich-pins/) |

This local report cannot prove public fetchability, redirects, response MIME,
robots/WAF behavior, or crawler caches. Those require checking the deployed
page and image; use Meta Sharing Debugger, LinkedIn Post Inspector, and the
relevant client debugger after deployment.
