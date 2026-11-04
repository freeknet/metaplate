# Teams, Slack, and Discord previews

How chat clients build link previews, and Adaptive Cards for bots and webhooks.

Pasting a link into Teams, Slack, or Discord needs no app: each client fetches
the page and builds the preview from the meta tags that `socialMetaTags` and
`socialMetaHtml` already emit. An app is needed only to replace that preview
with your own content or to post cards yourself.

| Client | Ordinary link preview reads | Metaplate input that feeds it | Needs an app for |
| --- | --- | --- | --- |
| Microsoft Teams | `og:title`, `og:description`, and `og:image` (or `<meta name="title">` and `<meta name="description">`), rendered as an Adaptive Card; a page that requires authentication gets no preview. Schema.org JSON-LD can upgrade the card to a richer template. | `title`, `description`, and the first Open Graph image | Link unfurling for your domains through a message extension (`messageHandlers` in the app manifest, answering `composeExtension/queryLink`), or posting cards from a bot or Workflows webhook |
| Slack | Open Graph and X (Twitter) Card metadata, when no installed app handles the domain ("classic" unfurling) | Open Graph images, `twitter:card`, `title`, `description`, `siteName` | App unfurls: subscribe to `link_shared` for up to five registered domains, then call `chat.unfurl` (`links:read`, `links:write`) |
| Discord | `og:title`, `og:description`, `og:site_name`, `og:image` with `og:image:width`/`height`/`type`/`alt`, `twitter:card`, `theme-color`, and `og:pubdate` | All of these: `themeColor` and `pubdate` set the last two; `twitter:card` defaults to `summary_large_image` | Bot or webhook messages with their own embeds |

Platform notes:

- **Teams.** Teams "unfurls a preview of the link into an Adaptive Card" with
  the page's image, title, and description, and keeps that preview when a page
  has no supported schema.org micro-capability
  ([micro-capabilities](https://learn.microsoft.com/en-us/microsoftteams/platform/messaging-extensions/how-to/micro-capabilities-for-website-links)).
  The website-preview tags and the authentication rule are documented under
  [Craft your website preview](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/share-to-teams-from-web-apps#craft-your-website-preview).
  App-driven [link unfurling](https://learn.microsoft.com/en-us/microsoftteams/platform/messaging-extensions/how-to/link-unfurling)
  requires a Teams app with a message extension; its results are cached for
  30 minutes. The `teams` target in `socialImageCompatibility` checks for an
  absolute HTTPS URL and the PNG, JPEG, or GIF formats Teams documents for
  card images.
- **Slack.** Without an app handler for the domain, Slack crawls the URL for
  Open Graph and X Card metadata; `unfurl_links` and `unfurl_media` on a
  posted message turn text and media previews off
  ([Unfurling links in messages](https://docs.slack.dev/messaging/unfurling-links-in-messages/)).
- **Discord.** Discord documents the tags it reads in
  [Link Previews](https://docs.discord.com/developers/link-previews/overview).
  Tags must be in the server-rendered HTML. `twitter:card` set to
  `summary_large_image`, metaplate's default, shows a large image below the
  text. Two or more `og:image` tags become a gallery of up to four, so a page
  with size variants previews as a gallery. Declaring `og:image:width` and
  `og:image:height` spares a measurement fetch. Images may be PNG, GIF, JPEG,
  WebP, or AVIF. The accent color comes from
  `<meta name="theme-color" content="#RRGGBB">` (or `#RRGGBBAA`), which
  `socialMetaTags` emits from `themeColor`, and the embed timestamp from
  `og:pubdate`, a full RFC 3339 timestamp, which it emits from `pubdate`; see
  [page-level tags](metadata.md#page-level-tags). Previews are cached for
  about 30 minutes.

### Adaptive Cards for bots and webhooks

`socialImageAdaptiveCard(metadata, options)` builds the card that a Teams bot,
Workflows webhook, or message extension posts. Ordinary link previews do not
need it. The card declares schema
`https://adaptivecards.io/schemas/adaptive-card.json` and version `1.6`, the
highest version Teams supports for bot-sent cards, message extensions, link
unfurling, and dialogs
([cards reference](https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-reference#support-for-adaptive-cards)).
Pass `version` to target an older host; the
[link unfurling](https://learn.microsoft.com/en-us/microsoftteams/platform/messaging-extensions/how-to/link-unfurling)
page still lists 1.3 and earlier for unfurl responses. The body is an `Image`
(`altText` from the image's alt text), a bold title `TextBlock`, an optional
subtle description `TextBlock`, and an `Action.OpenUrl` to `url`:

```ts
import {
  ADAPTIVE_CARD_CONTENT_TYPE,
  socialImage,
  socialImageAdaptiveCard,
  variantImagePath,
} from "metaplate";

const page = {
  title: "Release notes",
  description: "What changed in the latest release.",
  url: "https://example.com/blog/release-notes",
};
// Teams card images must fit 1024x1024; serve a smaller rendering for cards.
const teamsImage = socialImage("/blog/release-notes", "Release notes card", {
  type: "image/png",
  size: { width: 1024, height: 536 },
  imagePath: variantImagePath("og-image", "teams"),
});
const card = socialImageAdaptiveCard({ openGraph: { images: [teamsImage] } }, page);

// Workflows webhook ("When a Teams webhook request is received") body:
const webhookBody = {
  type: "message",
  attachments: [{ contentType: ADAPTIVE_CARD_CONTENT_TYPE, contentUrl: null, content: card }],
};
// Bot Framework attachment for context.sendActivity({ attachments: [attachment] }):
const attachment = { contentType: ADAPTIVE_CARD_CONTENT_TYPE, content: card };
```

The resulting card:

```json
{
  "$schema": "https://adaptivecards.io/schemas/adaptive-card.json",
  "type": "AdaptiveCard",
  "version": "1.6",
  "body": [
    {
      "type": "Image",
      "url": "https://example.com/blog/release-notes/og-image-teams",
      "altText": "Release notes card",
      "size": "stretch"
    },
    { "type": "TextBlock", "text": "Release notes", "wrap": true, "size": "medium", "weight": "bolder" },
    { "type": "TextBlock", "text": "What changed in the latest release.", "wrap": true, "isSubtle": true }
  ],
  "actions": [
    { "type": "Action.OpenUrl", "title": "Open", "url": "https://example.com/blog/release-notes" }
  ]
}
```

The builder enforces the limits Teams documents and throws when one is not
met:

- The image is the first Open Graph image whose declared width and height are
  at most 1024 pixels. Card images "must be at most 1024 × 1024 pixels and in
  PNG, JPEG, or GIF format", and animated GIF and SVG are not supported
  ([inline card images](https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-reference#inline-card-images)).
  A declared `type` must be `image/png`, `image/jpeg`, or `image/gif`; without
  one, an `.svg`, `.webp`, or `.avif` path is rejected.
- The image URL, resolved against `url`, must be credential-free HTTPS. Teams
  also does not follow redirects for card images, which cannot be checked
  locally.
- Pass `fileSize` to check the image's encoded size against the documented
  limit of less than 1 MB
  ([card formatting](https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-format)).
- The serialized card must fit the 28 KB Workflows webhook message limit
  ([incoming webhooks](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook));
  bot messages allow 100 KB
  ([message size limits](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/format-your-bot-messages#message-size-limits)).
- `title` and the image's alt text must be non-empty. `actionTitle` sets the
  button label (default `"Open"`). `TextBlock` text is rendered with the
  Adaptive Card Markdown subset, so escape Markdown characters that should
  appear literally.

Office 365 Connectors, including connector-based Incoming Webhooks, were
retired in May 2026; Teams webhooks are now created with the Workflows app,
which accepts the same `{ type: "message", attachments: [...] }` body. See
[`examples/api/adaptive-card.ts`](https://github.com/freeknet/metaplate/blob/main/examples/api/adaptive-card.ts). Metaplate makes no
network calls: posting the card, and keeping the webhook URL secret, stay with
the caller.
