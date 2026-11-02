import { describe, expect, it } from "vitest";
import { decodeAttributeValue, decodeHtmlBytes, extractPageSocialMetadata } from "../src/html-metadata.js";

const PAGE = "https://example.com/blog/post";

function extract(head: string, body = "", url = PAGE) {
  return extractPageSocialMetadata(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`, url);
}

describe("extractPageSocialMetadata: Open Graph", () => {
  it("reads og:image with its structured properties, title, and description", () => {
    const metadata = extract(`
      <meta property="og:title" content="Launch">
      <meta property="og:description" content="  A new release.  ">
      <meta property="og:image" content="https://example.com/og.png">
      <meta property="og:image:secure_url" content="https://cdn.example.com/og.png">
      <meta property="og:image:type" content="image/png">
      <meta property="og:image:width" content="1200">
      <meta property="og:image:height" content="630">
      <meta property="og:image:alt" content="Launch card">
    `);

    expect(metadata.openGraph).toEqual({
      title: "Launch",
      description: "A new release.",
      images: [{
        url: "https://example.com/og.png",
        secureUrl: "https://cdn.example.com/og.png",
        type: "image/png",
        width: "1200",
        height: "630",
        alt: "Launch card",
      }],
    });
    expect(metadata.issues).toEqual([]);
  });

  it("attaches structured properties to the latest root og:image (the ogp.me arrays example)", () => {
    const metadata = extract(`
      <meta property="og:image" content="https://example.com/rock.jpg" />
      <meta property="og:image:width" content="300" />
      <meta property="og:image:height" content="300" />
      <meta property="og:image" content="https://example.com/rock2.jpg" />
      <meta property="og:image" content="https://example.com/rock3.jpg" />
      <meta property="og:image:height" content="1000" />
    `);
    expect(metadata.openGraph.images).toEqual([
      { url: "https://example.com/rock.jpg", width: "300", height: "300" },
      { url: "https://example.com/rock2.jpg" },
      { url: "https://example.com/rock3.jpg", height: "1000" },
    ]);
  });

  it("treats og:image:url as identical to og:image", () => {
    const metadata = extract(`
      <meta property="og:image" content="/a.png">
      <meta property="og:image:url" content="/a.png">
      <meta property="og:image:url" content="/b.png">
      <meta property="og:image:alt" content="B">
    `);
    expect(metadata.openGraph.images).toEqual([{ url: "/a.png" }, { url: "/b.png", alt: "B" }]);
  });

  it("keeps the first value of a repeated property and reports orphaned structured properties", () => {
    const metadata = extract(`
      <meta property="og:image:width" content="10">
      <meta property="og:title" content="First">
      <meta property="og:title" content="Second">
      <meta property="og:image" content="/a.png">
      <meta property="og:image:alt" content="First alt">
      <meta property="og:image:alt" content="Second alt">
    `);
    expect(metadata.openGraph.title).toBe("First");
    expect(metadata.openGraph.images).toEqual([{ url: "/a.png", alt: "First alt" }]);
    expect(metadata.issues).toEqual([
      expect.objectContaining({ code: "orphan-property", message: expect.stringContaining("og:image:width") }),
    ]);
  });

  it("ignores meta tags without a content attribute", () => {
    expect(extract(`<meta property="og:image"><meta property="og:image" content="/x.png">`).openGraph.images)
      .toEqual([{ url: "/x.png" }]);
  });
});

describe("extractPageSocialMetadata: X Cards", () => {
  it("reads twitter:* from name or property, first value wins", () => {
    const metadata = extract(`
      <meta name="twitter:card" content="summary_large_image">
      <meta name="twitter:card" content="summary">
      <meta property="twitter:title" content="Title">
      <meta name="twitter:description" content="Description">
      <meta name="twitter:image" content="https://example.com/x.png">
      <meta name="twitter:image:alt" content="X card">
    `);
    expect(metadata.twitter).toEqual({
      card: "summary_large_image",
      title: "Title",
      description: "Description",
      image: "https://example.com/x.png",
      imageAlt: "X card",
    });
  });

  it("reads both keys when one tag carries name and property", () => {
    const metadata = extract(`<meta name="twitter:description" property="og:description" content="Both">`);
    expect(metadata.twitter.description).toBe("Both");
    expect(metadata.openGraph.description).toBe("Both");
  });
});

describe("extractPageSocialMetadata: attribute syntax", () => {
  it.each([
    ["content before property", `<meta content="/a.png" property="og:image">`],
    ["single quotes", `<meta property='og:image' content='/a.png'>`],
    ["unquoted values", `<meta property=og:image content=/a.png>`],
    ["unquoted value before the self-closing slash", `<meta property=og:image content=/a.png />`],
    ["uppercase names and tag", `<META PROPERTY="OG:IMAGE" CONTENT="/a.png">`],
    ["spaces around equals", `<meta property = "og:image"   content =  "/a.png" >`],
    ["newlines between attributes", `<meta\n\tproperty="og:image"\n\tcontent="/a.png"\n>`],
    ["self-closing", `<meta property="og:image" content="/a.png"/>`],
    ["extra attributes", `<meta data-x="a > b" property="og:image" itemprop content="/a.png">`],
  ])("reads %s", (_name, tag) => {
    expect(extract(tag).openGraph.images).toEqual([{ url: "/a.png" }]);
  });

  it("keeps the first of duplicate attributes, as the HTML tokenizer does", () => {
    expect(extract(`<meta property="og:image" content="/first.png" content="/second.png">`).openGraph.images)
      .toEqual([{ url: "/first.png" }]);
  });

  it("keeps a slash inside an unquoted value", () => {
    expect(extract(`<meta property=og:image content=https://example.com/a/b.png>`).openGraph.images)
      .toEqual([{ url: "https://example.com/a/b.png" }]);
  });
});

describe("decodeAttributeValue", () => {
  it.each([
    ["https://example.com/og.png?a=1&amp;b=2", "https://example.com/og.png?a=1&b=2"],
    ["Tom &amp; Jerry &lt;3 &quot;quoted&quot; &apos;s", "Tom & Jerry <3 \"quoted\" 's"],
    ["&#39;&#x27;&#X27;", "'''"],
    ["caf&#233; &#x1F600;", "café 😀"],
    ["&#128512", "😀"],
    ["&#0; &#xD800; &#x110000; &#99999999999999999999;", "� � � �"],
    ["&#x80;&#x99;", "€™"],
    ["&mdash;&hellip;&nbsp;&copy;", "—… ©"],
    ["Fish &amp chips", "Fish & chips"],
    ["?a=1&copy=2", "?a=1&copy=2"],
    ["&ampx; &notanentity; &; & &#; &#x;", "&ampx; &notanentity; &; & &#; &#x;"],
    ["no references", "no references"],
  ])("decodes %j", (input, expected) => {
    expect(decodeAttributeValue(input)).toBe(expected);
  });

  it("decodes entities in content values during extraction", () => {
    const metadata = extract(`
      <meta property="og:image" content="https://example.com/og?w=1200&amp;h=630">
      <meta property="og:image:alt" content="Caf&eacute; &amp; Bar &#8212; menu">
    `);
    expect(metadata.openGraph.images[0]).toEqual({
      url: "https://example.com/og?w=1200&h=630",
      alt: "Caf&eacute; & Bar — menu",
    });
  });
});

describe("extractPageSocialMetadata: document structure", () => {
  it("ignores meta-like text in comments, scripts, styles, titles, and textareas", () => {
    const metadata = extract(`
      <!-- <meta property="og:image" content="/comment.png"> -->
      <title><meta property="og:image" content="/title.png"></title>
      <script>document.write('<meta property="og:image" content="/script.png">')</SCRIPT >
      <style>/* <meta property="og:image" content="/style.png"> */</style>
      <meta property="og:image" content="/real.png">
    `);
    expect(metadata.openGraph.images).toEqual([{ url: "/real.png" }]);
  });

  it("ignores social meta tags once the head has ended, and says so", () => {
    const metadata = extract(
      `<meta property="og:image" content="/head.png">`,
      `<meta property="og:image" content="/body.png"><meta name="twitter:card" content="summary">`,
    );
    expect(metadata.openGraph.images).toEqual([{ url: "/head.png" }]);
    expect(metadata.twitter.card).toBeUndefined();
    expect(metadata.issues).toEqual([
      expect.objectContaining({ code: "meta-outside-head", message: expect.stringContaining("2 social meta tags (first: og:image)") }),
    ]);
  });

  it("ends the head at the first element that cannot appear in it", () => {
    const metadata = extractPageSocialMetadata(
      `<meta property="og:title" content="Kept"><div></div><meta property="og:image" content="/late.png">`,
      PAGE,
    );
    expect(metadata.openGraph.title).toBe("Kept");
    expect(metadata.openGraph.images).toEqual([]);
  });

  it("survives malformed markup", () => {
    const cases = [
      `<meta property="og:image" content="/a.png`,
      `<meta property="og:image" content="/a.png" <meta property="og:title" content="x">`,
      `<!-- never closed <meta property="og:image" content="/a.png">`,
      `< meta property="og:image" content="/a.png">`,
      `</ ><//><! ><? ?>`,
      `<script>never closed <meta property="og:image" content="/a.png">`,
      `<`,
      ``,
    ];
    for (const html of cases) {
      expect(() => extractPageSocialMetadata(html, PAGE)).not.toThrow();
    }
    expect(extractPageSocialMetadata(cases[0]!, PAGE).openGraph.images).toEqual([]);
    expect(extractPageSocialMetadata(cases[3]!, PAGE).openGraph.images).toEqual([]);
  });

  it("finishes in linear time on adversarial input", () => {
    const inputs = [
      "<a ".repeat(200_000),
      "<meta content=".repeat(100_000),
      `<meta content="${"&#".repeat(200_000)}" property="og:image">`,
      `<meta content="${"&amp".repeat(200_000)}" property="og:image">`,
      "</".repeat(200_000),
      `<script>${"</scrip".repeat(100_000)}`,
      `<script type="application/ld+json">${"[".repeat(100_000)}</script>`,
      "<!".repeat(200_000),
    ];
    const started = performance.now();
    for (const html of inputs) extractPageSocialMetadata(html, PAGE);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("extractPageSocialMetadata: base URL", () => {
  it("uses the document URL without a base element", () => {
    expect(extract("").baseUrl).toBe(PAGE);
  });

  it("resolves the first base href against the document URL", () => {
    const metadata = extract(`<base target="_blank"><base href="/static/"><base href="https://other.example/">`);
    expect(metadata.baseHref).toBe("/static/");
    expect(metadata.baseUrl).toBe("https://example.com/static/");
  });

  it.each([
    [`<base href="javascript:alert(1)">`],
    [`<base href="data:text/html,x">`],
    [`<base href="http://[bad">`],
  ])("falls back to the document URL for %s", (tag) => {
    expect(extract(tag).baseUrl).toBe(PAGE);
  });

  it("rejects a document URL that is not absolute", () => {
    expect(() => extractPageSocialMetadata("", "/relative")).toThrow(TypeError);
  });
});

describe("extractPageSocialMetadata: JSON-LD", () => {
  it("collects ImageObject URLs and pixel dimensions", () => {
    const metadata = extract(`<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "ImageObject",
      contentUrl: "https://example.com/og.png",
      url: "https://example.com/other.png",
      encodingFormat: "image/png",
      width: { "@type": "QuantitativeValue", value: 1200, unitCode: "E37" },
      height: "630",
    })}</script>`);
    expect(metadata.jsonLd).toEqual({
      scripts: 1,
      images: [{ url: "https://example.com/og.png", width: 1200, height: 630, encodingFormat: "image/png", script: 0 }],
    });
  });

  it("walks @graph, image properties, arrays, and several scripts", () => {
    const metadata = extract(
      `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Article", image: ["/a.png", { url: "/b.png", width: 800, height: 600 }] },
          { "@type": ["Thing", "schema:ImageObject"], contentUrl: "/c.png", width: { value: 10, unitCode: "MTR" } },
        ],
      })}</script>`,
      `<script type="Application/LD+JSON; charset=utf-8">{"@type":"Organization","logo":"/logo.png","image":"/a.png"}</script>
       <script type="application/json">{"@type":"ImageObject","contentUrl":"/ignored.png"}</script>`,
    );
    expect(metadata.jsonLd.scripts).toBe(2);
    expect(metadata.jsonLd.images).toEqual([
      { url: "/a.png", script: 0 },
      { url: "/b.png", width: 800, height: 600, script: 0 },
      { url: "/c.png", script: 0 },
    ]);
  });

  it("reads script content as raw text, without decoding character references", () => {
    const metadata = extract(`<script type="application/ld+json">{"@type":"ImageObject","contentUrl":"/a.png?x=1&amp;y=2"}</script>`);
    expect(metadata.jsonLd.images[0]?.url).toBe("/a.png?x=1&amp;y=2");
  });

  it("reports invalid JSON without failing", () => {
    const metadata = extract(`<script type="application/ld+json">{ not json }</script>`);
    expect(metadata.jsonLd).toEqual({ scripts: 1, images: [] });
    expect(metadata.issues).toEqual([
      expect.objectContaining({ code: "json-ld", message: expect.stringContaining("JSON-LD script 0 is not valid JSON") }),
    ]);
  });

  it("bounds deeply nested JSON-LD", () => {
    const nested = `${"[".repeat(100)}{"@type":"ImageObject","contentUrl":"/deep.png"}${"]".repeat(100)}`;
    const metadata = extract(`<script type="application/ld+json">${nested}</script>`);
    expect(metadata.jsonLd.images).toEqual([]);
    expect(metadata.issues).toEqual([expect.objectContaining({ code: "json-ld", message: expect.stringContaining("not fully read") })]);
  });
});

describe("decodeHtmlBytes", () => {
  const latin1Page = Uint8Array.from([
    ...new TextEncoder().encode('<meta property="og:title" content="Caf'),
    0xe9,
    ...new TextEncoder().encode('">'),
  ]);

  it("decodes UTF-8 by default", () => {
    expect(decodeHtmlBytes(new TextEncoder().encode("café"), "text/html")).toBe("café");
  });

  it("honors the Content-Type charset", () => {
    expect(decodeHtmlBytes(latin1Page, "text/html; charset=ISO-8859-1")).toContain("Café");
    expect(decodeHtmlBytes(latin1Page, 'text/html; charset="windows-1252"')).toContain("Café");
  });

  it("finds a meta charset in the first 1024 bytes", () => {
    const bytes = Uint8Array.from([...new TextEncoder().encode('<meta charset="windows-1252">'), ...latin1Page]);
    expect(decodeHtmlBytes(bytes, "text/html")).toContain("Café");
    const httpEquiv = Uint8Array.from([
      ...new TextEncoder().encode('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">'),
      ...latin1Page,
    ]);
    expect(decodeHtmlBytes(httpEquiv, undefined)).toContain("Café");
  });

  it("lets a byte order mark win and ignores unknown labels", () => {
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("café")]);
    expect(decodeHtmlBytes(bom, "text/html; charset=windows-1252")).toBe("café");
    expect(decodeHtmlBytes(new TextEncoder().encode("café"), "text/html; charset=not-a-charset")).toBe("café");
    expect(decodeHtmlBytes(new TextEncoder().encode("café"), "text/html; charset=utf-16")).toBe("café");
  });
});
