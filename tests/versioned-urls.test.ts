import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fontsourceFontLoader } from "../src/fonts.js";
import { socialImageVersion, socialMetaHtml } from "../src/index.js";
import { createNodeOg } from "../src/node.js";
import { verifyRemotePage } from "../src/page-verification.js";
import { closeLocalServers, localServer, pathRoutes } from "./helpers/http-fixtures.js";

afterEach(closeLocalServers);

type Copy = { title: string };

const SQUARE = { width: 1080, height: 1080 };
const inter = fontsourceFontLoader([{ font: "inter", weight: 700 }]);
const copy: Copy = { title: "Launch" };

function card(value: Copy) {
  return {
    type: "div",
    props: {
      style: { width: "100%", height: "100%", display: "flex", fontFamily: "Inter", fontSize: 64 },
      children: value.title,
    },
  };
}

function plate(options: { version?: "copy"; revision?: string; origin?: string } = {}) {
  return createNodeOg<Copy, "square">({
    alt: (value) => `${value.title} card`,
    fonts: inter,
    imagePath: "og-image.png",
    basePath: "/site",
    variants: { square: { size: SQUARE } },
    component: card,
    ...options,
  });
}

describe("plate versioning", () => {
  it("derives the token from copy and revision for every metadata URL, never the site path", () => {
    const og = plate({ version: "copy", revision: "2", origin: "https://example.com" });
    const v = socialImageVersion(copy, "2");
    const metadata = og.metadata("/blog/launch", copy, { twitter: { variant: "square" } });

    expect(metadata.openGraph.images.map(({ url }) => url)).toEqual([
      `https://example.com/site/blog/launch/og-image.png?v=${v}`,
      `https://example.com/site/blog/launch/og-image-square.png?v=${v}`,
    ]);
    expect(metadata.twitter.images[0]!.url).toBe(`https://example.com/site/blog/launch/og-image-square.png?v=${v}`);
    expect(og.image("/blog/launch", copy).url).toBe(`https://example.com/site/blog/launch/og-image.png?v=${v}`);
    expect(og.variant("square").metadata("/blog/launch", copy).openGraph.images[0]!.url)
      .toBe(`https://example.com/site/blog/launch/og-image-square.png?v=${v}`);
    expect(og.sitePath("/blog/launch")).toBe("blog/launch/og-image.png");
    expect(og.variant("square").sitePath("/blog/launch")).toBe("blog/launch/og-image-square.png");
  });

  it("re-versions when the copy or the revision changes", () => {
    const url = (og: ReturnType<typeof plate>, value: Copy) => og.image("/", value).url;
    const first = url(plate({ version: "copy" }), copy);
    expect(url(plate({ version: "copy" }), { title: "Launch" })).toBe(first);
    expect(url(plate({ version: "copy" }), { title: "Launch 2" })).not.toBe(first);
    expect(url(plate({ version: "copy", revision: "2" }), copy)).not.toBe(first);
  });

  it("lets a call name an explicit token, with or without plate versioning", () => {
    expect(plate().metadata("/", copy, { version: "build-41" }).openGraph.images.map(({ url }) => url)).toEqual([
      "/site/og-image.png?v=build-41",
      "/site/og-image-square.png?v=build-41",
    ]);
    expect(plate({ version: "copy" }).image("/", copy, { version: "pinned" }).url).toBe("/site/og-image.png?v=pinned");
    expect(() => plate().metadata("/", copy, { version: "a=b" })).toThrow("Invalid version");
  });

  it("leaves URLs unversioned unless asked", () => {
    expect(plate().metadata("/", copy).openGraph.images[0]!.url).toBe("/site/og-image.png");
  });

  it("validates plate-level versioning at definition", () => {
    expect(() => plate({ revision: "2" })).toThrow('revision requires version: "copy"');
    expect(() => plate({ version: "hash" as "copy" })).toThrow('a plate\'s version must be "copy"');
    expect(() => plate({ version: "copy", revision: "" })).toThrow("Invalid revision");
  });

  it("names the copy path when the copy cannot be versioned", () => {
    const og = createNodeOg<{ title: string; render: () => void }>({
      alt: (value) => value.title,
      fonts: inter,
      version: "copy",
      component: card,
    });
    expect(() => og.metadata("/", { title: "x", render: () => undefined })).toThrow("copy.render is a function");
  });
});

describe("serving versioned URLs", { timeout: 30_000 }, () => {
  it("versions the artifact metadata URL without changing the bytes", async () => {
    const og = plate({ version: "copy" });
    const artifact = await og.artifact("/blog/launch", copy);
    expect(artifact.metadata.openGraph.images[0]!.url)
      .toBe(`/site/blog/launch/og-image.png?v=${socialImageVersion(copy)}`);
    const explicit = await og.artifact("/blog/launch", copy, { version: "7" });
    expect(explicit.metadata.openGraph.images[0]!.url).toBe("/site/blog/launch/og-image.png?v=7");
    expect(explicit.bytes).toEqual(artifact.bytes);
  });

  it("is served by path routing and passes verify-page end to end", async () => {
    let dispatch: (request: IncomingMessage, response: ServerResponse) => void = () => undefined;
    const server = await localServer((request, response) => dispatch(request, response));
    const og = plate({ version: "copy", revision: "3", origin: server.origin });
    const route = "/blog/launch";

    // Each image route resolves copy from the path alone, as handlerFrom does
    // in a framework route; the version query plays no part in routing.
    const v = socialImageVersion(copy, "3");
    const serve = (fetchable: { fetch: (request: Request) => Promise<Response> }) =>
      (request: IncomingMessage, response: ServerResponse) => {
        void fetchable.fetch(new Request(new URL(request.url ?? "/", server.origin))).then(async (result) => {
          const bytes = new Uint8Array(await result.arrayBuffer());
          response.writeHead(result.status, { "Content-Type": result.headers.get("content-type") ?? "" });
          response.end(bytes);
        });
      };
    const resolve = (request: Request) => {
      expect(new URL(request.url).searchParams.get("v")).toBe(v);
      return copy;
    };
    const head = socialMetaHtml(og.metadata(route, copy), { url: `${server.origin}${route}`, title: "Launch" });
    dispatch = pathRoutes({
      [route]: (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><head>${head}</head><body></body></html>`);
      },
      [`/site${route}/og-image.png`]: serve(og.fetchableFrom(resolve)),
      [`/site${route}/og-image-square.png`]: serve(og.variant("square").fetchableFrom(resolve)),
    });

    const report = await verifyRemotePage(`${server.origin}${route}`, {
      allowPrivate: true,
      allowedPorts: [server.port],
    });
    const landscape = `${server.origin}/site${route}/og-image.png?v=${v}`;
    const square = `${server.origin}/site${route}/og-image-square.png?v=${v}`;
    expect(report.valid).toBe(true);
    expect(report.images.map(({ source, url, valid, image }) => [source, url, valid, image?.width])).toEqual([
      ["og:image", landscape, true, 1200],
      ["og:image", square, true, 1080],
      ["twitter:image", landscape, true, 1200],
    ]);
    // The crawler requested the versioned URLs themselves, query included.
    expect(server.requests.map(({ url }) => url)).toEqual([
      route,
      `/site${route}/og-image.png?v=${v}`,
      `/site${route}/og-image-square.png?v=${v}`,
    ]);
  });
});
