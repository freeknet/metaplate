import { describe, expect, it } from "vitest";
import {
  ADAPTIVE_CARD_SCHEMA,
  ADAPTIVE_CARD_VERSION,
  socialImageAdaptiveCard,
  socialImageCompatibility,
  socialImageMetadata,
  type SocialImageAdaptiveCardInput,
  type SocialMetaImageInput,
} from "../src/index.js";

const page = {
  title: "Release notes",
  description: "What changed in the latest release.",
  url: "https://example.com/blog/release-notes",
};

// The default 1200x630 card exceeds Teams' 1024x1024 card-image limit, so a
// Teams-sized variant is declared; the builder selects the first image that fits.
const metadata = socialImageMetadata("/blog/release-notes", "Release notes card", {
  type: "image/png",
  variants: { teams: { size: { width: 1024, height: 536 } } },
});

const only = (image: SocialMetaImageInput): SocialImageAdaptiveCardInput => ({
  openGraph: { images: [image] },
});
const small = { url: "https://cdn.example.com/card.png", width: 800, height: 418, alt: "Card" };

describe("socialImageAdaptiveCard", () => {
  it("builds a Teams Adaptive Card at the highest documented version", () => {
    const card = socialImageAdaptiveCard(metadata, page);

    expect(card.$schema).toBe(ADAPTIVE_CARD_SCHEMA);
    expect(card.$schema).toBe("https://adaptivecards.io/schemas/adaptive-card.json");
    expect(card.type).toBe("AdaptiveCard");
    expect(card.version).toBe("1.6");
    expect(ADAPTIVE_CARD_VERSION).toBe("1.6");
    expect(card.body.map(({ type }) => type)).toEqual(["Image", "TextBlock", "TextBlock"]);
    expect(card.actions).toEqual([
      { type: "Action.OpenUrl", title: "Open", url: "https://example.com/blog/release-notes" },
    ]);
  });

  it("maps alt text to altText and the title to a bold TextBlock", () => {
    const [image, title, description] = socialImageAdaptiveCard(metadata, page).body;

    expect(image).toEqual({
      type: "Image",
      url: "https://example.com/blog/release-notes/og-image-teams",
      altText: "Release notes card",
      size: "stretch",
    });
    expect(title).toMatchObject({ text: "Release notes", weight: "bolder", wrap: true });
    expect(description).toMatchObject({ text: page.description, isSubtle: true });
  });

  it("omits the description block and keeps optional fields out of the JSON", () => {
    const card = socialImageAdaptiveCard(only(small), { title: "Card", url: page.url });

    expect(card.body).toHaveLength(2);
    expect(JSON.stringify(card)).not.toMatch(/undefined|isSubtle|fallbackText/);
    expect(socialImageAdaptiveCard(only(small), { ...page, description: "" }).body).toHaveLength(2);
  });

  it("accepts a version and action title override", () => {
    const card = socialImageAdaptiveCard(only(small), {
      ...page,
      version: "1.3",
      actionTitle: "Read the notes",
    });

    expect(card.version).toBe("1.3");
    expect(card.actions[0].title).toBe("Read the notes");
    expect(() =>
      socialImageAdaptiveCard(only(small), { ...page, version: "1.7" as "1.6" }),
    ).toThrow(/version must be one of/);
  });

  it("requires HTTPS, credential-free image URLs", () => {
    expect(() =>
      socialImageAdaptiveCard(only({ ...small, url: "http://cdn.example.com/card.png" }), page),
    ).toThrow(/require an HTTPS URL/);
    expect(() =>
      socialImageAdaptiveCard(only({ ...small, url: "/card.png" }), { ...page, url: "http://example.com/" }),
    ).toThrow(/require an HTTPS URL/);
    expect(() =>
      socialImageAdaptiveCard(only({ ...small, url: "https://u:p@cdn.example.com/c.png" }), page),
    ).toThrow(/credentials/);
    expect(() => socialImageAdaptiveCard(only(small), { ...page, url: "/relative" })).toThrow(
      /absolute http\(s\) URL/,
    );
  });

  it("enforces Teams' image format, dimension, and file-size limits", () => {
    expect(() =>
      socialImageAdaptiveCard(only({ ...small, type: "image/webp" }), page),
    ).toThrow(/PNG, JPEG, or GIF/);
    expect(() =>
      socialImageAdaptiveCard(only({ ...small, url: "https://cdn.example.com/card.svg" }), page),
    ).toThrow(/PNG, JPEG, or GIF/);
    expect(() =>
      socialImageAdaptiveCard(socialImageMetadata("/docs", "Docs card"), page),
    ).toThrow(/at most 1024x1024/);
    expect(() => socialImageAdaptiveCard(only(small), { ...page, fileSize: 1_000_000 })).toThrow(
      /smaller than 1 MB/,
    );
    expect(socialImageAdaptiveCard(only(small), { ...page, fileSize: 999_999 }).version).toBe("1.6");
  });

  it("rejects missing images, alt text, titles, and oversized cards", () => {
    expect(() => socialImageAdaptiveCard({}, page)).toThrow(/at least one Open Graph image/);
    expect(() => socialImageAdaptiveCard(only({ ...small, alt: "" }), page)).toThrow(/alt text/);
    expect(() => socialImageAdaptiveCard(only(small), { ...page, title: " " })).toThrow(/title/);
    expect(() =>
      socialImageAdaptiveCard(only(small), { ...page, description: "x".repeat(28_000) }),
    ).toThrow(/limited to 28 KB/);
  });

  it("serializes to stable JSON", () => {
    expect(JSON.stringify(socialImageAdaptiveCard(metadata, page), null, 2)).toMatchInlineSnapshot(`
      "{
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
          {
            "type": "TextBlock",
            "text": "Release notes",
            "wrap": true,
            "size": "medium",
            "weight": "bolder"
          },
          {
            "type": "TextBlock",
            "text": "What changed in the latest release.",
            "wrap": true,
            "isSubtle": true
          }
        ],
        "actions": [
          {
            "type": "Action.OpenUrl",
            "title": "Open",
            "url": "https://example.com/blog/release-notes"
          }
        ]
      }"
    `);
  });
});

describe("teams compatibility profile", () => {
  it("requires a crawler-ready URL and a documented card image format", () => {
    const report = socialImageCompatibility(
      { ...small, url: "http://cdn.example.com/card.webp", type: "image/webp" },
      { targets: ["teams"] },
    );

    expect(report.compatible).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual(["url", "format"]);
    expect(socialImageCompatibility({ ...small, type: "image/gif" }, { targets: ["teams"] })).toEqual({
      compatible: true,
      issues: [],
    });
  });
});
