import { describe, expect, it } from "vitest";
import {
  socialImageMetadata,
  socialMetaHtml,
  socialMetaTags,
  type SocialMetaOptions,
  type SocialMetaTag,
} from "../src/index.js";
import { NEXT_OPEN_GRAPH_TYPES, nextPageMetadata, nextPageViewport } from "../src/next.js";
import { renderMetaTags } from "../src/meta-tags.js";

const keyOf = (tag: SocialMetaTag) => (tag.property !== undefined ? tag.property : tag.name);
const metadata = socialImageMetadata("/blog/launch", "Launch card", {
  origin: "https://example.com",
});
const baseline = socialMetaTags(metadata);

/** Only the tags `options` adds after the image and X Card tags. */
const pageOnly = (options: SocialMetaOptions) => socialMetaTags(metadata, options).slice(baseline.length);

const article: SocialMetaOptions = {
  title: "Launch notes",
  description: "What shipped.",
  url: "https://example.com/blog/launch",
  siteName: "Example",
  locale: "en_US",
  alternateLocales: ["fr_FR", "es_ES"],
  article: {
    publishedTime: "2026-11-01T09:30:00Z",
    modifiedTime: "2026-11-02T10:00:00.250+01:00",
    expirationTime: "2027-11-01",
    authors: ["https://example.com/authors/ada", "Grace Hopper"],
    section: "Releases",
    tags: ["metaplate", "open-graph"],
  },
  pubdate: "2026-11-01T09:30:00Z",
  themeColor: "#0b7285",
};

describe("page-level tags", () => {
  it("emits every page field in the documented order, after the image and X Card tags", () => {
    const tags = socialMetaTags(metadata, article);

    expect(tags.slice(0, baseline.length)).toEqual(baseline);
    expect(tags.slice(baseline.length)).toEqual([
      { property: "og:title", content: "Launch notes" },
      { property: "og:description", content: "What shipped." },
      { property: "og:url", content: "https://example.com/blog/launch" },
      { property: "og:site_name", content: "Example" },
      { property: "og:type", content: "article" },
      { property: "og:locale", content: "en_US" },
      { property: "og:locale:alternate", content: "fr_FR" },
      { property: "og:locale:alternate", content: "es_ES" },
      { property: "article:published_time", content: "2026-11-01T09:30:00Z" },
      { property: "article:modified_time", content: "2026-11-02T10:00:00.250+01:00" },
      { property: "article:expiration_time", content: "2027-11-01" },
      { property: "article:author", content: "https://example.com/authors/ada" },
      { property: "article:author", content: "Grace Hopper" },
      { property: "article:section", content: "Releases" },
      { property: "article:tag", content: "metaplate" },
      { property: "article:tag", content: "open-graph" },
      { property: "og:pubdate", content: "2026-11-01T09:30:00Z" },
      { name: "theme-color", content: "#0b7285" },
    ]);
  });

  it("leaves output unchanged when no new field is supplied", () => {
    const options = { title: "Home", url: "https://example.com/" };
    expect(keyOf(socialMetaTags(metadata, options).at(-1)!)).toBe("og:type");
    expect(
      socialMetaTags(metadata, {
        ...options,
        locale: "",
        alternateLocales: [],
        article: undefined,
        pubdate: "",
        themeColor: "",
      }),
    ).toEqual(socialMetaTags(metadata, options));
  });

  it("emits page fields without page-level defaults when only they are supplied", () => {
    expect(pageOnly({ themeColor: "#112233" })).toEqual([{ name: "theme-color", content: "#112233" }]);
    expect(pageOnly({ locale: "en_GB" })).toEqual([{ property: "og:locale", content: "en_GB" }]);
    expect(pageOnly({ pubdate: "2026-11-01T09:30:00-05:00" })).toEqual([
      { property: "og:pubdate", content: "2026-11-01T09:30:00-05:00" },
    ]);
  });

  describe("og:type", () => {
    it("defaults to article when an article field emits a tag", () => {
      expect(pageOnly({ article: { section: "News" } })).toEqual([
        { property: "og:type", content: "article" },
        { property: "article:section", content: "News" },
      ]);
      expect(pageOnly({ title: "Post", article: { tags: ["a"] } })[1]).toEqual({
        property: "og:type",
        content: "article",
      });
    });

    it("keeps the website default for an article without fields", () => {
      expect(pageOnly({ title: "Post", article: {} })).toEqual([
        { property: "og:title", content: "Post" },
        { property: "og:type", content: "website" },
      ]);
      expect(pageOnly({ article: { section: "", authors: [] } })).toEqual([]);
    });

    it("accepts an explicit article type", () => {
      expect(pageOnly({ type: "article", article: { section: "News" } })[0]).toEqual({
        property: "og:type",
        content: "article",
      });
    });

    it.each(["website", "profile", "video.other"])("rejects article fields with type %s", (type) => {
      expect(() => socialMetaTags(metadata, { type, article: { section: "News" } })).toThrow(
        /article fields belong to og:type article; received type: /,
      );
    });
  });

  describe("locales", () => {
    it.each(["en_US", "pt_BR", "fil_PH"])("accepts %s", (locale) => {
      expect(pageOnly({ locale })).toEqual([{ property: "og:locale", content: locale }]);
    });

    it("suggests the underscore form for a BCP 47 tag", () => {
      expect(() => socialMetaTags(metadata, { locale: "en-us" })).toThrow(/as in en_US/);
      expect(() => socialMetaTags(metadata, { alternateLocales: ["fr-FR"] })).toThrow(
        /alternateLocales\[0\].*as in fr_FR/,
      );
    });

    it.each(["EN_US", "en_us", "en", "en_USA", "english_US", "en_US ", "en_US\n"])(
      "rejects %j",
      (locale) => {
        expect(() => socialMetaTags(metadata, { locale })).toThrow(/language_TERRITORY/);
      },
    );

    it("rejects a repeated locale", () => {
      expect(() =>
        socialMetaTags(metadata, { locale: "en_US", alternateLocales: ["en_US"] }),
      ).toThrow(/more than once or repeats locale/);
      expect(() => socialMetaTags(metadata, { alternateLocales: ["fr_FR", "fr_FR"] })).toThrow(
        /more than once/,
      );
    });
  });

  describe("dates", () => {
    const published = (publishedTime: SocialMetaOptions["pubdate"]) =>
      pageOnly({ article: { publishedTime } })[1]?.content;

    it.each([
      "2026-11-01",
      "2024-02-29",
      "2000-02-29",
      "0001-01-01",
      "2026-11-01T00:00:00Z",
      "2026-11-01T23:59:59Z",
      "2026-11-01T09:30:00.123456Z",
      "2026-11-01T09:30:00+05:30",
      "2026-11-01T09:30:00-00:00",
      "2026-12-31T09:30:00+23:59",
    ])("accepts %s as written", (value) => {
      expect(published(value)).toBe(value);
    });

    it.each([
      "2026-02-29",
      "1900-02-29",
      "2026-04-31",
      "2026-13-01",
      "2026-00-10",
      "2026-11-00",
      "2026-11-01T24:00:00Z",
      "2026-11-01T09:60:00Z",
      "2026-11-01T09:30:60Z",
      "2026-11-01T09:30:00+24:00",
      "2026-11-01T09:30:00+05:60",
      "2026-11-01T09:30Z",
      "2026-11-01T09:30:00",
      "2026-11-01 09:30:00Z",
      "2026-11-01t09:30:00z",
      "2026-11-01T09:30:00+0530",
      "26-11-01",
      "2026-1-1",
      "November 1, 2026",
      "2026-11-01T09:30:00Z\n",
    ])("rejects %j", (value) => {
      expect(() => published(value)).toThrow(/article\.publishedTime must be a date such as/);
    });

    it("serializes a Date with toISOString", () => {
      const date = new Date(Date.UTC(2026, 10, 1, 9, 30));
      expect(published(date)).toBe("2026-11-01T09:30:00.000Z");
      expect(pageOnly({ pubdate: date })).toEqual([
        { property: "og:pubdate", content: "2026-11-01T09:30:00.000Z" },
      ]);
    });

    it("rejects an invalid Date or one outside four-digit years", () => {
      expect(() => published(new Date(Number.NaN))).toThrow(/must be a valid Date/);
      expect(() => published(new Date(Date.UTC(10_000, 0, 1)))).toThrow(/years 0000 to 9999/);
    });

    it("requires a time and offset for og:pubdate, as Discord documents", () => {
      expect(() => socialMetaTags(metadata, { pubdate: "2026-11-01" })).toThrow(
        /pubdate must be a full RFC 3339 date-time with seconds and an offset/,
      );
      expect(() => socialMetaTags(metadata, { pubdate: "2026-11-01T09:30:00" })).toThrow(
        /pubdate must be a full RFC 3339/,
      );
    });

    it("rejects a non-string value from untyped callers", () => {
      expect(() =>
        socialMetaTags(metadata, { article: { modifiedTime: 1_700_000_000 as unknown as string } }),
      ).toThrow(/article\.modifiedTime must be a string or a Date/);
    });
  });

  describe("article text fields", () => {
    it.each([
      [{ authors: [""] }, /article\.authors\[0\] must be a non-empty string/],
      [{ authors: ["Ada", "  "] }, /article\.authors\[1\]/],
      [{ tags: ["\t"] }, /article\.tags\[0\]/],
      [{ section: " " }, /article\.section must be a non-empty string/],
    ])("rejects an empty entry in %j", (fields, message) => {
      expect(() => socialMetaTags(metadata, { article: fields })).toThrow(message);
    });
  });

  describe("theme-color", () => {
    it.each(["#0b7285", "#0B7285", "#0b728580", "#FFFFFFFF"])("accepts %s", (themeColor) => {
      expect(pageOnly({ themeColor })).toEqual([{ name: "theme-color", content: themeColor }]);
    });

    it.each(["#fff", "#ffff", "#0b72851", "0b7285", "red", "rgb(11 114 133)", "#0b7285 ", "#gggggg"])(
      "rejects %j",
      (themeColor) => {
        expect(() => socialMetaTags(metadata, { themeColor })).toThrow(
          /themeColor must be a #RRGGBB or #RRGGBBAA hex color/,
        );
      },
    );
  });

  it("validates the canonical url even when nothing else is emitted", () => {
    expect(() => socialMetaTags({}, { url: "ftp://example.com/" })).toThrow(/absolute http\(s\) URL/);
  });
});

describe("socialMetaHtml with page-level tags", () => {
  it("renders theme-color with name and article tags with property", () => {
    const html = socialMetaHtml({}, article);

    expect(html.split("\n").slice(-4)).toEqual([
      '<meta property="article:tag" content="metaplate">',
      '<meta property="article:tag" content="open-graph">',
      '<meta property="og:pubdate" content="2026-11-01T09:30:00Z">',
      '<meta name="theme-color" content="#0b7285">',
    ]);
    expect(html).toContain('<meta property="og:locale:alternate" content="fr_FR">');
    expect(html).toContain('<meta property="article:published_time" content="2026-11-01T09:30:00Z">');
  });

  it("escapes article text", () => {
    const html = socialMetaHtml({}, { article: { section: `"News" & <Views>`, tags: ["it's"] } });

    expect(html).toContain('<meta property="article:section" content="&quot;News&quot; &amp; &lt;Views&gt;">');
    expect(html).toContain('<meta property="article:tag" content="it&#39;s">');
  });

  it("renders the theme-color and article keys and nothing like them", () => {
    expect(renderMetaTags([{ name: "theme-color", content: "#000000" }])).toBe(
      '<meta name="theme-color" content="#000000">',
    );
    expect(renderMetaTags([{ property: "article:published_time", content: "2026-11-01" }])).toBe(
      '<meta property="article:published_time" content="2026-11-01">',
    );
    const hostile = [
      { name: "theme-colour", content: "x" },
      { name: "Theme-Color", content: "x" },
      { name: "theme-color:dark", content: "x" },
      { name: " theme-color", content: "x" },
      { name: "theme-color\" media=\"x", content: "x" },
      { property: "article", content: "x" },
      { property: "article:", content: "x" },
      { property: "profile:username", content: "x" },
      { name: "description", content: "x" },
    ] as SocialMetaTag[];
    for (const tag of hostile) {
      expect(() => renderMetaTags([tag])).toThrow(/unrecognized meta tag key/);
    }
  });
});

describe("nextPageMetadata", () => {
  it("maps page fields onto Next's openGraph names and og:pubdate onto other", () => {
    expect(nextPageMetadata(article)).toEqual({
      openGraph: {
        title: "Launch notes",
        description: "What shipped.",
        url: "https://example.com/blog/launch",
        siteName: "Example",
        type: "article",
        locale: "en_US",
        alternateLocale: ["fr_FR", "es_ES"],
        publishedTime: "2026-11-01T09:30:00Z",
        modifiedTime: "2026-11-02T10:00:00.250+01:00",
        expirationTime: "2027-11-01",
        authors: ["https://example.com/authors/ada", "Grace Hopper"],
        section: "Releases",
        tags: ["metaplate", "open-graph"],
      },
      other: { "og:pubdate": "2026-11-01T09:30:00Z" },
    });
  });

  it("applies the same og:type default as socialMetaTags", () => {
    expect(nextPageMetadata({ title: "Home" })).toEqual({ openGraph: { title: "Home", type: "website" } });
    expect(nextPageMetadata({ siteName: "Example" })).toEqual({ openGraph: { siteName: "Example" } });
  });

  it("omits openGraph when no field is set, so a layout's openGraph survives a spread", () => {
    expect(nextPageMetadata({})).toEqual({});
    expect(nextPageMetadata({ themeColor: "#000000" })).toEqual({});
  });

  it("serializes Date fields like socialMetaTags", () => {
    const date = new Date(Date.UTC(2026, 10, 1));
    expect(nextPageMetadata({ article: { publishedTime: date }, pubdate: date })).toEqual({
      openGraph: { type: "article", publishedTime: "2026-11-01T00:00:00.000Z" },
      other: { "og:pubdate": "2026-11-01T00:00:00.000Z" },
    });
  });

  it("refuses an og:type Next cannot render", () => {
    expect(() => nextPageMetadata({ type: "product" })).toThrow(
      /Next\.js renders og:type only for website, article,.*received product/,
    );
    for (const type of NEXT_OPEN_GRAPH_TYPES) {
      expect(nextPageMetadata({ type }).openGraph).toEqual({ type });
    }
  });

  it("validates with the socialMetaTags rules", () => {
    expect(() => nextPageMetadata({ locale: "en-US" })).toThrow(/as in en_US/);
    expect(() => nextPageMetadata({ url: "/relative" })).toThrow(/absolute http\(s\) URL/);
    expect(() => nextPageMetadata({ themeColor: "red" })).toThrow(/themeColor/);
  });
});

describe("nextPageViewport", () => {
  it("returns themeColor for Next's viewport export", () => {
    expect(nextPageViewport(article)).toEqual({ themeColor: "#0b7285" });
    expect(nextPageViewport({ title: "No color" })).toEqual({});
  });

  it("rejects colors Discord cannot read", () => {
    expect(() => nextPageViewport({ themeColor: "black" })).toThrow(/#RRGGBB or #RRGGBBAA/);
  });
});
