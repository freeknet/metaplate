import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  REMOTE_PAGE_ACCEPT,
  verifyRemotePage,
  verifyRemotePageVia,
  type RemotePageOptions,
  type RemotePageVerification,
} from "../../src/verify/page-verification.js";
import { REMOTE_USER_AGENT, type RemoteAddress } from "../../src/verify/remote.js";
import { closeLocalServers, localServer, redirectTo, routes, serveBytes, type LocalServer } from "../helpers/http-fixtures.js";
import { completePng } from "../helpers/image-fixtures.js";

afterEach(closeLocalServers);

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const card = completePng(1200, 630);
const square = completePng(600, 600);

/** Serves `html` as a UTF-8 HTML document. */
function serveHtml(html: string, contentType = "text/html; charset=utf-8"): Handler {
  return serveBytes(new TextEncoder().encode(html), contentType);
}

/** A loopback site whose routes may refer to its own origin. */
async function site(build: (origin: string) => Record<string, Handler>): Promise<LocalServer> {
  let dispatch: Handler = () => undefined;
  const server = await localServer((request, response) => dispatch(request, response));
  dispatch = routes(build(server.origin));
  return server;
}

function local(server: LocalServer, extra: RemotePageOptions = {}): RemotePageOptions {
  return { allowPrivate: true, allowedPorts: [server.port], ...extra };
}

function page(head: string, body = ""): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

const COMPLETE_HEAD = `
  <meta property="og:title" content="Launch">
  <meta property="og:image" content="/og.png">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Launch card">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="/og.png">
  <meta name="twitter:image:alt" content="Launch card">
`;

function codes(report: { globalIssues: readonly { code: string }[] }): string[] {
  return report.globalIssues.map(({ code }) => code);
}

describe("verifyRemotePage", () => {
  it("extracts, resolves, fetches, and verifies every referenced image", async () => {
    const server = await site(() => ({
      "/post": serveHtml(page(COMPLETE_HEAD, `<script type="application/ld+json">${JSON.stringify({
        "@type": "ImageObject",
        contentUrl: "/square.png",
        width: 600,
        height: 600,
        encodingFormat: "image/png",
      })}</script>`)),
      "/og.png": serveBytes(card, "image/png"),
      "/square.png": serveBytes(square, "image/png"),
    }));

    const report = await verifyRemotePage(`${server.origin}/post`, local(server));

    expect(report).toMatchObject({
      url: `${server.origin}/post`,
      finalUrl: `${server.origin}/post`,
      redirects: [],
      contentType: "text/html; charset=utf-8",
      baseUrl: `${server.origin}/post`,
      valid: true,
      metadata: { openGraph: { title: "Launch" }, twitter: { card: "summary_large_image" }, jsonLd: { scripts: 1 } },
      targets: {},
    });
    expect(report.images.map(({ source, url, valid, image }) => ({ source, url, valid, size: `${image?.width}x${image?.height}` }))).toEqual([
      { source: "og:image", url: `${server.origin}/og.png`, valid: true, size: "1200x630" },
      { source: "twitter:image", url: `${server.origin}/og.png`, valid: true, size: "1200x630" },
      { source: "json-ld", url: `${server.origin}/square.png`, valid: true, size: "600x600" },
    ]);
    // The og:image is relative, and plain http on loopback: both are warnings.
    expect(codes(report.images[0]!)).toEqual(["relative-url", "insecure-url"]);
    expect(report.globalIssues).toEqual([]);
    // One fetch per distinct URL.
    expect(server.requests.map(({ url }) => url)).toEqual(["/post", "/og.png", "/square.png"]);
  });

  it("sends an HTML Accept header for the page and image/* for images, with no cookies", async () => {
    const server = await site(() => ({
      "/": serveHtml(page(COMPLETE_HEAD)),
      "/og.png": serveBytes(card, "image/png"),
    }));
    await verifyRemotePage(`${server.origin}/`, local(server));

    const [pageRequest, imageRequest] = server.requests;
    expect(pageRequest?.headers.accept).toBe(REMOTE_PAGE_ACCEPT);
    expect(pageRequest?.headers["user-agent"]).toBe(REMOTE_USER_AGENT);
    expect(imageRequest?.headers.accept).toBe("image/*");
    for (const { headers } of server.requests) expect(headers.cookie).toBeUndefined();
  });

  it("resolves relative URLs against the final URL after redirects", async () => {
    const server = await site(() => ({
      "/old": redirectTo("/blog/new/", 301),
      "/blog/new/": serveHtml(page(`<meta property="og:image" content="card.png"><meta property="og:image:alt" content="x">`)),
      "/blog/new/card.png": serveBytes(card, "image/png"),
    }));
    const report = await verifyRemotePage(`${server.origin}/old`, local(server));

    expect(report.finalUrl).toBe(`${server.origin}/blog/new/`);
    expect(report.redirects).toEqual([`${server.origin}/blog/new/`]);
    expect(report.images[0]).toMatchObject({ url: `${server.origin}/blog/new/card.png`, valid: true });
  });

  it("resolves relative URLs against <base href>", async () => {
    const server = await site(() => ({
      "/a/page": serveHtml(page(`<base href="/assets/"><meta property="og:image" content="card.png">`)),
      "/assets/card.png": serveBytes(card, "image/png"),
    }));
    const report = await verifyRemotePage(`${server.origin}/a/page`, local(server));
    expect(report.baseUrl).toBe(`${server.origin}/assets/`);
    expect(report.metadata.baseHref).toBe("/assets/");
    expect(report.images[0]).toMatchObject({ url: `${server.origin}/assets/card.png`, valid: true });
  });

  it("reports declared dimensions and type that disagree with the bytes", async () => {
    const server = await site(() => ({
      "/": serveHtml(page(`
        <meta property="og:image" content="/og.png">
        <meta property="og:image:type" content="image/jpeg">
        <meta property="og:image:width" content="1200">
        <meta property="og:image:height" content="600">
        <meta property="og:image" content="/og.png">
        <meta property="og:image:width" content="wide">
        <meta property="og:image:height" content="630">
        <meta property="og:image" content="/og.png">
        <meta property="og:image:width" content="1200">
      `)),
      "/og.png": serveBytes(card, "image/png"),
    }));
    const report = await verifyRemotePage(`${server.origin}/`, local(server));

    expect(report.valid).toBe(false);
    const [mismatch, unparseable, partial] = report.images;
    expect(mismatch).toMatchObject({ valid: false, declared: { width: "1200", height: "600", type: "image/jpeg" } });
    expect(mismatch!.globalIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", code: "dimensions", message: expect.stringContaining("1200x600, but image bytes are 1200x630") }),
      expect.objectContaining({ severity: "error", code: "format", message: expect.stringContaining("image/jpeg, but image bytes are image/png") }),
    ]));
    expect(unparseable!.globalIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", code: "declared-dimensions", message: expect.stringContaining('"wide"') }),
    ]));
    expect(partial).toMatchObject({ valid: true });
    expect(partial!.globalIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", code: "declared-dimensions", message: expect.stringContaining("Only the width is declared") }),
    ]));
    expect(server.requests).toHaveLength(2);
  });

  it("reports page-level omissions", async () => {
    const server = await site(() => ({
      "/bare": serveHtml(page(`<title>Nothing</title>`)),
      "/card-only": serveHtml(page(`<meta name="twitter:card" content="summary">`)),
      "/odd-card": serveHtml(page(`<meta name="twitter:card" content="gallery"><meta property="og:image" content="/og.png">`)),
      "/og.png": serveBytes(card, "image/png"),
    }));

    const bare = await verifyRemotePage(`${server.origin}/bare`, local(server));
    expect(bare.valid).toBe(false);
    expect(bare.globalIssues).toEqual([
      expect.objectContaining({ severity: "error", code: "og-image-missing" }),
      expect.objectContaining({ severity: "warning", code: "twitter-card-missing" }),
    ]);

    const cardOnly = await verifyRemotePage(`${server.origin}/card-only`, local(server));
    expect(codes(cardOnly)).toEqual(["og-image-missing", "twitter-image-missing"]);

    const odd = await verifyRemotePage(`${server.origin}/odd-card`, local(server));
    expect(odd.valid).toBe(true);
    expect(odd.globalIssues).toEqual([expect.objectContaining({ severity: "warning", code: "twitter-card-unknown" })]);
    expect(codes(odd.images[0]!)).toContain("alt");
  });

  it("flags http image URLs, and fails an http og:image:secure_url", async () => {
    const server = await site((origin) => ({
      "/": serveHtml(page(`
        <meta property="og:image" content="${origin}/og.png">
        <meta property="og:image:secure_url" content="${origin}/og.png">
        <meta property="og:image:alt" content="Card">
      `)),
      "/og.png": serveBytes(card, "image/png"),
    }));
    const report = await verifyRemotePage(`${server.origin}/`, local(server));

    expect(report.images[0]).toMatchObject({ source: "og:image", valid: true });
    expect(report.images[0]!.globalIssues).toEqual([expect.objectContaining({ severity: "warning", code: "insecure-url" })]);
    expect(report.images[1]).toMatchObject({ source: "og:image:secure_url", valid: false });
    expect(report.images[1]!.globalIssues).toEqual([
      expect.objectContaining({ severity: "error", code: "insecure-url", message: expect.stringContaining("must be an https URL") }),
    ]);
  });

  it("reports image fetch failures with their stable codes", async () => {
    const server = await site(() => ({
      "/": serveHtml(page(`
        <meta property="og:image" content="/missing.png">
        <meta property="og:image" content="/mislabeled.png">
        <meta property="og:image" content="/not-an-image">
        <meta property="og:image" content="file:///etc/passwd">
        <meta property="og:image" content="http://[broken">
        <meta property="og:image" content="">
      `)),
      "/mislabeled.png": serveBytes(card, "image/jpeg"),
      "/not-an-image": serveHtml("<p>hello</p>"),
    }));
    const report = await verifyRemotePage(`${server.origin}/`, local(server));

    expect(report.valid).toBe(false);
    expect(report.images.map((image) => image.globalIssues.find(({ severity }) => severity === "error")?.code)).toEqual([
      "status",
      "content-type",
      "image",
      "scheme",
      "invalid-url",
      "invalid-url",
    ]);
    // The mislabeled image still reports what its bytes are.
    expect(report.images[1]).toMatchObject({ image: { format: "png", width: 1200, height: 630 }, contentType: "image/jpeg" });
    expect(report.images[4]).toMatchObject({ url: null });
  });

  it("never echoes credentials from an image URL", async () => {
    const server = await site((origin) => ({
      "/": serveHtml(page(`<meta property="og:image" content="${origin.replace("http://", "http://user:hunter2@")}/og.png">`)),
    }));
    const report = await verifyRemotePage(`${server.origin}/`, local(server));
    expect(JSON.stringify(report)).not.toContain("hunter2");
    expect(report.images[0]!.globalIssues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "credentials" })]));
  });

  it("stops fetching at maxImages and says which references were skipped", async () => {
    const server = await site(() => ({
      "/": serveHtml(page(["a", "b", "c", "a"].map((name) => `<meta property="og:image" content="/${name}.png">`).join(""))),
      "/a.png": serveBytes(card, "image/png"),
      "/b.png": serveBytes(card, "image/png"),
      "/c.png": serveBytes(card, "image/png"),
    }));
    const report = await verifyRemotePage(`${server.origin}/`, local(server, { maxImages: 2 }));

    expect(server.requests.map(({ url }) => url)).toEqual(["/", "/a.png", "/b.png"]);
    expect(report.images.map(({ image }) => image !== undefined)).toEqual([true, true, false, true]);
    expect(report.images[2]!.globalIssues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "unknown", code: "image-limit" })]));
    expect(report.valid).toBe(true);
    expect(report.globalIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "unknown", code: "image-limit", message: expect.stringContaining("1 image reference was not fetched") }),
    ]));
  });

  it("evaluates targets against the image each consumer chooses", async () => {
    const server = await site(() => ({
      "/": serveHtml(page(`
        <meta property="og:image" content="/og.png">
        <meta property="og:image:alt" content="Card">
        <meta property="og:image" content="/square.png">
        <meta name="twitter:card" content="summary">
        <meta name="twitter:image" content="/square.png">
      `)),
      "/og.png": serveBytes(card, "image/png"),
      "/square.png": serveBytes(square, "image/png"),
    }));
    const report = await verifyRemotePage(`${server.origin}/`, local(server, { targets: ["discord", "linkedin", "x"] }));

    const [first, second, twitter] = report.images;
    // The first og:image serves every target except X, which reads twitter:image.
    expect(Object.keys(first!.targets)).toEqual(["discord", "linkedin"]);
    // Discord accepts the relative URL; without og:image:type it can only warn.
    expect(first!.targets.discord).toEqual({
      compatible: true,
      issues: [expect.objectContaining({ severity: "warning", code: "format", target: "discord" })],
    });
    // LinkedIn needs a crawler-ready https URL; this one is relative.
    expect(first!.targets.linkedin?.compatible).toBe(false);
    // The square second og:image is not judged against LinkedIn's minimum size.
    expect(second!.targets).toEqual({});
    // X's image has no twitter:image:alt, which the profile requires.
    expect(twitter!.targets.x?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "contract", message: "Social images require alt text." }),
    ]));
    expect(report.targets).toEqual({
      discord: { compatible: true, issues: [] },
      linkedin: { compatible: false, issues: [] },
      x: { compatible: false, issues: [] },
    });
  });

  it("makes a missing twitter:card an X target error", async () => {
    const server = await site(() => ({
      "/": serveHtml(page(`<meta property="og:image" content="/og.png">`)),
      "/og.png": serveBytes(card, "image/png"),
    }));
    const report = await verifyRemotePage(`${server.origin}/`, local(server, { targets: ["x"] }));
    expect(report.targets.x).toEqual({
      compatible: false,
      issues: [expect.objectContaining({ severity: "error", code: "twitter-card-missing", target: "x" })],
    });
    expect(codes(report)).not.toContain("twitter-card-missing");
    // Without twitter:image, X falls back to og:image, so it is checked for X.
    expect(Object.keys(report.images[0]!.targets)).toEqual(["x"]);
  });

  it("applies maxFileSize to every image", async () => {
    const server = await site(() => ({
      "/": serveHtml(page(COMPLETE_HEAD)),
      "/og.png": serveBytes(card, "image/png"),
    }));
    const report = await verifyRemotePage(`${server.origin}/`, local(server, { maxFileSize: 10 }));
    expect(report.valid).toBe(false);
    expect(report.images.every((image) => image.globalIssues.some(({ code }) => code === "file-size"))).toBe(true);
  });
});

describe("verifyRemotePage page policy", () => {
  it.each([
    ["application/json", "application/json"],
    ["image/png", "image/png"],
    [undefined, "(no Content-Type)"],
  ])("refuses a page served as %s", async (contentType, shown) => {
    const server = await localServer(serveBytes(new TextEncoder().encode(page(COMPLETE_HEAD)), contentType));
    await expect(verifyRemotePage(`${server.origin}/`, local(server))).rejects.toMatchObject({
      code: "content-type",
      message: expect.stringContaining(`served as ${shown}, not as an HTML document`),
    });
  });

  it("accepts application/xhtml+xml", async () => {
    const server = await site(() => ({
      "/": serveHtml(page(COMPLETE_HEAD), "Application/XHTML+XML; charset=utf-8"),
      "/og.png": serveBytes(card, "image/png"),
    }));
    await expect(verifyRemotePage(`${server.origin}/`, local(server))).resolves.toMatchObject({ valid: true });
  });

  it("caps the HTML body at maxHtmlBytes, separately from the image cap", async () => {
    const server = await site(() => ({
      "/": serveHtml(page(COMPLETE_HEAD, "x".repeat(4096))),
      "/og.png": serveBytes(card, "image/png"),
    }));
    await expect(verifyRemotePage(`${server.origin}/`, local(server, { maxHtmlBytes: 1024 }))).rejects.toMatchObject({
      code: "byte-limit",
      message: expect.stringContaining("1024-byte limit"),
    });
    const report = await verifyRemotePage(`${server.origin}/`, local(server, { maxBytes: 16 }));
    expect(report.images[0]!.globalIssues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "error", code: "byte-limit" })]));
  });

  it("refuses a loopback page without allowPrivate before connecting", async () => {
    const server = await site(() => ({ "/": serveHtml(page(COMPLETE_HEAD)) }));
    await expect(verifyRemotePage(`${server.origin}/`, { allowedPorts: [server.port] })).rejects.toMatchObject({ code: "address" });
    expect(server.requests).toHaveLength(0);
  });

  it("refuses private image addresses named by a public page", async () => {
    const PUBLIC_STAND_IN = "93.184.216.34";
    const dialLoopback = (address: RemoteAddress): RemoteAddress =>
      address.address === PUBLIC_STAND_IN ? { address: "127.0.0.1", family: 4 } : address;
    const server = await site((origin) => ({
      "/": serveHtml(page(`
        <meta property="og:image" content="${origin}/og.png">
        <meta name="twitter:image" content="http://169.254.169.254/latest/meta-data/">
      `)),
      "/og.png": serveBytes(card, "image/png"),
    }));
    const resolve = async (hostname: string) => {
      if (hostname !== "page.test") throw new Error(`unexpected lookup ${hostname}`);
      return [{ address: PUBLIC_STAND_IN, family: 4 }];
    };

    const report: RemotePageVerification = await verifyRemotePageVia(
      `http://page.test:${server.port}/`,
      { resolve, allowedPorts: [server.port] },
      dialLoopback,
    );

    expect(report.images.map(({ source }) => source)).toEqual(["og:image", "twitter:image"]);
    expect(report.images[0]!.globalIssues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "address" })]));
    expect(report.images[1]!.globalIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "address", message: expect.stringContaining("link-local") }),
    ]));
    expect(server.requests.map(({ url }) => url)).toEqual(["/"]);
  });

  it("validates its options", async () => {
    await expect(verifyRemotePage("https://example.com/", { maxHtmlBytes: 0 })).rejects.toThrow(TypeError);
    await expect(verifyRemotePage("https://example.com/", { maxImages: 1.5 })).rejects.toThrow(TypeError);
    await expect(verifyRemotePage("https://example.com/", { maxFileSize: -1 })).rejects.toThrow(TypeError);
    await expect(verifyRemotePage("https://example.com/", { targets: ["myspace" as never] })).rejects.toThrow("Unknown social target");
  });
});

/** A plain-text handler, as robots.txt is served. */
function serveText(text: string, status = 200): Handler {
  return (_request, response) => {
    response.writeHead(status, { "Content-Type": "text/plain" });
    response.end(text);
  };
}

const CARD_HEAD = `
  <meta property="og:image" content="/og.png">
  <meta property="og:image:alt" content="Card">
  <meta name="twitter:card" content="summary_large_image">
`;

describe("verifyRemotePage robots.txt checks", () => {
  it("fetches nothing extra without targets or crawlers", async () => {
    const server = await site(() => ({ "/": serveHtml(page(CARD_HEAD)), "/og.png": serveBytes(card, "image/png") }));
    const report = await verifyRemotePage(`${server.origin}/`, local(server));
    expect(report.robots).toBeUndefined();
    expect(server.requests.map(({ url }) => url)).toEqual(["/", "/og.png"]);
  });

  it("evaluates each target's crawler against the page and the image it reads, with the metaplate user agent", async () => {
    const server = await site(() => ({
      "/post": serveHtml(page(CARD_HEAD)),
      "/og.png": serveBytes(card, "image/png"),
      "/robots.txt": serveText("User-agent: Twitterbot\nDisallow: /post\n\nUser-agent: Discordbot\nDisallow: /og.png\n\nUser-agent: *\nDisallow: /\n"),
    }));
    const report = await verifyRemotePage(`${server.origin}/post`, local(server, { targets: ["x", "discord"] }));

    // X documents that Twitterbot obeys robots.txt: a disallowed page is an X error.
    expect(report.targets.x).toEqual({
      compatible: false,
      issues: [expect.objectContaining({
        severity: "error",
        code: "robots-disallowed",
        target: "x",
        message: expect.stringContaining("line 2 (Disallow: /post)"),
      })],
    });
    // Discord does not document robots.txt use: a disallowed image is a Discord warning.
    expect(report.targets.discord?.compatible).toBe(true);
    expect(report.images[0]!.targets.discord?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", code: "robots-disallowed", target: "discord" }),
    ]));
    expect(report.images[0]!.targets.x?.issues.map(({ code }) => code)).not.toContain("robots-disallowed");
    expect(report.valid).toBe(true);

    expect(report.robots?.files).toEqual([{
      origin: server.origin,
      url: `${server.origin}/robots.txt`,
      status: "parsed",
      httpStatus: 200,
      finalUrl: `${server.origin}/robots.txt`,
      bytes: expect.any(Number),
    }]);
    expect(report.robots?.crawlers.map(({ token, robots, targets, requested, allowed }) => ({ token, robots, targets, requested, allowed }))).toEqual([
      { token: "Twitterbot", robots: "honors", targets: ["x"], requested: false, allowed: false },
      { token: "Discordbot", robots: "undocumented", targets: ["discord"], requested: false, allowed: false },
    ]);
    expect(report.robots?.crawlers[0]!.checks).toEqual([
      {
        resource: "page",
        url: `${server.origin}/post`,
        robotsUrl: `${server.origin}/robots.txt`,
        allowed: false,
        group: "named",
        rule: { kind: "disallow", pattern: "/post", line: 2 },
      },
      {
        resource: "image",
        url: `${server.origin}/og.png`,
        references: ["og:image[0]"],
        robotsUrl: `${server.origin}/robots.txt`,
        allowed: true,
        group: "named",
      },
    ]);

    // robots.txt is fetched once, after the page and images, and never as a crawler.
    expect(server.requests.map(({ url }) => url)).toEqual(["/post", "/og.png", "/robots.txt"]);
    const robotsRequest = server.requests[2]!;
    expect(robotsRequest.headers["user-agent"]).toBe(REMOTE_USER_AGENT);
    expect(robotsRequest.headers.accept).toBe("text/plain");
  });

  it("fails the page for a requested crawler that is disallowed, and checks every image for it", async () => {
    const server = await site(() => ({
      "/": serveHtml(page(CARD_HEAD)),
      "/og.png": serveBytes(card, "image/png"),
      "/robots.txt": serveText("user-agent: examplebot\ndisallow: /\n"),
    }));
    const report = await verifyRemotePage(
      `${server.origin}/`,
      local(server, { crawlers: ["ExampleBot", "slackbot-linkexpanding", "ExampleBot"] }),
    );

    expect(report.valid).toBe(false);
    const disallowed = report.globalIssues.find(({ code }) => code === "robots-disallowed");
    expect(disallowed).toMatchObject({ severity: "error", message: expect.stringContaining("for ExampleBot") });
    expect(disallowed).not.toHaveProperty("target");
    expect(report.images[0]).toMatchObject({ valid: false });
    expect(report.images[0]!.globalIssues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "robots-disallowed" })]));
    // Slack documents that it ignores robots.txt: reported, never an issue.
    expect(report.robots?.crawlers.map(({ token, robots, requested, allowed }) => ({ token, robots, requested, allowed }))).toEqual([
      { token: "ExampleBot", robots: "requested", requested: true, allowed: false },
      { token: "Slackbot-LinkExpanding", robots: "ignores", requested: true, allowed: true },
    ]);
    expect(report.globalIssues.filter(({ message }) => message.includes("Slackbot"))).toEqual([]);
  });

  it("follows RFC 9309 for missing, failing, and oversized files", async () => {
    const cases: [Handler, Record<string, unknown>, boolean][] = [
      [(_request, response) => { response.writeHead(404); response.end(); }, { status: "unavailable", httpStatus: 404 }, true],
      [serveText("user-agent: *\ndisallow: /", 403), { status: "unavailable", httpStatus: 403 }, true],
      [serveText("", 503), { status: "unreachable", httpStatus: 503 }, false],
      [serveText(`${"# padding\n".repeat(60_000)}user-agent: *\ndisallow: /\n`), { status: "parsed", truncated: true, bytes: 500 * 1024 }, true],
    ];
    for (const [handler, file, allowed] of cases) {
      const server = await site(() => ({ "/": serveHtml(page(CARD_HEAD)), "/og.png": serveBytes(card, "image/png"), "/robots.txt": handler }));
      const report = await verifyRemotePage(`${server.origin}/`, local(server, { targets: ["x"] }));
      expect(report.robots?.files[0]).toMatchObject(file);
      expect(report.robots?.crawlers[0]!.allowed).toBe(allowed);
      // The loopback card is not X-ready anyway (relative, http); only robots findings matter here.
      expect(report.targets.x?.issues.some(({ code }) => code.startsWith("robots-"))).toBe(!allowed);
      if (!allowed) {
        expect(report.targets.x?.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ severity: "error", code: "robots-unreachable", message: expect.stringContaining("responded 503") }),
        ]));
      }
    }
  });

  it("follows up to five robots.txt redirects, then treats the file as unavailable", async () => {
    const hops = (count: number): Record<string, Handler> => Object.fromEntries(
      Array.from({ length: count }, (_, index) => [index === 0 ? "/robots.txt" : `/r${index}`, redirectTo(`/r${index + 1}`)]),
    );
    const near = await site(() => ({
      "/": serveHtml(page(CARD_HEAD)),
      "/og.png": serveBytes(card, "image/png"),
      ...hops(5),
      "/r5": serveText("user-agent: twitterbot\ndisallow: /og.png"),
    }));
    // The page's own redirect limit does not apply to robots.txt.
    const nearReport = await verifyRemotePage(`${near.origin}/`, local(near, { targets: ["x"], maxRedirects: 0 }));
    expect(nearReport.robots?.files[0]).toMatchObject({ status: "parsed", finalUrl: `${near.origin}/r5` });
    expect(nearReport.images[0]!.targets.x?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "robots-disallowed" })]));

    const far = await site(() => ({
      "/": serveHtml(page(CARD_HEAD)),
      "/og.png": serveBytes(card, "image/png"),
      ...hops(6),
      "/r6": serveText("user-agent: *\ndisallow: /"),
    }));
    const farReport = await verifyRemotePage(`${far.origin}/`, local(far, { targets: ["x"] }));
    expect(farReport.robots?.files[0]).toMatchObject({ status: "unavailable" });
    expect(farReport.robots?.crawlers[0]!.allowed).toBe(true);
  });

  it("reports a robots.txt the fetch policy refuses as unknown, never as allowed", async () => {
    const server = await site(() => ({
      "/": serveHtml(page(CARD_HEAD)),
      "/og.png": serveBytes(card, "image/png"),
      "/robots.txt": redirectTo("http://127.0.0.1:1/robots.txt"),
    }));
    const report = await verifyRemotePage(`${server.origin}/`, local(server, { targets: ["x"] }));
    expect(report.robots?.files[0]).toMatchObject({ status: "unknown", message: expect.any(String) });
    expect(report.robots?.crawlers[0]!.allowed).toBeNull();
    expect(report.targets.x?.issues.filter(({ code }) => code.startsWith("robots-"))).toEqual([
      expect.objectContaining({ severity: "unknown", code: "robots-unknown" }),
    ]);
  });

  it("reads robots.txt for every origin the page and its images are served from", async () => {
    const images = await site(() => ({
      "/og.png": serveBytes(card, "image/png"),
      "/robots.txt": serveText("user-agent: twitterbot\ndisallow: /og.png"),
    }));
    const server = await site(() => ({
      "/": serveHtml(page(`<meta property="og:image" content="${images.origin}/og.png"><meta name="twitter:card" content="summary">`)),
    }));
    const report = await verifyRemotePage(`${server.origin}/`, {
      allowPrivate: true,
      allowedPorts: [server.port, images.port],
      targets: ["x"],
    });
    expect(report.robots?.files.map(({ origin, status }) => ({ origin, status }))).toEqual([
      { origin: server.origin, status: "unavailable" },
      { origin: images.origin, status: "parsed" },
    ]);
    expect(report.targets.x?.compatible).toBe(false);
    expect(report.images[0]!.targets.x?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", code: "robots-disallowed", message: expect.stringContaining(`${images.origin}/robots.txt disallows`) }),
    ]));
  });

  it("rejects crawler names that are not product tokens", async () => {
    await expect(verifyRemotePage("https://example.com/", { crawlers: ["Twitterbot/1.0"] })).rejects.toThrow(TypeError);
    await expect(verifyRemotePage("https://example.com/", { crawlers: [""] })).rejects.toThrow(TypeError);
  });
});

describe("verifyRemotePage crawler read limits", () => {
  const padding = (bytes: number) => `<style>${"x".repeat(bytes)}</style>`;

  it("warns when Open Graph tags start after Meta's first 1 MB", async () => {
    const server = await site(() => ({
      "/late": serveHtml(page(`${padding(1_000_000)}${CARD_HEAD}`)),
      "/early": serveHtml(page(CARD_HEAD, padding(1_100_000))),
      "/og.png": serveBytes(card, "image/png"),
    }));
    const late = await verifyRemotePage(`${server.origin}/late`, local(server));
    expect(late.globalIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", code: "html-limit", message: expect.stringContaining("first 1,000,000 bytes") }),
    ]));
    const targeted = await verifyRemotePage(`${server.origin}/late`, local(server, { targets: ["facebook", "instagram"] }));
    expect(codes(targeted)).not.toContain("html-limit");
    expect(targeted.targets.facebook?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "html-limit", target: "facebook" })]));
    expect(targeted.targets.instagram?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "html-limit", target: "instagram" })]));
    const early = await verifyRemotePage(`${server.origin}/early`, local(server));
    expect(codes(early)).not.toContain("html-limit");
  }, 30_000);

  it("warns under whatsapp when the head does not end within 300KB", async () => {
    const server = await site(() => ({
      "/long-head": serveHtml(page(`${CARD_HEAD}${padding(300_000)}`)),
      "/long-body": serveHtml(page(CARD_HEAD, padding(400_000))),
      "/og.png": serveBytes(card, "image/png"),
    }));
    const long = await verifyRemotePage(`${server.origin}/long-head`, local(server, { targets: ["whatsapp"] }));
    expect(long.targets.whatsapp?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", code: "html-limit", target: "whatsapp", message: expect.stringContaining("first 300,000 bytes") }),
    ]));
    const short = await verifyRemotePage(`${server.origin}/long-body`, local(server, { targets: ["whatsapp"] }));
    expect(short.targets.whatsapp?.issues.map(({ code }) => code)).not.toContain("html-limit");
    // Without the whatsapp target, no WhatsApp finding.
    const untargeted = await verifyRemotePage(`${server.origin}/long-head`, local(server));
    expect(codes(untargeted)).not.toContain("html-limit");
  }, 30_000);
});

describe("verifyRemotePage reference limits", () => {
  it("parses a shared image once however many references name it", async () => {
    // A JPEG with a long entropy-coded scan: walking it is the expensive part.
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00,
      0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
      ...new Uint8Array(4 * 1024 * 1024).fill(0x55),
      0xff, 0xd9,
    ]);
    const tags = '<meta property="og:image" content="/i.jpg"><meta property="og:image:alt" content="a">'.repeat(400);
    const server = await site(() => ({ "/": serveHtml(page(tags)), "/i.jpg": serveBytes(jpeg, "image/jpeg") }));
    const started = performance.now();
    const report = await verifyRemotePage(`${server.origin}/`, local(server, { maxImageReferences: 400 }));
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(report.images).toHaveLength(400);
    expect(report.images.every((image) => image.image?.format === "jpeg")).toBe(true);
    expect(server.requests.map(({ url }) => url)).toEqual(["/", "/i.jpg"]);
  }, 30_000);

  it("inspects at most maxImageReferences references, always keeping the ones consumers read first", async () => {
    const tags = Array.from({ length: 100 }, (_, index) => `<meta property="og:image" content="/i${index % 3}.png">`).join("");
    const server = await site(() => ({
      "/": serveHtml(page(`${tags}<meta name="twitter:card" content="summary"><meta name="twitter:image" content="/i0.png">`)),
      "/i0.png": serveBytes(card, "image/png"),
      "/i1.png": serveBytes(card, "image/png"),
      "/i2.png": serveBytes(card, "image/png"),
    }));
    const report = await verifyRemotePage(`${server.origin}/`, local(server));
    expect(report.images).toHaveLength(65);
    expect(report.images.some(({ source }) => source === "twitter:image")).toBe(true);
    expect(report.globalIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "unknown", code: "image-limit", message: expect.stringContaining("36 further image references were not inspected") }),
    ]));
    await expect(verifyRemotePage(`${server.origin}/`, local(server, { maxImageReferences: 0 }))).rejects.toThrow(TypeError);
  });
});
