import { describe, expect, it } from "vitest";
import { nextTwitterMetadata } from "../../src/next.js";
import {
  X_APP_PLATFORMS,
  socialImageMetadata,
  socialMetaHtml,
  socialMetaTags,
  type SocialMetaInput,
  type SocialMetaTag,
  type XAppCard,
  type XImageOptions,
  type XPlayerCard,
} from "../../src/index.js";

const origin = "https://example.com";
const player: XPlayerCard = {
  url: "https://example.com/embed/launch",
  width: 640,
  height: 360,
  stream: "https://cdn.example.com/launch.mp4",
};
const app: XAppCard = {
  iphone: { id: "307234931", name: "Example", url: "example://launch" },
  ipad: { id: "307234931", name: "Example", url: "example://launch" },
  googleplay: { id: "com.example.app", name: "Example", url: "example://launch" },
};

/** Builds metadata through the public options, untyped so bad input reaches runtime checks. */
const metadataFor = (twitter: unknown, size?: { width: number; height: number }) =>
  socialImageMetadata("/launch", "Launch card", {
    origin,
    ...(size ? { size } : {}),
    twitter: twitter as XImageOptions,
  });

const twitterTags = (tags: SocialMetaTag[]) =>
  tags.filter((tag) => tag.name !== undefined).map((tag) => [tag.name, tag.content]);

const sharedTags = [
  ["twitter:image", "https://example.com/launch/og-image"],
  ["twitter:image:alt", "Launch card"],
  ["twitter:site", "@example"],
];

describe("X player cards", () => {
  it("emits the player tags after the shared X Card tags, in documented order", () => {
    const metadata = metadataFor({ card: "player", site: "@example", description: "Launch day.", player });

    expect(twitterTags(socialMetaTags(metadata))).toEqual([
      ["twitter:card", "player"],
      ...sharedTags,
      ["twitter:description", "Launch day."],
      ["twitter:player", "https://example.com/embed/launch"],
      ["twitter:player:width", "640"],
      ["twitter:player:height", "360"],
      ["twitter:player:stream", "https://cdn.example.com/launch.mp4"],
    ]);
  });

  it("omits optional tags that are not supplied", () => {
    const { stream, ...iframeOnly } = player;
    void stream;
    const tags = twitterTags(socialMetaTags(metadataFor({ card: "player", siteId: "42", player: iframeOnly })));

    expect(tags.map(([name]) => name)).toEqual([
      "twitter:card",
      "twitter:image",
      "twitter:image:alt",
      "twitter:site:id",
      "twitter:player",
      "twitter:player:width",
      "twitter:player:height",
    ]);
  });

  it("keeps the Open Graph image group ahead of the twitter section", () => {
    const lines = socialMetaHtml(metadataFor({ card: "player", site: "@example", player })).split("\n");

    expect(lines[0]).toBe('<meta property="og:image" content="https://example.com/launch/og-image">');
    expect(lines.at(-1)).toBe(
      '<meta name="twitter:player:stream" content="https://cdn.example.com/launch.mp4">',
    );
  });

  it("copies the payload so later caller mutation cannot change the metadata", () => {
    const source = { ...player };
    const metadata = metadataFor({ card: "player", site: "@example", player: source });
    source.url = "https://evil.example/embed";

    expect(metadata.twitter).toMatchObject({ card: "player", player });
  });

  it("accepts an image of exactly 68,600 pixels", () => {
    const metadata = metadataFor({ card: "player", site: "@example", player }, { width: 350, height: 196 });

    expect(metadata.twitter.images[0]).toMatchObject({ width: 350, height: 196 });
  });
});

describe("X app cards", () => {
  it("emits description, then name, id, and url per platform, then country", () => {
    const metadata = metadataFor({
      card: "app",
      site: "@example",
      description: "Launch tracking in your pocket.",
      app: { ...app, country: "GB" },
    });

    expect(twitterTags(socialMetaTags(metadata))).toEqual([
      ["twitter:card", "app"],
      ...sharedTags,
      ["twitter:description", "Launch tracking in your pocket."],
      ...X_APP_PLATFORMS.flatMap((platform) => [
        [`twitter:app:name:${platform}`, "Example"],
        [`twitter:app:id:${platform}`, platform === "googleplay" ? "com.example.app" : "307234931"],
        [`twitter:app:url:${platform}`, "example://launch"],
      ]),
      ["twitter:app:country", "GB"],
    ]);
  });

  it("emits only the listed platforms and their supplied fields", () => {
    const tags = twitterTags(socialMetaTags(metadataFor({ card: "app", site: "@example", app: { ipad: { id: "42" } } })));

    expect(tags.slice(4)).toEqual([["twitter:app:id:ipad", "42"]]);
  });
});

describe("summary cards", () => {
  it("carry no card payload and serialize exactly as before", () => {
    const metadata = metadataFor({ card: "summary", site: "@example", creator: "@author" });

    expect(Object.keys(metadata.twitter)).toEqual(["card", "images", "site", "creator"]);
    expect(twitterTags(socialMetaTags(metadata))).toEqual([
      ["twitter:card", "summary"],
      ...sharedTags,
      ["twitter:creator", "@author"],
    ]);
  });
});

describe("X card validation", () => {
  const playerWith = (overrides: Partial<XPlayerCard>) => ({
    card: "player",
    site: "@example",
    player: { ...player, ...overrides },
  });
  const appWith = (overrides: Record<string, unknown>) => ({ card: "app", site: "@example", app: overrides });

  it.each([
    [playerWith({ url: "http://example.com/embed" }), /twitter\.player\.url must use https:/],
    [playerWith({ url: "/embed/launch" }), /twitter\.player\.url must be an absolute HTTPS URL/],
    [playerWith({ url: "" }), /twitter\.player\.url must be a non-empty HTTPS URL/],
    [playerWith({ url: "https://user:pw@example.com/e" }), /must not contain credentials/],
    [playerWith({ stream: "http://cdn.example.com/a.mp4" }), /twitter\.player\.stream must use https:/],
    [playerWith({ width: 0 }), /twitter\.player\.width must be an integer from 1 to 65535; received 0/],
    [playerWith({ height: 360.5 }), /twitter\.player\.height must be an integer/],
    [playerWith({ width: 65_536 }), /twitter\.player\.width must be an integer from 1 to 65535/],
    [{ card: "player", site: "@example" }, /card: "player" requires twitter\.player/],
    [{ card: "player", player }, /card: "player" requires twitter\.site or twitter\.siteId/],
    [{ ...playerWith({}), description: "x".repeat(201) }, /twitter\.description must be at most 200 characters/],
    [{ ...playerWith({}), description: " " }, /twitter\.description must be a non-empty string/],
    [{ card: "app", site: "@example" }, /card: "app" requires twitter\.app/],
    [{ card: "app", siteId: "1", app }, /card: "app" requires twitter\.site/],
    [appWith({}), /must list at least one of iphone, ipad, googleplay/],
    [appWith({ country: "GB" }), /must list at least one of iphone, ipad, googleplay/],
    [appWith({ iphone: { id: "" } }), /twitter\.app\.iphone\.id must be a non-empty string/],
    [appWith({ googleplay: { id: "   " } }), /twitter\.app\.googleplay\.id must be a non-empty string/],
    [appWith({ ipad: { id: "com.example.app" } }), /twitter\.app\.ipad\.id must be the numeric App Store ID/],
    [appWith({ ipad: { id: "1", name: "" } }), /twitter\.app\.ipad\.name must be a non-empty string/],
    [appWith({ iphone: { id: "1", url: "example" } }), /twitter\.app\.iphone\.url must be a URL with ":\/\/"/],
    [appWith({ android: { id: "1" } }), /twitter\.app\.android is not an X App Card platform/],
    [appWith({ ipad: { id: "1" }, country: "GBR" }), /twitter\.app\.country must be a two-letter country code/],
    [{ card: "summary", player }, /twitter\.player requires card: "player"; received card: summary/],
    [{ player }, /received card: summary_large_image/],
    [{ ...playerWith({}), app }, /twitter\.app requires card: "app"/],
    [{ card: "summary", description: "d" }, /twitter\.description requires card: "player" or "app"/],
  ])("rejects %j", (twitter, message) => {
    expect(() => metadataFor(twitter)).toThrow(message);
  });

  it("rejects a player image below X's 68,600-pixel floor", () => {
    expect(() => metadataFor(playerWith({}), { width: 262, height: 261 })).toThrow(
      /image is 262x261; X does not render a player card whose image has fewer than 68600 pixels/,
    );
  });

  it("applies the same rules to hand-authored socialMetaTags input", () => {
    const images = [{ url: "https://example.com/card.png" }];
    const input = (twitter: object) => ({ twitter: { images, site: "@example", ...twitter } }) as SocialMetaInput;

    expect(() => socialMetaTags(input({ card: "player" }))).toThrow(/requires twitter\.player/);
    expect(() => socialMetaTags(input({ card: "summary", app }))).toThrow(/requires card: "app"/);
    expect(() => socialMetaTags(input({ card: "player", player: { ...player, url: "http://x.test" } }))).toThrow(
      /must use https:/,
    );
    expect(() => socialMetaTags({ twitter: { card: "player", site: "@example", player } })).toThrow(
      /card: "player" requires twitter\.images/,
    );
    expect(twitterTags(socialMetaTags(input({ card: "app", app: { iphone: { id: "1" } } })))).toEqual([
      ["twitter:card", "app"],
      ["twitter:image", "https://example.com/card.png"],
      ["twitter:site", "@example"],
      ["twitter:app:id:iphone", "1"],
    ]);
  });
});

describe("nextTwitterMetadata", () => {
  it("passes summary cards through unchanged", () => {
    const metadata = metadataFor({ card: "summary", site: "@example", siteId: "1", creatorId: "2" });

    expect(nextTwitterMetadata(metadata.twitter)).toEqual(metadata.twitter);
  });

  it("maps a player card onto Next's players descriptor", () => {
    const metadata = metadataFor({ card: "player", site: "@example", description: "Launch day.", player });

    expect(nextTwitterMetadata(metadata.twitter)).toEqual({
      card: "player",
      images: metadata.twitter.images,
      site: "@example",
      description: "Launch day.",
      players: [
        {
          playerUrl: "https://example.com/embed/launch",
          streamUrl: "https://cdn.example.com/launch.mp4",
          width: 640,
          height: 360,
        },
      ],
    });
  });

  it("maps an app card onto Next's app descriptor and description", () => {
    const metadata = metadataFor({
      card: "app",
      site: "@example",
      description: "Launch tracking.",
      app: { iphone: app.iphone, googleplay: { id: "com.example.app", name: "Example" } },
    });

    expect(nextTwitterMetadata(metadata.twitter)).toEqual({
      card: "app",
      images: metadata.twitter.images,
      site: "@example",
      description: "Launch tracking.",
      app: {
        name: "Example",
        id: { iphone: "307234931", googleplay: "com.example.app" },
        url: { iphone: "example://launch" },
      },
    });
  });

  it("leaves out name and url when no listing supplies them", () => {
    const mapped = nextTwitterMetadata(metadataFor({ card: "app", site: "@example", app: { ipad: { id: "42" } } }).twitter);

    expect(mapped).toMatchObject({ app: { id: { ipad: "42" } } });
    expect(mapped).not.toHaveProperty("app.name");
    expect(mapped).not.toHaveProperty("app.url");
  });

  it.each([
    [{ player: { ...player, stream: undefined } }, /requires twitter\.player\.stream/],
    [{ app: { ...app, country: "GB" } }, /no twitter:app:country field/],
    [{ app: { iphone: { id: "1", name: "A" }, ipad: { id: "2", name: "B" } } }, /one twitter\.app name for every platform/],
    [{ app: { iphone: { id: "1", name: "A" }, ipad: { id: "2" } } }, /one twitter\.app name for every platform/],
  ])("refuses what Next cannot express: %j", (payload, message) => {
    const twitter = { card: "player" in payload ? "player" : "app", site: "@example", ...payload };

    expect(() => nextTwitterMetadata(metadataFor(twitter).twitter)).toThrow(message);
  });
});
