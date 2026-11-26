import { describe, expect, it } from "vitest";
import {
  SOCIAL_BLOCK_END,
  SOCIAL_BLOCK_START,
  buildHtmlPage,
  htmlTarget,
  spliceSocialBlock,
  type HtmlPageSource,
} from "../../src/render/html-page.js";
import path from "node:path";

const render = (indent: string) => `${indent}<meta property="og:image" content="https://example.com/a.png">`;

const PAGE = [
  "<!doctype html>",
  "<html>",
  "  <head>",
  "    <title>Rebrand</title>",
  "  </head>",
  "  <body></body>",
  "</html>",
  "",
].join("\n");

function source(overrides: Partial<HtmlPageSource> = {}): HtmlPageSource {
  return {
    path: "public/rebrand/index.html",
    target: "/project/public/rebrand/index.html",
    route: "/rebrand",
    metadata: {
      openGraph: { images: [{ url: "https://example.com/rebrand/og-image.png?v=1a2b", width: 1200, height: 630 }] },
      twitter: { card: "summary_large_image", images: [{ url: "https://example.com/rebrand/og-image.png?v=1a2b" }] },
    },
    page: { title: "Rebrand", url: "https://example.com/rebrand/" },
    ...overrides,
  };
}

describe("spliceSocialBlock", () => {
  it("inserts the block on its own lines before </head>, indented like the line above", () => {
    expect(spliceSocialBlock(PAGE, render)).toBe([
      "<!doctype html>",
      "<html>",
      "  <head>",
      "    <title>Rebrand</title>",
      `    ${SOCIAL_BLOCK_START}`,
      '    <meta property="og:image" content="https://example.com/a.png">',
      `    ${SOCIAL_BLOCK_END}`,
      "  </head>",
      "  <body></body>",
      "</html>",
      "",
    ].join("\n"));
  });

  it("is idempotent: a second pass returns the same text", () => {
    const once = spliceSocialBlock(PAGE, render);
    expect(spliceSocialBlock(once, render)).toBe(once);
  });

  it("replaces an existing block in place, keeping the rest of the page byte for byte", () => {
    const before = PAGE.replace(
      "  </head>",
      `\t\t${SOCIAL_BLOCK_START}\n<meta property="og:image" content="old.png">\n<meta name="stale">\n${SOCIAL_BLOCK_END}\n  <link rel="icon" href="/favicon.ico">\n  </head>`,
    );
    const after = spliceSocialBlock(before, render);
    expect(after).toBe(PAGE.replace(
      "  </head>",
      `\t\t${SOCIAL_BLOCK_START}\n\t\t<meta property="og:image" content="https://example.com/a.png">\n\t\t${SOCIAL_BLOCK_END}\n  <link rel="icon" href="/favicon.ico">\n  </head>`,
    ));
    expect(after).not.toContain("old.png");
    expect(spliceSocialBlock(after, render)).toBe(after);
  });

  it("reads markers with extra whitespace and writes them back canonically", () => {
    const html = "<head>\n<!--metaplate:social-->\n<!--   /metaplate:social   -->\n</head>";
    expect(spliceSocialBlock(html, render)).toBe(
      `<head>\n${SOCIAL_BLOCK_START}\n<meta property="og:image" content="https://example.com/a.png">\n${SOCIAL_BLOCK_END}\n</head>`,
    );
  });

  it("matches </head> case-insensitively and gives an inline </head> lines of its own", () => {
    const html = "<HTML><HEAD><TITLE>x</TITLE></HEAD ><BODY></BODY></HTML>";
    const once = spliceSocialBlock(html, render);
    expect(once).toBe(
      `<HTML><HEAD><TITLE>x</TITLE>\n${SOCIAL_BLOCK_START}\n<meta property="og:image" content="https://example.com/a.png">\n${SOCIAL_BLOCK_END}\n</HEAD ><BODY></BODY></HTML>`,
    );
    expect(spliceSocialBlock(once, render)).toBe(once);
  });

  it("keeps CRLF line endings inside the block", () => {
    const html = PAGE.replaceAll("\n", "\r\n");
    const once = spliceSocialBlock(html, render);
    expect(once.replaceAll("\r\n", "")).not.toContain("\n");
    expect(once).toContain(`    ${SOCIAL_BLOCK_START}\r\n    <meta`);
    expect(spliceSocialBlock(once, render)).toBe(once);
  });

  it("indents one level deeper than </head> when the line above is not deeper", () => {
    expect(spliceSocialBlock("<head>\n</head>", render)).toBe(
      `<head>\n  ${SOCIAL_BLOCK_START}\n  <meta property="og:image" content="https://example.com/a.png">\n  ${SOCIAL_BLOCK_END}\n</head>`,
    );
  });

  it.each([
    ["no </head> and no markers", "<html><body></body></html>", "the page has no </head> and no <!-- metaplate:social --> block"],
    ["a start marker without an end", `<head>${SOCIAL_BLOCK_START}</head>`, "has <!-- metaplate:social --> without <!-- /metaplate:social -->"],
    ["an end marker without a start", `<head>${SOCIAL_BLOCK_END}</head>`, "has <!-- /metaplate:social --> without <!-- metaplate:social -->"],
    ["two blocks", `<head>${SOCIAL_BLOCK_START}${SOCIAL_BLOCK_END}${SOCIAL_BLOCK_START}${SOCIAL_BLOCK_END}</head>`, "has 2 <!-- metaplate:social --> and 2 <!-- /metaplate:social --> markers"],
    ["a duplicated start marker", `<head>${SOCIAL_BLOCK_START}${SOCIAL_BLOCK_START}${SOCIAL_BLOCK_END}</head>`, "expected at most one block"],
    ["markers in the wrong order", `<head>${SOCIAL_BLOCK_END}${SOCIAL_BLOCK_START}</head>`, "has <!-- /metaplate:social --> before <!-- metaplate:social -->"],
    ["a block after </head>", `<head></head><body>${SOCIAL_BLOCK_START}${SOCIAL_BLOCK_END}</body>`, "block after </head>; move the markers into <head>"],
  ])("refuses %s", (_name, html, message) => {
    expect(() => spliceSocialBlock(html, render)).toThrow(message);
  });

  it("uses an existing block without needing </head>", () => {
    const html = `<meta charset="utf-8">\n${SOCIAL_BLOCK_START}\n${SOCIAL_BLOCK_END}\n<body>`;
    expect(spliceSocialBlock(html, render)).toContain(`${SOCIAL_BLOCK_START}\n<meta property="og:image"`);
  });
});

describe("buildHtmlPage", () => {
  it("writes the plate's image tags, with the version token, and the page fields", () => {
    const html = buildHtmlPage(source(), PAGE);
    expect(html).toContain('<meta property="og:image" content="https://example.com/rebrand/og-image.png?v=1a2b">');
    expect(html).toContain('<meta name="twitter:image" content="https://example.com/rebrand/og-image.png?v=1a2b">');
    expect(html).toContain('<meta property="og:title" content="Rebrand">');
    expect(html).toContain('<meta property="og:url" content="https://example.com/rebrand/">');
    expect(buildHtmlPage(source(), html)).toBe(html);
  });

  it("emits og:url exactly as given, with or without a trailing slash", () => {
    expect(buildHtmlPage(source({ page: { url: "https://example.com/rebrand" } }), PAGE)).toContain(
      '<meta property="og:url" content="https://example.com/rebrand">',
    );
    expect(buildHtmlPage(source({ page: {} }), PAGE)).not.toContain("og:url");
  });

  it("escapes every page value through socialMetaHtml", () => {
    const html = buildHtmlPage(
      source({ page: { title: `"><script>alert(1)</script>`, description: "Tom & Jerry's\nshow" } }),
      PAGE,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain('content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(html).toContain('content="Tom &amp; Jerry&#39;s&#10;show"');
  });

  it("resolves a relative image URL against page.url, and refuses one with no page.url", () => {
    const relative = source({
      metadata: { openGraph: { images: [{ url: "/docs/rebrand/og-image.png" }] } },
      page: { url: "https://example.com/docs/rebrand/" },
    });
    expect(buildHtmlPage(relative, PAGE)).toContain('content="https://example.com/docs/rebrand/og-image.png"');
    expect(() => buildHtmlPage({ ...relative, page: {} }, PAGE)).toThrow(
      "the page would get the relative image URL /docs/rebrand/og-image.png, and crawlers need an absolute one",
    );
  });

  it("refuses a page with hand-written image tags outside the block", () => {
    const html = PAGE.replace("</title>", '</title>\n<meta property="og:image" content="https://example.com/old.png">');
    expect(() => buildHtmlPage(source(), html)).toThrow(
      "the page has image tags outside the <!-- metaplate:social --> block (og:image https://example.com/old.png)",
    );
    const twitter = PAGE.replace("</title>", '</title>\n<meta name="twitter:image" content="https://example.com/old.png">');
    expect(() => buildHtmlPage(source(), twitter)).toThrow("twitter:image https://example.com/old.png");
  });

  it("refuses a block a crawler would not read", () => {
    const inScript = PAGE.replace("</title>", `</title>\n<script>/* ${SOCIAL_BLOCK_START} ${SOCIAL_BLOCK_END} */</script>`);
    expect(() => buildHtmlPage(source(), inScript)).toThrow("where a crawler would not read it");
  });

  it("reports an invalid page field", () => {
    expect(() => buildHtmlPage(source({ page: { locale: "en-US" } }), PAGE)).toThrow("Open Graph uses an underscore");
  });
});

describe("htmlTarget", () => {
  const root = path.resolve("project-root");

  it("resolves the path against the project root", () => {
    expect(htmlTarget(root, "public/rebrand/index.html")).toEqual({
      path: "public/rebrand/index.html",
      target: path.join(root, "public", "rebrand", "index.html"),
    });
    expect(htmlTarget(root, "PAGE.HTM").path).toBe("PAGE.HTM");
  });

  it.each([
    ["../outside.html", "resolves outside the project directory"],
    [path.resolve("elsewhere", "page.html"), "resolves outside the project directory"],
    [".", "resolves outside the project directory"],
    ["public/notes.txt", "must name an .html or .htm file"],
  ])("refuses %s", (file, message) => {
    expect(() => htmlTarget(root, file)).toThrow(message);
  });
});
