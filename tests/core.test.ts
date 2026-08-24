import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_DIMENSION,
  OG_SIZE,
  socialImage,
  socialImageMetadata,
  socialImagePath,
} from "../src/index.js";

describe("socialImagePath", () => {
  it.each([
    ["/", "/og-image"],
    ["", "/og-image"],
    ["//", "/og-image"],
    ["roadmap", "/roadmap/og-image"],
    ["/learn/borrowing/", "/learn/borrowing/og-image"],
    ["/method//", "/method/og-image"],
  ])("maps %s to %s", (route, expected) => {
    expect(socialImagePath(route)).toBe(expected);
  });

  it("supports a custom stable path", () => {
    expect(socialImagePath("/docs", "/social/card")).toBe("/docs/social/card");
  });

  it("prefixes routes with a deployment base path", () => {
    expect(socialImagePath("/docs", "og-image.png", "/project/")).toBe(
      "/project/docs/og-image.png",
    );
  });

  it("rejects an empty image path", () => {
    expect(() => socialImagePath("/docs", "///")).toThrow(/imagePath/);
  });

  it.each([
    ["/docs?lang=en", "?", undefined, undefined],
    ["/docs#api", "#", undefined, undefined],
    ["/docs/../admin", "..", undefined, undefined],
    ["/docs/./learn", ".", undefined, undefined],
  ])("rejects query, fragment, and dot segments in %s", (route, needle) => {
    expect(() => socialImagePath(route)).toThrow(
      new RegExp(needle!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  it.each([
    "/docs/%2e%2e/admin",
    "/docs/%2E%2E/admin",
    "/docs/.%2e/admin",
    "/docs/%2e./admin",
    "/%2e",
    "/%2e%2e",
    "/docs/./admin/",
    "/docs/../admin",
  ])("rejects percent-encoded dot segments in %s", (route) => {
    // WHATWG URL parsing treats the decoded forms as dot segments, so without
    // this an origin would normalize `/docs/%2e%2e/admin` into `/admin`.
    expect(() => socialImagePath(route, "og.png", "", "https://example.com")).toThrow(
      /dot segments|\.\./,
    );
  });

  // A percent-encoded literal that decodes to a normal name, never to `.` or
  // `..`, must pass; validation rejects dot segments, it does not re-encode.
  it("tolerates a percent-encoded literal character that is not a dot segment", () => {
    expect(() => socialImagePath("/docs/%66aq")).not.toThrow();
    expect(socialImagePath("/docs/%66aq")).toBe("/docs/%66aq/og-image");
  });

  it("rejects a dot segment even when another segment has a malformed escape", () => {
    // A single malformed escape must not disable dot detection for the rest of
    // the path: WHATWG parses `%ZZ` leniently and still normalizes `%2e%2e`.
    expect(() =>
      socialImagePath("/docs/%ZZ/%2e%2e/admin", "og-image", "", "https://example.com"),
    ).toThrow(/dot segments|\.\./);
    expect(() => socialImagePath("/%ZZ/%2e", "og-image", "", "https://example.com")).toThrow(
      /dot segments|\.\./,
    );
  });

  it("tolerates a malformed escape that is not a dot segment", () => {
    expect(() => socialImagePath("/docs/%ZZ/learn")).not.toThrow();
    expect(socialImagePath("/docs/%ZZ/learn")).toBe("/docs/%ZZ/learn/og-image");
  });

  it.each(["/docs\\admin", "\\docs", "docs\\..\\admin"])(
    "rejects backslashes as path separators in %s",
    (route) => {
      expect(() => socialImagePath(route)).toThrow(/backslash/);
    },
  );

  it.each([
    "/docs/.\n./admin",
    "/docs/.\t./admin",
    "/docs/.\r./admin",
    "/docs/..\n/admin",
  ])("rejects URL-stripped tab and newline characters in %s", (route) => {
    // WHATWG URL parsing strips ASCII tab and newline before normalizing, so
    // `.\n.` becomes `..` once `new URL()` runs — the same traversal class
    // #57 exists to prevent.
    expect(() => socialImagePath(route, "og.png", "", "https://example.com")).toThrow(
      /tab or newline/,
    );
  });

  it("rejects query and fragment in basePath and imagePath", () => {
    expect(() => socialImagePath("/docs", "og.png", "/proj?x=1")).toThrow(/basePath/);
    expect(() => socialImagePath("/docs", "og?x=1", "/proj")).toThrow(/imagePath/);
    expect(() => socialImagePath("/docs", "og#x", "/proj")).toThrow(/imagePath/);
  });

  it("handles long slash-delimited input in linear time", () => {
    const padding = "/".repeat(100_000);
    expect(socialImagePath(`${padding}docs${padding}`, `${padding}card${padding}`)).toBe(
      "/docs/card",
    );
  });
});

it("builds a standard image descriptor", () => {
  expect(socialImage("/roadmap", "Roadmap card")).toEqual({
    url: "/roadmap/og-image",
    width: OG_SIZE.width,
    height: OG_SIZE.height,
    alt: "Roadmap card",
  });
});

it("builds a descriptor for a subpath deployment", () => {
  expect(
    socialImage("/guides", "Guides card", {
      basePath: "/project",
      imagePath: "og-image.png",
    }).url,
  ).toBe("/project/guides/og-image.png");
});

it("carries the declared media type when one is given", () => {
  expect(
    socialImage("/roadmap", "Roadmap card", { type: "image/jpeg" }).type,
  ).toBe("image/jpeg");
  expect(
    socialImageMetadata("/roadmap", "Roadmap card").openGraph.images[0]?.type,
  ).toBeUndefined();
});

describe("origin", () => {
  it("keeps relative paths by default", () => {
    expect(socialImagePath("/docs", "og.png", "/project")).toBe("/project/docs/og.png");
  });

  it("produces absolute URLs from an origin", () => {
    expect(
      socialImageMetadata("/docs", "Docs", {
        origin: "https://example.com",
        basePath: "/project",
        imagePath: "og.jpg",
      }).openGraph.images[0]?.url,
    ).toBe("https://example.com/project/docs/og.jpg");
  });

  it("tolerates an origin with a trailing slash", () => {
    expect(
      socialImage("/", "Home", { origin: "https://example.com/", imagePath: "og.png" }).url,
    ).toBe("https://example.com/og.png");
  });

  it.each(["ftp://example.com", "not-a-url", "https://example.com/base", "https://example.com?a=1"])(
    "rejects origin %s",
    (origin) => {
      expect(() => socialImage("/", "Home", { origin })).toThrow(/origin/i);
    },
  );

  it.each([
    "https://user:pass@example.com",
    "https://user@example.com",
    "https://:pass@example.com",
  ])("rejects an origin carrying credentials %s", (origin) => {
    // Metadata URLs must not leak userinfo into crawler-facing tags.
    expect(() => socialImage("/", "Home", { origin })).toThrow(/credentials/);
  });
});

it("reuses one descriptor for Open Graph and Twitter metadata", () => {
  const metadata = socialImageMetadata("/", "Home card");
  expect(metadata.twitter.card).toBe("summary_large_image");
  expect(metadata.twitter.images[0]).toEqual(metadata.openGraph.images[0]);
});

it("supports ordered Open Graph images and independent Twitter settings", () => {
  const landscape = {
    url: "https://example.com/landscape.png",
    width: 1200,
    height: 630,
    alt: "Landscape card",
    type: "image/png",
  };
  const square = {
    url: "https://example.com/square.jpg",
    width: 1080,
    height: 1080,
    alt: "Square card",
    type: "image/jpeg",
  };
  const twitter = {
    url: "https://example.com/x.png",
    width: 1200,
    height: 630,
    alt: "X card",
    type: "image/png",
  };

  const metadata = socialImageMetadata("/", "Default", {
    openGraph: { images: [landscape, square] },
    twitter: {
      card: "summary",
      image: twitter,
      site: "@example",
      siteId: "123",
      creator: "@author",
      creatorId: "456",
    },
  });

  expect(metadata.openGraph.images).toEqual([landscape, square]);
  expect(metadata.twitter).toEqual({
    card: "summary",
    images: [twitter],
    site: "@example",
    siteId: "123",
    creator: "@author",
    creatorId: "456",
  });
});

it("copies channel overrides so source mutation cannot desynchronize them", () => {
  const source = {
    url: "https://example.com/card.png",
    width: 1200,
    height: 630,
    alt: "Original",
    type: "image/png",
  };
  const metadata = socialImageMetadata("/", "Default", {
    openGraph: { images: [source] },
    twitter: { image: source },
  });

  source.alt = "Mutated";
  expect(metadata.openGraph.images[0]?.alt).toBe("Original");
  expect(metadata.twitter.images[0]?.alt).toBe("Original");
  expect(metadata.openGraph.images[0]).not.toBe(metadata.twitter.images[0]);
});

it("rejects invalid channel image overrides", () => {
  expect(() =>
    socialImageMetadata("/", "Default", { openGraph: { images: [] } }),
  ).toThrow(/Open Graph images must not be empty/);
  expect(() =>
    socialImageMetadata("/", "Default", {
      twitter: { image: { url: "", alt: "card", width: 1200, height: 630 } },
    }),
  ).toThrow(/Twitter image URL/);
});

describe("size validation", () => {
  it.each([
    { width: 0, height: 630 },
    { width: -1200, height: 630 },
    { width: 1200.5, height: 630 },
    { width: Number.NaN, height: 630 },
    { width: Number.POSITIVE_INFINITY, height: 630 },
    { width: 1200, height: Number.NEGATIVE_INFINITY },
    { width: MAX_IMAGE_DIMENSION + 1, height: 630 },
  ])("rejects invalid size %j", (size) => {
    expect(() => socialImage("/", "Card", { size })).toThrow(/Invalid size: (width|height)/);
    expect(() => socialImageMetadata("/", "Card", { size })).toThrow(/Invalid size/);
  });

  it("accepts the largest supported size", () => {
    expect(
      socialImage("/", "Card", {
        size: { width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION },
      }).width,
    ).toBe(MAX_IMAGE_DIMENSION);
  });
});
