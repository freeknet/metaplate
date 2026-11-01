import { describe, expect, it } from "vitest";
import {
  socialImageMetadata,
  socialMetaHtml,
  socialMetaTags,
  type SocialImageDescriptor,
  type SocialMetaInput,
  type SocialMetaTag,
} from "../src/index.js";
import { escapeAttribute, renderMetaTags } from "../src/meta-tags.js";

const landscape: SocialImageDescriptor = {
  url: "https://cdn.example.com/landscape.png",
  width: 1200,
  height: 630,
  type: "image/png",
  alt: "Landscape card",
};
const square: SocialImageDescriptor = {
  url: "https://cdn.example.com/square.png",
  width: 600,
  height: 600,
  alt: "Square card",
};

const keyOf = (tag: SocialMetaTag) => (tag.property !== undefined ? tag.property : tag.name);
const keys = (tags: SocialMetaTag[]) => tags.map(keyOf);

/** Strict parse of one emitted line: two attributes, escaped content only. */
const META_LINE =
  /^([ \t]*)<meta (property|name)="([a-z_:]+)" content="((?:[^"'<>&\r\n]|&(?:amp|lt|gt|quot|#39|#10|#13);)*)">$/;
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#10;": "\n",
  "&#13;": "\r",
};

function parseHtml(html: string, indent = ""): SocialMetaTag[] {
  if (html === "") return [];
  return html.split("\n").map((line) => {
    const match = META_LINE.exec(line);
    if (!match) throw new Error(`Unexpected line: ${line}`);
    const [, prefix, attribute, key, raw] = match as unknown as [string, string, string, string, string];
    expect(prefix).toBe(indent);
    const content = raw.replace(/&(?:amp|lt|gt|quot|#39|#10|#13);/g, (entity) => ENTITIES[entity]!);
    return attribute === "property" ? { property: key, content } : { name: key, content };
  });
}

describe("socialMetaTags", () => {
  it("emits the default metadata in the documented order", () => {
    const metadata = socialImageMetadata("/docs", "Docs card", {
      origin: "https://example.com",
      type: "image/png",
    });

    expect(socialMetaTags(metadata)).toEqual([
      { property: "og:image", content: "https://example.com/docs/og-image" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:type", content: "image/png" },
      { property: "og:image:alt", content: "Docs card" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: "https://example.com/docs/og-image" },
      { name: "twitter:image:alt", content: "Docs card" },
    ]);
  });

  it("places page-level fields after the image and X Card tags", () => {
    const tags = socialMetaTags(socialImageMetadata("/", "Home card"), {
      title: "Home",
      description: "The home page",
      url: "https://example.com/",
      siteName: "Example",
      type: "article",
    });

    expect(keys(tags)).toEqual([
      "og:image",
      "og:image:width",
      "og:image:height",
      "og:image:alt",
      "twitter:card",
      "twitter:image",
      "twitter:image:alt",
      "og:title",
      "og:description",
      "og:url",
      "og:site_name",
      "og:type",
    ]);
    expect(tags.at(-1)).toEqual({ property: "og:type", content: "article" });
  });

  it("repeats the og:image group per image, preserving caller order", () => {
    const metadata = socialImageMetadata("/docs", "Docs card", {
      openGraph: { images: [landscape, square] },
    });

    expect(socialMetaTags(metadata).slice(0, 9)).toEqual([
      { property: "og:image", content: landscape.url },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:type", content: "image/png" },
      { property: "og:image:alt", content: "Landscape card" },
      { property: "og:image", content: square.url },
      { property: "og:image:width", content: "600" },
      { property: "og:image:height", content: "600" },
      { property: "og:image:alt", content: "Square card" },
    ]);
  });

  it("drops an Open Graph group whose URL repeats an earlier one", () => {
    const metadata = socialImageMetadata("/docs", "Docs card", {
      openGraph: { images: [landscape, square, { ...landscape, alt: "Duplicate" }] },
    });
    const urls = socialMetaTags(metadata)
      .filter((tag) => tag.property === "og:image")
      .map((tag) => tag.content);

    expect(urls).toEqual([landscape.url, square.url]);
    expect(socialMetaTags(metadata).map((tag) => tag.content)).not.toContain("Duplicate");
  });

  it("omits alt, type, and dimensions that are not defined", () => {
    const metadata: SocialMetaInput = {
      openGraph: { images: [{ url: "https://example.com/a.png" }] },
      twitter: { card: "summary", images: [{ url: "https://example.com/b.png" }] },
    };

    expect(socialMetaTags(metadata)).toEqual([
      { property: "og:image", content: "https://example.com/a.png" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:image", content: "https://example.com/b.png" },
    ]);
  });

  it("emits no tag for undefined or empty options", () => {
    const metadata = socialImageMetadata("/", "Home card");
    const baseline = socialMetaTags(metadata);

    expect(
      socialMetaTags(metadata, {
        title: undefined,
        description: "",
        url: undefined,
        siteName: undefined,
        type: undefined,
      }),
    ).toEqual(baseline);
    expect(keys(baseline).some((key) => /^og:(?:title|description|url|site_name|type)$/.test(key))).toBe(
      false,
    );
  });

  it("defaults og:type to website only when a title or url is supplied", () => {
    const metadata = socialImageMetadata("/", "Home card");
    const typeOf = (tags: SocialMetaTag[]) => tags.find((tag) => tag.property === "og:type")?.content;

    expect(typeOf(socialMetaTags(metadata, { title: "Home" }))).toBe("website");
    expect(typeOf(socialMetaTags(metadata, { url: "https://example.com/" }))).toBe("website");
    expect(typeOf(socialMetaTags(metadata, { description: "Only a description" }))).toBeUndefined();
    expect(typeOf(socialMetaTags(metadata, { siteName: "Example" }))).toBeUndefined();
    expect(typeOf(socialMetaTags(metadata, { type: "article" }))).toBe("article");
  });

  it("emits nothing for metadata without channels", () => {
    expect(socialMetaTags({})).toEqual([]);
    expect(socialMetaHtml({})).toBe("");
  });

  describe("image URLs", () => {
    it("leaves relative URLs untouched without a canonical url", () => {
      const tags = socialMetaTags(socialImageMetadata("/docs", "Docs card"));

      expect(tags[0]).toEqual({ property: "og:image", content: "/docs/og-image" });
      expect(tags.find((tag) => tag.name === "twitter:image")?.content).toBe("/docs/og-image");
    });

    it("resolves relative URLs against the canonical url", () => {
      const metadata: SocialMetaInput = {
        openGraph: {
          images: [
            { url: "/docs/og-image" },
            { url: "card.png" },
            { url: "//cdn.example.com/c.png" },
          ],
        },
        twitter: { card: "summary_large_image", images: [{ url: "/docs/x.png" }] },
      };
      const tags = socialMetaTags(metadata, { url: "https://example.com/docs/page?lang=en" });

      expect(tags.filter((tag) => tag.property === "og:image").map((tag) => tag.content)).toEqual([
        "https://example.com/docs/og-image",
        "https://example.com/docs/card.png",
        "https://cdn.example.com/c.png",
      ]);
      expect(tags.find((tag) => tag.name === "twitter:image")?.content).toBe(
        "https://example.com/docs/x.png",
      );
      expect(tags.find((tag) => tag.property === "og:url")?.content).toBe(
        "https://example.com/docs/page?lang=en",
      );
    });

    it("never rewrites absolute image URLs", () => {
      const metadata = socialImageMetadata("/docs", "Docs card", {
        origin: "https://images.example.net",
      });
      const tags = socialMetaTags(metadata, { url: "https://example.com/docs" });

      expect(tags[0]?.content).toBe("https://images.example.net/docs/og-image");
    });

    it.each([
      ["/docs", /absolute http\(s\) URL/],
      ["javascript:alert(1)", /absolute http\(s\) URL/],
      ["ftp://example.com/", /absolute http\(s\) URL/],
      ["https://user:secret@example.com/", /credentials/],
    ])("rejects canonical url %s", (url, message) => {
      expect(() => socialMetaTags(socialImageMetadata("/", "Home"), { url })).toThrow(message);
    });

    it("rejects an empty image URL", () => {
      expect(() => socialMetaTags({ openGraph: { images: [{ url: "" }] } })).toThrow(
        /Open Graph image URL/,
      );
    });

    it.each([0, 1.5, 65_536, Number.NaN])("rejects dimension %s", (width) => {
      expect(() =>
        socialMetaTags({ openGraph: { images: [{ url: "/a.png", width }] } }),
      ).toThrow(/Invalid size: width/);
    });
  });

  describe("socialImageMetadata interplay", () => {
    it("follows the X Card style and channel-specific image", () => {
      const metadata = socialImageMetadata("/docs", "Docs card", {
        twitter: {
          card: "summary",
          image: square,
          site: "@example",
          siteId: "111",
          creator: "@author",
          creatorId: "222",
        },
      });

      expect(socialMetaTags(metadata).filter((tag) => tag.name !== undefined)).toEqual([
        { name: "twitter:card", content: "summary" },
        { name: "twitter:image", content: square.url },
        { name: "twitter:image:alt", content: "Square card" },
        { name: "twitter:site", content: "@example" },
        { name: "twitter:site:id", content: "111" },
        { name: "twitter:creator", content: "@author" },
        { name: "twitter:creator:id", content: "222" },
      ]);
    });

    it("emits og:image:type only when the metadata carries a media type", () => {
      const untyped = socialMetaTags(socialImageMetadata("/", "Home"));
      const typed = socialMetaTags(socialImageMetadata("/", "Home", { type: "image/jpeg" }));

      expect(keys(untyped)).not.toContain("og:image:type");
      expect(typed.find((tag) => tag.property === "og:image:type")?.content).toBe("image/jpeg");
    });

    it("omits every X Card tag when the twitter channel is absent", () => {
      const { openGraph } = socialImageMetadata("/", "Home");

      expect(keys(socialMetaTags({ openGraph })).every((key) => key.startsWith("og:"))).toBe(true);
    });

    it("reads only the first X Card image", () => {
      const tags = socialMetaTags({
        twitter: { card: "summary_large_image", images: [landscape, square] },
      });

      expect(tags.filter((tag) => tag.name === "twitter:image")).toEqual([
        { name: "twitter:image", content: landscape.url },
      ]);
    });
  });
});

describe("socialMetaHtml", () => {
  it("renders one meta element per line in tag order", () => {
    const metadata = socialImageMetadata("/", "Home card");

    expect(socialMetaHtml(metadata)).toBe(
      [
        '<meta property="og:image" content="/og-image">',
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        '<meta property="og:image:alt" content="Home card">',
        '<meta name="twitter:card" content="summary_large_image">',
        '<meta name="twitter:image" content="/og-image">',
        '<meta name="twitter:image:alt" content="Home card">',
      ].join("\n"),
    );
  });

  it("prefixes every line with the indent", () => {
    const html = socialMetaHtml(socialImageMetadata("/", "Home"), { indent: "\t  " });

    expect(html.split("\n").every((line) => line.startsWith("\t  <meta "))).toBe(true);
  });

  it.each(["x", "  >", "\n", "<script>"])("rejects a non-whitespace indent %j", (indent) => {
    expect(() => socialMetaHtml(socialImageMetadata("/", "Home"), { indent })).toThrow(/indent/);
  });

  it("escapes every special character in attribute values", () => {
    expect(escapeAttribute(`a&b<c>d"e'f\ng\rh`)).toBe(
      "a&amp;b&lt;c&gt;d&quot;e&#39;f&#10;g&#13;h",
    );
    // `&` is escaped first, so an existing entity is not decoded on output.
    expect(escapeAttribute("&amp;")).toBe("&amp;amp;");
  });

  it("escapes a URL with a query string and a title with quotes", () => {
    const html = socialMetaHtml(
      { openGraph: { images: [{ url: "https://example.com/og?title=a&lang=en", alt: `"Q" & <A>` }] } },
      { title: `Ada's "Notes" </title><script>` },
    );

    expect(html).toContain('content="https://example.com/og?title=a&amp;lang=en"');
    expect(html).toContain('content="&quot;Q&quot; &amp; &lt;A&gt;"');
    expect(html).toContain(
      'content="Ada&#39;s &quot;Notes&quot; &lt;/title&gt;&lt;script&gt;"',
    );
    expect(html).not.toMatch(/<(?!meta )/);
  });

  it("round-trips through a strict attribute parser", () => {
    const metadata = socialImageMetadata("/docs", `Docs "card" & <more>`, {
      openGraph: { images: [landscape, { ...square, alt: "Line one\nline two\r\n" }] },
      twitter: { card: "summary", site: "@o'brien" },
    });
    const options = {
      title: `It's "quoted" <b>bold</b> & more`,
      description: "Tabs\tstay; newlines\nescape",
      url: "https://example.com/docs?a=1&b=2",
      siteName: "Example & Co",
    };

    for (const indent of ["", "    "]) {
      expect(parseHtml(socialMetaHtml(metadata, { ...options, indent }), indent)).toEqual(
        socialMetaTags(metadata, options),
      );
    }
  });

  it("refuses to render a key outside the og:/twitter: allowlist", () => {
    const hostile = [
      { property: 'og:image" onload="alert(1)', content: "x" },
      { name: "description", content: "x" },
      { property: "og:Image", content: "x" },
      { name: "twitter:", content: "x" },
      { property: "og:image ", content: "x" },
    ] as SocialMetaTag[];

    for (const tag of hostile) {
      expect(() => renderMetaTags([tag])).toThrow(/unrecognized meta tag key/);
    }
    expect(() => renderMetaTags([{ content: "x" } as unknown as SocialMetaTag])).toThrow(
      /unrecognized meta tag key/,
    );
  });
});
