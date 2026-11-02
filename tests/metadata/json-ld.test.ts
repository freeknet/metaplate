import { describe, expect, it } from "vitest";
import {
  serializeJsonLd,
  socialImageJsonLd,
  socialImageJsonLdScript,
  socialImageMetadata,
  socialMetaTags,
  type SocialImageJsonLdOptions,
  type SocialImageObject,
} from "../../src/index.js";

// Written as code points so this file stays ASCII.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const escaped = (hex: string) => `\\u${hex}`;

const pixels = (value: number) => ({ "@type": "QuantitativeValue", value, unitCode: "E37" });

const docs = socialImageMetadata("/docs", "Docs card", {
  origin: "https://example.com",
  type: "image/png",
});

const licensing: SocialImageJsonLdOptions = {
  url: "https://example.com/docs",
  name: "Docs",
  creditText: "Example Studio",
  creator: { "@type": "Organization", name: "Example Studio", url: "/about" },
  copyrightNotice: "(c) 2026 Example Studio",
  license: "/license",
  acquireLicensePage: "https://example.com/licensing",
  representativeOfPage: true,
};

const SCRIPT = /^<script type="application\/ld\+json">([\s\S]*)<\/script>$/;

function payloadOf(script: string): unknown {
  const match = SCRIPT.exec(script);
  if (!match) throw new Error(`Not a JSON-LD script element: ${script}`);
  return JSON.parse(match[1]!);
}

describe("socialImageJsonLd", () => {
  it("describes a single image as one ImageObject node", () => {
    expect(socialImageJsonLd(docs)).toEqual({
      "@context": "https://schema.org",
      "@type": "ImageObject",
      contentUrl: "https://example.com/docs/og-image",
      url: "https://example.com/docs/og-image",
      caption: "Docs card",
      encodingFormat: "image/png",
      width: pixels(1200),
      height: pixels(630),
    });
  });

  it("emits keys in the documented order", () => {
    const json = socialImageJsonLd(docs, licensing);

    expect(Object.keys(json)).toEqual([
      "@context",
      "@type",
      "contentUrl",
      "url",
      "name",
      "caption",
      "encodingFormat",
      "width",
      "height",
      "representativeOfPage",
      "creditText",
      "creator",
      "copyrightNotice",
      "license",
      "acquireLicensePage",
    ]);
    expect(JSON.stringify(json)).toBe(
      '{"@context":"https://schema.org","@type":"ImageObject",' +
        '"contentUrl":"https://example.com/docs/og-image","url":"https://example.com/docs/og-image",' +
        '"name":"Docs","caption":"Docs card","encodingFormat":"image/png",' +
        '"width":{"@type":"QuantitativeValue","value":1200,"unitCode":"E37"},' +
        '"height":{"@type":"QuantitativeValue","value":630,"unitCode":"E37"},' +
        '"representativeOfPage":true,"creditText":"Example Studio",' +
        '"creator":{"@type":"Organization","name":"Example Studio","url":"https://example.com/about"},' +
        '"copyrightNotice":"(c) 2026 Example Studio","license":"https://example.com/license",' +
        '"acquireLicensePage":"https://example.com/licensing"}',
    );
  });

  it("returns the same output for the same input", () => {
    expect(JSON.stringify(socialImageJsonLd(docs, licensing))).toBe(
      JSON.stringify(socialImageJsonLd(docs, { ...licensing })),
    );
  });

  it("describes several images as an @graph in metadata order", () => {
    const metadata = socialImageMetadata("/docs", "Docs card", {
      origin: "https://example.com",
      variants: { square: { size: { width: 1080, height: 1080 }, alt: "Square card" } },
    });
    const json = socialImageJsonLd(metadata, { creditText: "Example" });

    expect(Object.keys(json)).toEqual(["@context", "@graph"]);
    expect(json).toEqual({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "ImageObject",
          contentUrl: "https://example.com/docs/og-image",
          url: "https://example.com/docs/og-image",
          caption: "Docs card",
          width: pixels(1200),
          height: pixels(630),
          creditText: "Example",
        },
        {
          "@type": "ImageObject",
          contentUrl: "https://example.com/docs/og-image-square",
          url: "https://example.com/docs/og-image-square",
          caption: "Square card",
          width: pixels(1080),
          height: pixels(1080),
          creditText: "Example",
        },
      ],
    });
  });

  it("drops a later image whose resolved URL repeats an earlier one", () => {
    const json = socialImageJsonLd(
      { openGraph: { images: [{ url: "/a.png", alt: "First" }, { url: "https://example.com/a.png" }] } },
      { url: "https://example.com/page" },
    );

    expect(json).toEqual({
      "@context": "https://schema.org",
      "@type": "ImageObject",
      contentUrl: "https://example.com/a.png",
      url: "https://example.com/a.png",
      caption: "First",
    });
  });

  describe("URLs", () => {
    const relative = socialImageMetadata("/docs", "Docs card");

    it("leaves relative URLs untouched without a canonical url", () => {
      const json = socialImageJsonLd(relative, { license: "/license" }) as SocialImageObject;

      expect(json.contentUrl).toBe("/docs/og-image");
      expect(json.url).toBe("/docs/og-image");
      expect(json.license).toBe("/license");
    });

    it("resolves relative URLs against the canonical url like socialMetaTags", () => {
      const options = { url: "https://example.com/docs/page?lang=en" };
      const json = socialImageJsonLd(relative, { ...options, license: "terms" }) as SocialImageObject;
      const ogImage = socialMetaTags(relative, options)[0]?.content;

      expect(json.contentUrl).toBe("https://example.com/docs/og-image");
      expect(json.contentUrl).toBe(ogImage);
      expect(json.license).toBe("https://example.com/docs/terms");
    });

    it("never rewrites absolute URLs", () => {
      const metadata = socialImageMetadata("/docs", "Docs card", {
        origin: "https://images.example.net",
      });
      const json = socialImageJsonLd(metadata, {
        url: "https://example.com/docs",
        acquireLicensePage: "https://licensing.example.org/buy",
      }) as SocialImageObject;

      expect(json.contentUrl).toBe("https://images.example.net/docs/og-image");
      expect(json.acquireLicensePage).toBe("https://licensing.example.org/buy");
    });

    it("does not emit the canonical page url", () => {
      const json = socialImageJsonLd(docs, { url: "https://example.com/elsewhere" });

      expect(JSON.stringify(json)).not.toContain("elsewhere");
    });

    it.each([
      ["/docs", /absolute http\(s\) URL/],
      ["javascript:alert(1)", /absolute http\(s\) URL/],
      ["ftp://example.com/", /absolute http\(s\) URL/],
      ["https://user:secret@example.com/", /credentials/],
    ])("rejects canonical url %s exactly as socialMetaTags does", (url, message) => {
      let expected: unknown;
      try {
        socialMetaTags(docs, { url });
      } catch (error) {
        expected = error;
      }
      expect(expected).toBeInstanceOf(Error);
      expect(() => socialImageJsonLd(docs, { url })).toThrow(message);
      expect(() => socialImageJsonLdScript(docs, { url })).toThrow((expected as Error).message);
    });
  });

  describe("optional fields", () => {
    it("omits every option that is undefined or empty", () => {
      const json = socialImageJsonLd(docs, {
        url: undefined,
        name: "",
        creditText: undefined,
        creator: undefined,
        copyrightNotice: "",
        license: undefined,
        acquireLicensePage: "",
        representativeOfPage: undefined,
      });

      expect(json).toEqual(socialImageJsonLd(docs));
      expect(JSON.stringify(json)).not.toContain("undefined");
    });

    it("omits image fields the metadata does not carry", () => {
      expect(socialImageJsonLd({ openGraph: { images: [{ url: "/card.png" }] } })).toEqual({
        "@context": "https://schema.org",
        "@type": "ImageObject",
        contentUrl: "/card.png",
        url: "/card.png",
      });
    });

    it("emits representativeOfPage when it is false", () => {
      const json = socialImageJsonLd(docs, { representativeOfPage: false }) as SocialImageObject;

      expect(json.representativeOfPage).toBe(false);
    });

    it("omits an empty creator url", () => {
      const json = socialImageJsonLd(docs, {
        creator: { "@type": "Person", name: "Ada", url: "" },
      }) as SocialImageObject;

      expect(json.creator).toEqual({ "@type": "Person", name: "Ada" });
    });
  });

  describe("validation", () => {
    it("requires an Open Graph image", () => {
      expect(() => socialImageJsonLd({})).toThrow(/at least one Open Graph image/);
      expect(() => socialImageJsonLd({ openGraph: { images: [] } })).toThrow(
        /at least one Open Graph image/,
      );
    });

    it("rejects an empty image URL", () => {
      expect(() => socialImageJsonLd({ openGraph: { images: [{ url: "" }] } })).toThrow(
        /Open Graph image URL/,
      );
    });

    it.each([0, 1.5, 65_536, Number.NaN])("rejects dimension %s", (height) => {
      expect(() => socialImageJsonLd({ openGraph: { images: [{ url: "/a.png", height }] } })).toThrow(
        /Invalid size: height/,
      );
    });

    it("rejects a creator without a name or a valid @type", () => {
      expect(() =>
        socialImageJsonLd(docs, { creator: { "@type": "Person", name: "" } }),
      ).toThrow(/name must not be empty/);
      expect(() =>
        socialImageJsonLd(docs, {
          creator: { "@type": "Thing", name: "Ada" } as unknown as SocialImageJsonLdOptions["creator"],
        }),
      ).toThrow(/Person" or "Organization/);
    });
  });
});

describe("socialImageJsonLdScript", () => {
  const hostile = `</script><script>alert(1)</script> & <!-- ${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}`;
  const metadata = socialImageMetadata("/docs", hostile, { origin: "https://example.com" });

  it("wraps the JSON-LD in one application/ld+json script element", () => {
    const script = socialImageJsonLdScript(docs, licensing);

    expect(script.startsWith('<script type="application/ld+json">{')).toBe(true);
    expect(payloadOf(script)).toEqual(socialImageJsonLd(docs, licensing));
  });

  it("round-trips a hostile caption through JSON.parse", () => {
    const script = socialImageJsonLdScript(metadata, { creditText: hostile });
    const payload = payloadOf(script) as SocialImageObject;

    expect(payload.caption).toBe(hostile);
    expect(payload.creditText).toBe(hostile);
    expect(payload).toEqual(socialImageJsonLd(metadata, { creditText: hostile }));
  });

  it("contains no </script other than its own closing tag", () => {
    const script = socialImageJsonLdScript(metadata);

    expect(script.toLowerCase().split("</script").length).toBe(2);
    expect(script.endsWith("</script>")).toBe(true);
    const body = SCRIPT.exec(script)![1]!;
    expect(body).not.toMatch(/[<>&]/);
    expect(body).not.toContain(LINE_SEPARATOR);
    expect(body).not.toContain(PARAGRAPH_SEPARATOR);
    expect(body).toContain(`${escaped("003c")}/script${escaped("003e")}`);
  });
});

describe("serializeJsonLd", () => {
  it.each([
    ["<", "003c"],
    [">", "003e"],
    ["&", "0026"],
    [LINE_SEPARATOR, "2028"],
    [PARAGRAPH_SEPARATOR, "2029"],
  ])("escapes %j as \\u%s", (char, hex) => {
    const text = serializeJsonLd({ value: `a${char}b` });

    expect(text).toBe(`{"value":"a${escaped(hex)}b"}`);
    expect(JSON.parse(text)).toEqual({ value: `a${char}b` });
  });

  it("leaves other text as JSON.stringify writes it", () => {
    const value = { text: 'quote " backslash \\ newline \n emoji \u{1F600}', n: [1, true, null] };

    expect(serializeJsonLd(value)).toBe(JSON.stringify(value));
  });

  it("rejects a value with no JSON form", () => {
    expect(() => serializeJsonLd({ toJSON: () => undefined })).toThrow(/no JSON form/);
  });
});
