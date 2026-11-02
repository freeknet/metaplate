# X player and app cards

X's player and app cards, their required fields, and how they map to Next.js metadata.

Besides the two summary cards, X documents two cards that carry a payload of
their own: a **player card** embeds an HTTPS iframe that plays video or audio,
and an **app card** points at an app in the App Store or Google Play.
`twitter.card` selects one, and its payload is required by the type system
and checked again at runtime:

```ts
import { socialImageMetadata } from "metaplate";

const trailer = socialImageMetadata("/trailer", "Trailer card", {
  origin: "https://example.com",
  imagePath: "og-image.png",
  twitter: {
    card: "player",
    site: "@example", // or siteId
    player: {
      url: "https://example.com/embed/trailer", // twitter:player (HTTPS iframe)
      width: 1280, // twitter:player:width
      height: 720, // twitter:player:height
      stream: "https://cdn.example.com/trailer.mp4", // optional twitter:player:stream
    },
  },
});

const install = socialImageMetadata("/app", "App card", {
  origin: "https://example.com",
  twitter: {
    card: "app",
    site: "@example",
    description: "Track launches from your phone.", // optional twitter:description
    app: {
      // At least one of iphone, ipad, googleplay; name and url are optional.
      iphone: { id: "307234931", name: "Example", url: "example://home" },
      googleplay: { id: "com.example.app" },
      country: "GB", // optional twitter:app:country
    },
  },
});
```

The rules come from X's
[Cards markup reference](https://developer.x.com/en/docs/x-for-websites/cards/overview/markup),
[Player Card](https://developer.x.com/en/docs/x-for-websites/cards/overview/player-card),
and [App Card](https://developer.x.com/en/docs/x-for-websites/cards/overview/app-card)
pages, and the X Cards section of the
[Developer Policy](https://docs.x.com/developer-terms/policy). Those
developer.x.com pages now redirect to the docs.x.com home page, which no
longer carries the card references; the rules below follow their last
published versions.

| Field | Rule |
| --- | --- |
| `card` | `player` requires `player`; `app` requires `app`. A payload on any other card, including an omitted card (`summary_large_image`), is an error. |
| `site`, `siteId` | X marks `twitter:site` required on both cards: a player card needs `site` or `siteId`, an app card needs `site`. |
| `player.url`, `player.stream` | Absolute `https:` URL without credentials. X requires HTTPS for every card asset. |
| `player.width`, `player.height` | Integer from 1 to 65535: the iframe size in pixels. |
| X Card image | A player card needs one, and X does not render a player card whose image has fewer than 68,600 pixels (262x262, or 350x196 at 16:9). Checked whenever the dimensions are known. |
| `app` | At least one of `iphone`, `ipad`, `googleplay`, and no other keys. X says to omit the tags of a platform you do not support. |
| `app.<platform>.id` | Non-empty. `iphone` and `ipad` take the numeric App Store ID (such as `307234931`), not the bundle ID. |
| `app.<platform>.name`, `.url` | Optional and non-empty. `url` is a deep link with `://` after the scheme name. |
| `app.country` | Two-letter country code. X searches the US App Store unless this is set. |
| `description` | Player and app cards only; at most 200 characters. |

Missing or mismatched payloads, a listing without its `id`, and a missing
`site` fail to compile; every rule above also throws for untyped callers.
The payload is copied into the metadata (`twitter.player` or `twitter.app`,
plus `twitter.description`), so later changes to the source object cannot
alter it. Summary cards gain no new keys and their output is unchanged.

`socialMetaTags` and `socialMetaHtml` apply the same rules to hand-authored
metadata and add the card tags at the end of the X Card section, after
`twitter:creator:id`:

- player: `twitter:description`, `twitter:player`, `twitter:player:width`,
  `twitter:player:height`, `twitter:player:stream`;
- app: `twitter:description`, then `twitter:app:name:<platform>`,
  `twitter:app:id:<platform>`, and `twitter:app:url:<platform>` for
  `iphone`, `ipad`, and `googleplay` in that order, then
  `twitter:app:country`.

Optional fields that are not set emit nothing. The player card above
serializes as:

```html
<meta name="twitter:card" content="player">
<meta name="twitter:image" content="https://example.com/trailer/og-image.png">
<meta name="twitter:image:alt" content="Trailer card">
<meta name="twitter:site" content="@example">
<meta name="twitter:player" content="https://example.com/embed/trailer">
<meta name="twitter:player:width" content="1280">
<meta name="twitter:player:height" content="720">
<meta name="twitter:player:stream" content="https://cdn.example.com/trailer.mp4">
```

The social image stays `twitter:image`. On a player card it is what X shows
where the player cannot run, so X recommends giving it the player's
dimensions. An app card's image and store details come from the App Store or
Google Play, not from the page. X marks `twitter:title` required on player
cards and falls back to `og:title`, so pass `title` to `socialMetaTags`
(or set Next's `title`).

In Next.js, pass the result through `nextTwitterMetadata` from
`metaplate/next`. It maps a player card to Next's `players` and an app card
to Next's `app`, carries `description`, and passes summary cards through:

```ts
import type { Metadata } from "next";
import { nextTwitterMetadata } from "metaplate/next";

export const metadata: Metadata = {
  openGraph: { images: trailer.openGraph.images },
  twitter: nextTwitterMetadata(trailer.twitter),
};
```

Next's `Metadata.twitter` cannot express all of X's markup, so
`nextTwitterMetadata` throws rather than drop or misrender a field. Next's
player descriptor requires `streamUrl` and always renders
`twitter:player:stream`, so a player card needs `stream`. Next's app
descriptor has a single `name`, which it writes as `twitter:app:name:*` for
all three platforms, so the listed platforms must share one name or have
none. Next has no `twitter:app:country`. Emit such cards with
`socialMetaTags` instead.

What X controls, not your markup:

- **Player cards are reviewed.** X's card overview says to tweet the URL
  "after testing in the validator or approval of your Player Card", and its
  Player Card policy says cards that do not work in every X client, or that
  raise mixed-content warnings, "will not be approved". Player cards are
  reserved for linear audio and video: no sign-in, no interactivity beyond the
  player, sound off by default, and no autoplay for content longer than
  10 seconds.
- **App cards** need an app that is publicly available in the store, and the
  Developer Policy allows one only on a post that promotes or refers to the
  app.

These cards are X-specific. Other link-preview consumers read Open Graph, and
`socialImageCompatibility` judges the image alone, not the card type.
