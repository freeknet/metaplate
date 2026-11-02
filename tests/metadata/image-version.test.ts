import { describe, expect, it } from "vitest";
import {
  IMAGE_VERSION_PARAMETER,
  socialImage,
  socialImageAdaptiveCard,
  socialImageJsonLd,
  socialImageMetadata,
  socialImagePath,
  socialImageVersion,
  socialMetaTags,
} from "../../src/index.js";
import { fnv1a32, stableSerialize, versionedImageUrl } from "../../src/metadata/image-version.js";

const encode = (text: string) => new TextEncoder().encode(text);

describe("fnv1a32", () => {
  // Reference vectors from the FNV specification (draft-eastlake-fnv).
  it.each([
    ["", "811c9dc5"],
    ["a", "e40c292c"],
    ["foobar", "bf9cf968"],
  ])("hashes %j to %s", (input, expected) => {
    expect(fnv1a32(encode(input))).toBe(expected);
  });
});

describe("stableSerialize", () => {
  it("ignores property order and omits undefined members, as JSON does", () => {
    expect(stableSerialize({ b: 1, a: { d: [1, "x"], c: true }, z: undefined })).toBe(
      '{"a":{"c":true,"d":[1,"x"]},"b":1}',
    );
    expect(stableSerialize({ a: 1, b: 2 })).toBe(stableSerialize({ b: 2, a: 1 }));
  });

  it("matches JSON.stringify for plain JSON data", () => {
    const copy = { title: "Ünïcode ✓ \"quoted\"", tags: ["a", null, 3.5, false], nested: { empty: {} } };
    expect(stableSerialize(copy)).toBe(
      JSON.stringify({ nested: { empty: {} }, tags: ["a", null, 3.5, false], title: copy.title }),
    );
    expect(stableSerialize([undefined])).toBe("[null]");
  });

  it("honors toJSON and accepts null-prototype objects and shared references", () => {
    const shared = { name: "shared" };
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { k: "v" });
    expect(stableSerialize({ when: new Date(0), one: shared, two: shared, bare })).toBe(
      '{"bare":{"k":"v"},"one":{"name":"shared"},"two":{"name":"shared"},"when":"1970-01-01T00:00:00.000Z"}',
    );
  });

  it.each([
    [{ title: () => "x" }, "copy.title is a function"],
    [{ id: Symbol("x") }, "copy.id is a symbol"],
    [{ n: 1n }, "copy.n is a bigint"],
    [{ n: Number.NaN }, "copy.n is NaN"],
    [{ list: [Number.POSITIVE_INFINITY] }, "copy.list[0] is Infinity"],
    [{ tags: new Set(["a"]) }, "copy.tags is a Set"],
    [{ map: new Map() }, "copy.map is a Map"],
    [{ instance: new (class Card {})() }, "copy.instance is a Card"],
  ])("refuses %o, which has no stable serialization", (value, message) => {
    expect(() => stableSerialize(value)).toThrow(message);
  });

  it("refuses circular references", () => {
    const copy: Record<string, unknown> = { title: "Loop" };
    copy.self = copy;
    expect(() => stableSerialize(copy)).toThrow("copy.self is a circular reference");
  });
});

describe("socialImageVersion", () => {
  const copy = { title: "Launch", alt: "Launch card" };

  it("is eight hex digits, stable across property order, and pinned across releases", () => {
    const version = socialImageVersion(copy);
    expect(version).toMatch(/^[0-9a-f]{8}$/);
    expect(socialImageVersion({ alt: "Launch card", title: "Launch" })).toBe(version);
    // Pinned: a change here re-versions every published card, so it must be deliberate.
    expect(version).toBe(fnv1a32(encode('[null,{"alt":"Launch card","title":"Launch"}]')));
    expect(socialImageVersion(copy, "2")).toBe(fnv1a32(encode('["2",{"alt":"Launch card","title":"Launch"}]')));
  });

  it("changes when the copy or the revision changes", () => {
    const versions = new Set([
      socialImageVersion(copy),
      socialImageVersion({ ...copy, title: "Launch!" }),
      socialImageVersion(copy, "1"),
      socialImageVersion(copy, "2"),
    ]);
    expect(versions.size).toBe(4);
  });

  it("rejects an empty or non-string revision", () => {
    expect(() => socialImageVersion(copy, "")).toThrow("Invalid revision");
    expect(() => socialImageVersion(copy, 2 as unknown as string)).toThrow("Invalid revision");
  });
});

describe("versioned image URLs", () => {
  const variants = { square: { size: { width: 1080, height: 1080 } } };

  it("names the parameter v and leaves unversioned URLs unchanged", () => {
    expect(IMAGE_VERSION_PARAMETER).toBe("v");
    expect(versionedImageUrl("/og.png", undefined)).toBe("/og.png");
    expect(versionedImageUrl("/og.png", "3")).toBe("/og.png?v=3");
  });

  it("appends one v parameter to every generated Open Graph and X Card URL", () => {
    const metadata = socialImageMetadata("/blog/launch", "Launch card", {
      origin: "https://example.com",
      basePath: "/site",
      imagePath: "og-image.png",
      variants,
      version: "a1b2c3d4",
      twitter: { variant: "square" },
    });
    expect(metadata.openGraph.images.map(({ url }) => url)).toEqual([
      "https://example.com/site/blog/launch/og-image.png?v=a1b2c3d4",
      "https://example.com/site/blog/launch/og-image-square.png?v=a1b2c3d4",
    ]);
    expect(metadata.twitter.images[0]!.url).toBe("https://example.com/site/blog/launch/og-image-square.png?v=a1b2c3d4");
    expect(new URL(metadata.openGraph.images[0]!.url).searchParams.getAll("v")).toEqual(["a1b2c3d4"]);
  });

  it("versions relative URLs and socialImage, but never socialImagePath", () => {
    expect(socialImage("/docs", "Docs", { version: "2" }).url).toBe("/docs/og-image?v=2");
    expect(socialImageMetadata("/docs", "Docs", { version: "2" }).twitter.images[0]!.url).toBe("/docs/og-image?v=2");
    expect(socialImagePath("/docs")).toBe("/docs/og-image");
  });

  it("emits caller-supplied descriptors exactly as given", () => {
    const landscape = { url: "https://cdn.example.com/a.png", width: 1200, height: 630, alt: "A" };
    const xCard = { url: "https://cdn.example.com/x.png", width: 1200, height: 630, alt: "X" };
    const metadata = socialImageMetadata("/", "Card", {
      version: "7",
      openGraph: { images: [landscape] },
      twitter: { image: xCard },
    });
    expect(metadata.openGraph.images[0]!.url).toBe(landscape.url);
    expect(metadata.twitter.images[0]!.url).toBe(xCard.url);
  });

  it.each(["", "a b", "a&b=c", "1#top", "%20", "é", "x".repeat(65)])(
    "rejects the version token %j",
    (version) => {
      expect(() => socialImageMetadata("/", "Card", { version })).toThrow("Invalid version");
    },
  );

  it("accepts every unreserved character", () => {
    expect(socialImage("/", "Card", { version: "Az09._~-" }).url).toBe("/og-image?v=Az09._~-");
  });

  it("still rejects a query or fragment the caller writes into a path", () => {
    for (const options of [{ imagePath: "og.png?v=2" }, { basePath: "/site?v=2" }, { imagePath: "og.png#v" }]) {
      expect(() => socialImageMetadata("/", "Card", { ...options, version: "2" })).toThrow(
        "must be a pathname without a query or fragment",
      );
    }
    expect(() => socialImageMetadata("/?v=2", "Card")).toThrow("route must be a pathname");
  });

  it("carries the token through meta tags, JSON-LD, and Adaptive Cards", () => {
    const social = socialImageMetadata("/launch", "Launch card", {
      imagePath: "og-image.png",
      size: { width: 1024, height: 536 },
      version: "9f",
    });
    const page = "https://example.com/launch";

    const tags = socialMetaTags(social, { url: page });
    expect(tags).toContainEqual({ property: "og:image", content: "https://example.com/launch/og-image.png?v=9f" });
    expect(tags).toContainEqual({ name: "twitter:image", content: "https://example.com/launch/og-image.png?v=9f" });

    expect(socialImageJsonLd(social, { url: page })).toMatchObject({
      contentUrl: "https://example.com/launch/og-image.png?v=9f",
      url: "https://example.com/launch/og-image.png?v=9f",
    });

    // The Teams format check reads the path's extension, not the query.
    const card = socialImageAdaptiveCard(social, { url: page, title: "Launch" });
    expect(JSON.stringify(card)).toContain("https://example.com/launch/og-image.png?v=9f");
  });
});
