import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  REMOTE_PAGE_ACCEPT,
  verifyRemotePage,
  verifyRemotePageVia,
  type RemotePageOptions,
  type RemotePageVerification,
} from "../src/page-verification.js";
import { REMOTE_USER_AGENT, type RemoteAddress } from "../src/remote.js";
import { closeLocalServers, localServer, redirectTo, routes, serveBytes, type LocalServer } from "./helpers/http-fixtures.js";
import { completePng } from "./helpers/image-fixtures.js";

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
