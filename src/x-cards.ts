/**
 * X player and app cards. The summary cards carry only an image; these two
 * carry a payload of their own (`twitter:player*` or `twitter:app:*`), as X's
 * card markup, Player Card, and App Card references document. Everything
 * card-specific lives here so `core.ts` and `meta-tags.ts` only route to it.
 */

import type { SocialImageDescriptor } from "./core.js";

export type { XCardMetadata, XCardMetadataFields, XCardOptions } from "./core.js";

/** Largest iframe dimension accepted, matching the image-dimension ceiling. */
const MAX_PLAYER_DIMENSION = 65_535;

/**
 * X's Player Card reference: "Images with fewer than 68,600 pixels (a 262x262
 * square image, or a 350x196 16:9 image) will cause the player card not to
 * render."
 */
export const X_PLAYER_MIN_IMAGE_PIXELS = 68_600;

/** X documents `twitter:description` as "a maximum of 200 characters". */
const MAX_DESCRIPTION_LENGTH = 200;

/** App stores an X App Card can name, in the order their tags are emitted. */
export const X_APP_PLATFORMS = ["iphone", "ipad", "googleplay"] as const;

export type XAppPlatform = (typeof X_APP_PLATFORMS)[number];

/**
 * `card: "player"` payload. X requires HTTPS for every card asset, so the
 * iframe and the stream must be absolute, credential-free HTTPS URLs.
 */
export type XPlayerCard = {
  /** HTTPS URL of the iframe player, emitted as `twitter:player`. */
  url: string;
  /** Iframe width in pixels, emitted as `twitter:player:width`. */
  width: number;
  /** Iframe height in pixels, emitted as `twitter:player:height`. */
  height: number;
  /** HTTPS URL of a raw video or audio stream, emitted as `twitter:player:stream`. */
  stream?: string;
};

/** One store listing of an X App Card. */
export type XAppStoreListing = {
  /**
   * Store ID, emitted as `twitter:app:id:<platform>`: the numeric App Store
   * ID for `iphone` and `ipad` (such as `"307234931"`, not the bundle ID), or
   * the Google Play ID for `googleplay` (such as `"com.example.app"`).
   */
  id: string;
  /** App name, emitted as `twitter:app:name:<platform>`. */
  name?: string;
  /**
   * Deep link using the app's custom URL scheme, including `://` after the
   * scheme name. Emitted as `twitter:app:url:<platform>`.
   */
  url?: string;
};

type XAppListings = { [Platform in XAppPlatform]?: XAppStoreListing };

/** Requires at least one platform listing while keeping the others optional. */
type AtLeastOneListing = {
  [Platform in XAppPlatform]: Required<Pick<XAppListings, Platform>> &
    Omit<XAppListings, Platform>;
}[XAppPlatform];

/** `card: "app"` payload: at least one store listing, plus an optional country. */
export type XAppCard = AtLeastOneListing & {
  /**
   * Two-letter App Store country code, emitted as `twitter:app:country`. X
   * searches the US store by default and requires this when the app is not
   * available there.
   */
  country?: string;
};

/** The X Card fields the card rules read. */
export type XCardPayload = {
  card?: string | undefined;
  site?: string | undefined;
  siteId?: string | undefined;
  images?: readonly { width?: number | undefined; height?: number | undefined }[] | undefined;
  player?: XPlayerCard | undefined;
  app?: XAppCard | undefined;
  description?: string | undefined;
};

/** Validated, copied card payload: exactly the keys its card uses. */
export type XCardFields =
  | Record<string, never>
  | { player: XPlayerCard; description?: string }
  | { app: XAppCard; description?: string };

const IOS_APP_ID = /^\d+$/;

function assertHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} must be a non-empty HTTPS URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL; received ${value}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label} must use https:, as X requires for card assets; received ${value}`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain credentials; received ${value}`);
  }
  return value;
}

function assertPlayerDimension(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_PLAYER_DIMENSION
  ) {
    throw new Error(
      `${label} must be an integer from 1 to ${MAX_PLAYER_DIMENSION}; received ${String(value)}`,
    );
  }
  return value;
}

function assertText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function copyPlayer(player: XPlayerCard, label: string): XPlayerCard {
  return {
    url: assertHttpsUrl(player.url, `${label}.url`),
    width: assertPlayerDimension(player.width, `${label}.width`),
    height: assertPlayerDimension(player.height, `${label}.height`),
    ...(player.stream === undefined
      ? {}
      : { stream: assertHttpsUrl(player.stream, `${label}.stream`) }),
  };
}

function copyListing(platform: XAppPlatform, listing: XAppStoreListing, label: string) {
  const id = assertText(listing.id, `${label}.id`);
  if (platform !== "googleplay" && !IOS_APP_ID.test(id)) {
    throw new Error(
      `${label}.id must be the numeric App Store ID, not the bundle ID; received ${id}`,
    );
  }
  const url = listing.url === undefined ? undefined : assertText(listing.url, `${label}.url`);
  if (url !== undefined && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) {
    throw new Error(`${label}.url must be a URL with "://" after its scheme name; received ${url}`);
  }
  return {
    id,
    ...(listing.name === undefined ? {} : { name: assertText(listing.name, `${label}.name`) }),
    ...(url === undefined ? {} : { url }),
  };
}

function copyApp(app: XAppCard, label: string): XAppCard {
  const copy: XAppListings & { country?: string } = {};
  for (const key of Object.keys(app)) {
    if (key !== "country" && !(X_APP_PLATFORMS as readonly string[]).includes(key)) {
      throw new Error(
        `${label}.${key} is not an X App Card platform; expected ${X_APP_PLATFORMS.join(", ")}`,
      );
    }
  }
  for (const platform of X_APP_PLATFORMS) {
    const listing = (app as XAppListings)[platform];
    if (listing !== undefined) {
      copy[platform] = copyListing(platform, listing, `${label}.${platform}`);
    }
  }
  if (!X_APP_PLATFORMS.some((platform) => copy[platform])) {
    throw new Error(
      `${label} must list at least one of ${X_APP_PLATFORMS.join(", ")} with an app id`,
    );
  }
  if (app.country !== undefined) {
    if (typeof app.country !== "string" || !/^[A-Za-z]{2}$/.test(app.country)) {
      throw new Error(
        `${label}.country must be a two-letter country code; received ${String(app.country)}`,
      );
    }
    copy.country = app.country;
  }
  return copy as XAppCard;
}

function copyDescription(description: string | undefined, label: string) {
  if (description === undefined) return {};
  const text = assertText(description, label);
  if ([...text].length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`${label} must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return { description: text };
}

/** The Player Card reference lists `twitter:image` as required, with a pixel floor. */
function assertPlayerImage(twitter: XCardPayload, label: string): void {
  const image = twitter.images?.[0];
  if (!image) {
    throw new Error(`card: "player" requires ${label}.images: X shows the image where the player cannot run`);
  }
  const { width, height } = image;
  if (width !== undefined && height !== undefined && width * height < X_PLAYER_MIN_IMAGE_PIXELS) {
    throw new Error(
      `${label} image is ${width}x${height}; X does not render a player card whose image has fewer than ${X_PLAYER_MIN_IMAGE_PIXELS} pixels`,
    );
  }
}

/**
 * Validates the card-specific payload against its card and returns an
 * independent copy holding only the keys that card uses: `{}` for the summary
 * cards, `{ player, description? }` for `player`, and `{ app, description? }`
 * for `app`.
 *
 * @throws When the payload is missing for its card or supplied for another
 *   card, when a player or app card has no `site` (a player card also
 *   accepts `siteId`), or when a field breaks its rule: HTTPS-only player and
 *   stream URLs, integer player dimensions from 1 to 65535, a player image of
 *   at least 68,600 pixels, at least one app platform, non-empty app ids,
 *   names, and URLs, numeric App Store ids, `://` in app URLs, a two-letter
 *   country code, and a description of at most 200 characters.
 */
export function xCardFields(twitter: XCardPayload, label = "twitter"): XCardFields {
  const card = twitter.card;
  if (card !== "player" && twitter.player !== undefined) {
    throw new Error(`${label}.player requires card: "player"; received card: ${String(card)}`);
  }
  if (card !== "app" && twitter.app !== undefined) {
    throw new Error(`${label}.app requires card: "app"; received card: ${String(card)}`);
  }
  if (card !== "player" && card !== "app" && twitter.description !== undefined) {
    throw new Error(
      `${label}.description requires card: "player" or "app"; received card: ${String(card)}`,
    );
  }
  if (card === "player") {
    if (twitter.player === undefined) {
      throw new Error(`card: "player" requires ${label}.player with url, width, and height`);
    }
    if (!twitter.site && !twitter.siteId) {
      throw new Error(`card: "player" requires ${label}.site or ${label}.siteId`);
    }
    assertPlayerImage(twitter, label);
    return {
      player: copyPlayer(twitter.player, `${label}.player`),
      ...copyDescription(twitter.description, `${label}.description`),
    };
  }
  if (card === "app") {
    if (twitter.app === undefined) {
      throw new Error(`card: "app" requires ${label}.app with at least one platform id`);
    }
    if (!twitter.site) {
      throw new Error(`card: "app" requires ${label}.site`);
    }
    return {
      app: copyApp(twitter.app, `${label}.app`),
      ...copyDescription(twitter.description, `${label}.description`),
    };
  }
  return {};
}

/** A `<meta name>` pair, as `socialMetaTags` emits for the twitter section. */
export type XCardTag = { name: string; content: string };

/**
 * The card-specific tags, appended after the shared X Card tags:
 *
 * - `player`: `twitter:description`, `twitter:player`,
 *   `twitter:player:width`, `twitter:player:height`, `twitter:player:stream`.
 * - `app`: `twitter:description`, then per platform in `iphone`, `ipad`,
 *   `googleplay` order `twitter:app:name:<p>`, `twitter:app:id:<p>`,
 *   `twitter:app:url:<p>`, then `twitter:app:country`.
 *
 * Optional fields that are absent emit nothing. Summary cards add nothing,
 * so their output is unchanged.
 */
export function xCardTags(twitter: XCardPayload): XCardTag[] {
  const fields = xCardFields(twitter);
  const tags: XCardTag[] = [];
  if (fields.description !== undefined) {
    tags.push({ name: "twitter:description", content: fields.description });
  }
  if ("player" in fields) {
    const { player } = fields;
    tags.push({ name: "twitter:player", content: player.url });
    tags.push({ name: "twitter:player:width", content: String(player.width) });
    tags.push({ name: "twitter:player:height", content: String(player.height) });
    if (player.stream !== undefined) {
      tags.push({ name: "twitter:player:stream", content: player.stream });
    }
  }
  if ("app" in fields) {
    const app = fields.app as XAppListings & { country?: string };
    for (const platform of X_APP_PLATFORMS) {
      const listing = app[platform];
      if (!listing) continue;
      if (listing.name !== undefined) {
        tags.push({ name: `twitter:app:name:${platform}`, content: listing.name });
      }
      tags.push({ name: `twitter:app:id:${platform}`, content: listing.id });
      if (listing.url !== undefined) {
        tags.push({ name: `twitter:app:url:${platform}`, content: listing.url });
      }
    }
    if (app.country !== undefined) {
      tags.push({ name: "twitter:app:country", content: app.country });
    }
  }
  return tags;
}

/** The shared X Card fields every card's metadata carries. */
type XCardMetadataBase = {
  card: string;
  images: SocialImageDescriptor[];
  site?: string;
  siteId?: string;
  creator?: string;
  creatorId?: string;
};

type NextPlatformValues = { [Platform in XAppPlatform]?: string };

/**
 * Next.js `Metadata.twitter` for one card, mirrored structurally so the root
 * entry stays free of Next types. `metaplate/next` re-exports the mapping with
 * Next's own return type, which checks this mirror against it.
 */
export type NextTwitterShape = Omit<XCardMetadataBase, "card"> &
  (
    | { card: "summary" | "summary_large_image" }
    | {
        card: "player";
        description?: string;
        players: [{ playerUrl: string; streamUrl: string; width: number; height: number }];
      }
    | {
        card: "app";
        description?: string;
        app: { name?: string; id: NextPlatformValues; url?: NextPlatformValues };
      }
  );

function nextApp(app: XAppCard): Extract<NextTwitterShape, { card: "app" }>["app"] {
  const listings = app as XAppListings & { country?: string };
  if (listings.country !== undefined) {
    throw new Error(
      "Next.js has no twitter:app:country field; emit App Cards that set app.country with socialMetaTags.",
    );
  }
  const listed = X_APP_PLATFORMS.flatMap((platform) => {
    const listing = listings[platform];
    return listing ? [[platform, listing] as const] : [];
  });
  const names = new Set(listed.map(([, listing]) => listing.name));
  if (names.size > 1) {
    throw new Error(
      "Next.js writes one twitter.app name for every platform; give each listed platform the same name, or none, or emit the tags with socialMetaTags.",
    );
  }
  const [name] = names;
  const id: NextPlatformValues = {};
  const url: NextPlatformValues = {};
  for (const [platform, listing] of listed) {
    id[platform] = listing.id;
    if (listing.url !== undefined) url[platform] = listing.url;
  }
  return {
    ...(name === undefined ? {} : { name }),
    id,
    ...(Object.keys(url).length > 0 ? { url } : {}),
  };
}

/**
 * Maps validated X Card metadata onto Next.js's `twitter` metadata field.
 * Next can express a subset of X's markup, so anything it would drop or
 * misrender is refused rather than lost:
 *
 * - Next's player descriptor requires `streamUrl` and always renders
 *   `twitter:player:stream`, so a player card needs `player.stream`.
 * - Next's app descriptor has one `name` that it writes for all three
 *   platforms, so per-platform names must either be absent or identical on
 *   every listed platform.
 * - Next has no `twitter:app:country` field, so `app.country` is refused.
 *
 * @throws When the metadata cannot be represented exactly, or when its card
 *   payload is invalid.
 */
export function nextTwitterShape(twitter: XCardMetadataBase & XCardPayload): NextTwitterShape {
  const fields = xCardFields(twitter);
  const base = {
    images: twitter.images.map((image) => ({ ...image })),
    ...(twitter.site ? { site: twitter.site } : {}),
    ...(twitter.siteId ? { siteId: twitter.siteId } : {}),
    ...(twitter.creator ? { creator: twitter.creator } : {}),
    ...(twitter.creatorId ? { creatorId: twitter.creatorId } : {}),
    ...(fields.description === undefined ? {} : { description: fields.description }),
  };
  if ("player" in fields) {
    const { player } = fields;
    if (player.stream === undefined) {
      throw new Error(
        "Next.js requires twitter.player.stream: its player descriptor makes streamUrl mandatory and always renders twitter:player:stream. Supply a stream, or emit the tags with socialMetaTags.",
      );
    }
    const { url: playerUrl, stream: streamUrl, width, height } = player;
    return { card: "player", ...base, players: [{ playerUrl, streamUrl, width, height }] };
  }
  if ("app" in fields) {
    return { card: "app", ...base, app: nextApp(fields.app) };
  }
  return { card: twitter.card as "summary" | "summary_large_image", ...base };
}
