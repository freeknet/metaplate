import { readFileSync } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteImageLoader } from "../../src/assets.js";
import { fontLoader } from "../../src/font-data.js";
import { imageAsset, type ImageAsset } from "../../src/image.js";
import { createNextOg } from "../../src/next.js";
import { createNodeOg } from "../../src/node.js";
import { verifyPng } from "../../src/png.js";
import { createSvgOg, type PlateContext, type SatoriNode } from "../../src/render.js";
import { closeLocalServers, localServer, serveBytes } from "../helpers/http-fixtures.js";
import { RED_GIF, fixture } from "../helpers/image-fixtures.js";

afterEach(closeLocalServers);

// Real renders: loading Satori, Resvg, and fonts cold exceeds Vitest's 5 s
// default on macOS and Windows runners.
const RENDER_TIMEOUT = 30_000;

const root = path.join(import.meta.dirname, "../..");
const installed = (...segments: string[]) => readFileSync(path.join(root, "node_modules", ...segments));
const fonts = fontLoader([
  { name: "Inter", weight: 700, data: installed("@fontsource", "inter", "files", "inter-latin-700-normal.woff") },
]);

/** A decodable red PNG, encoded by Resvg itself. */
const RED_PNG = new Resvg(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#ff0000"/></svg>',
).render().asPng();

const size = { width: 120, height: 60 } as const;

/** A transparent card whose only content is `image`, drawn over its whole canvas. */
function imageCard(image: Pick<ImageAsset, "src">): SatoriNode {
  return {
    type: "div",
    props: {
      style: { width: "100%", height: "100%", display: "flex" },
      children: { type: "img", props: { src: image.src, width: size.width, height: size.height } },
    },
  };
}

/** Share of pixels that are opaque red. */
function redShare(pixels: Uint8Array): number {
  let red = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset]! > 200 && pixels[offset + 1]! < 50 && pixels[offset + 2]! < 50 && pixels[offset + 3]! > 200) {
      red += 1;
    }
  }
  return red / (pixels.length / 4);
}

describe("async components", () => {
  it("lays out an async component's element in SVG", async () => {
    const plate = createSvgOg<{ title: string }>({
      alt: (copy) => copy.title,
      fonts,
      size,
      component: async (copy) => {
        await Promise.resolve();
        return {
          type: "div",
          props: { style: { display: "flex", fontFamily: "Inter" }, children: copy.title },
        };
      },
    });
    const svg = await plate.renderSvg({ title: "Async" });
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain("<path");
  }, RENDER_TIMEOUT);

  it("passes the variant context and propagates a rejection", async () => {
    const seen: PlateContext<"square">[] = [];
    const plate = createSvgOg<{ fail: boolean }, "square">({
      alt: () => "card",
      fonts,
      size,
      variants: { square: { size: { width: 60, height: 60 } } },
      component: async (copy, context) => {
        seen.push(context);
        if (copy.fail) throw new Error("avatar service unavailable");
        return { type: "div", props: { style: { display: "flex" } } };
      },
    });
    await plate.variant("square").renderSvg({ fail: false });
    expect(seen).toEqual([{ variant: "square", size: { width: 60, height: 60 } }]);
    await expect(plate.renderSvg({ fail: true })).rejects.toThrow("avatar service unavailable");
  }, RENDER_TIMEOUT);

  it("calls a synchronous component once per render, as before", async () => {
    const component = vi.fn((): SatoriNode => ({ type: "div", props: { style: { display: "flex" } } }));
    const plate = createSvgOg({ alt: () => "card", fonts, size, component });
    await plate.renderSvg({});
    await plate.renderSvg({});
    expect(component).toHaveBeenCalledTimes(2);
  }, RENDER_TIMEOUT);

  it("renders a real PNG from an async component through Next ImageResponse", async () => {
    const plate = createNextOg<{ title: string }>({
      alt: (copy) => copy.title,
      size,
      component: async (copy) => {
        const logo = imageAsset(RED_PNG);
        return (
          <div style={{ display: "flex", width: "100%", height: "100%" }}>
            <img src={logo.src} width={logo.width} height={logo.height} />
            {copy.title}
          </div>
        );
      },
    });
    const response = await plate.render({ title: "Next" });
    expect(response.headers.get("content-type")).toBe("image/png");
    verifyPng(await response.arrayBuffer(), size);
  }, RENDER_TIMEOUT);
});

describe("embedded images in real renders", () => {
  // Why GIF is off by default: the Resvg in next/og (Next.js 16) draws an
  // embedded GIF or WebP as nothing, so the PNG is byte-identical to an
  // empty card. PNG is the control. If this starts failing, revisit the
  // default formats in IMAGE_ASSET_DEFAULTS.
  it("documents which embedded formats next/og draws", async () => {
    const render = async (image: ImageAsset | undefined) => {
      const plate = createNextOg({
        alt: () => "card",
        size,
        component: () => (
          <div style={{ display: "flex", width: "100%", height: "100%" }}>
            {image === undefined ? null : <img src={image.src} width={size.width} height={size.height} />}
          </div>
        ),
      });
      return Buffer.from(await (await plate.render({})).arrayBuffer());
    };
    const empty = await render(undefined);
    expect((await render(imageAsset(RED_PNG))).equals(empty)).toBe(false);
    expect((await render(imageAsset(RED_GIF, { formats: ["gif"] }))).equals(empty)).toBe(true);
    const webp = imageAsset(fixture("card-lossless.webp"), { formats: ["webp"] });
    expect((await render(webp)).equals(empty)).toBe(true);
  }, RENDER_TIMEOUT);


  it("draws an imageAsset PNG and an opted-in GIF with metaplate/node", async () => {
    for (const asset of [imageAsset(RED_PNG), imageAsset(RED_GIF, { formats: ["gif"] })]) {
      const plate = createNodeOg({ alt: () => "card", fonts, size, component: () => imageCard(asset) });
      const { pixels } = await plate.renderPixels({});
      expect(redShare(pixels), asset.format).toBeGreaterThan(0.95);
    }
  }, RENDER_TIMEOUT);

  it("draws a viewBox-only SVG logo", async () => {
    const logo = imageAsset(new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 2"><rect width="4" height="2" fill="#ff0000"/></svg>',
    ));
    expect(logo).toMatchObject({ width: 4, height: 2 });
    const plate = createNodeOg({ alt: () => "card", fonts, size, component: () => imageCard(logo) });
    expect(redShare((await plate.renderPixels({})).pixels)).toBeGreaterThan(0.95);
  }, RENDER_TIMEOUT);

  // Why WebP is off by default: Satori embeds it, but Resvg 2.6 draws it as
  // nothing. If a Resvg upgrade starts decoding WebP, this fails, and the
  // default formats in IMAGE_ASSET_DEFAULTS should be revisited.
  it("documents that Resvg 2.6 draws an embedded WebP as nothing", async () => {
    const webp = imageAsset(fixture("card-lossless.webp"), { formats: ["webp"] });
    const plate = createNodeOg({ alt: () => "card", fonts, size, component: () => imageCard(webp) });
    const { pixels } = await plate.renderPixels({});
    expect(pixels.every((value, index) => index % 4 !== 3 || value === 0)).toBe(true);
  }, RENDER_TIMEOUT);

  it("fetches a per-page image through remoteImageLoader inside an async component", async () => {
    const server = await localServer(serveBytes(RED_PNG, "image/png"));
    const avatar = remoteImageLoader({
      origins: [server.origin],
      allowPrivate: true,
      allowedPorts: [server.port],
    });
    const plate = createNodeOg<{ avatar: string }>({
      alt: () => "card",
      fonts,
      size,
      component: async (copy) => imageCard(await avatar(copy.avatar)),
    });
    const first = await plate.renderPixels({ avatar: `${server.origin}/u/1.png` });
    const second = await plate.renderPixels({ avatar: `${server.origin}/u/1.png` });
    expect(redShare(first.pixels)).toBeGreaterThan(0.95);
    expect(second.pixels).toEqual(first.pixels);
    expect(server.requests).toHaveLength(1);
  }, RENDER_TIMEOUT);
});
