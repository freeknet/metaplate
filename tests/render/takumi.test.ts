import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { emojiLoader, twemojiName } from "../../src/emoji.js";
import { fontLoader, languageFontLoader } from "../../src/font-data.js";
import { compareImages, createNodeOg } from "../../src/node.js";
import { RenderGuardError, type RenderGuardIssue } from "../../src/render/guards.js";
import { createTakumiOg, type TakumiOgDefinition } from "../../src/takumi.js";
import { entryBuilder } from "../helpers/entry-build.js";
import { closeLocalServers, localServer, serveBytes } from "../helpers/http-fixtures.js";
import { squareGlyphFont } from "../helpers/test-font.js";

// Takumi loads its native addon and fonts on first render; cold macOS and
// Windows runners exceed Vitest's five-second default.
const RENDER_TIMEOUT = 30_000;

const root = path.join(import.meta.dirname, "../..");
const inter = (extension: "woff" | "woff2") =>
  readFileSync(path.join(root, "node_modules/@fontsource/inter/files", `inter-latin-700-normal.${extension}`));

type Copy = { title: string };
type Child = { type: string; props: Record<string, unknown> };

const card = (children: unknown, style: Record<string, unknown> = {}) => ({
  type: "div",
  props: {
    style: {
      boxSizing: "border-box",
      position: "relative",
      width: "100%",
      height: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#111111",
      color: "#ffffff",
      fontFamily: "Inter",
      fontWeight: 700,
      fontSize: 64,
      ...style,
    },
    children,
  },
});

/** A one-line text box at a fixed place. */
const text = (content: string, left: number, top: number, width = 400): Child => ({
  type: "div",
  props: { style: { display: "flex", position: "absolute", left, top, width, height: 48, fontSize: 40 }, children: content },
});

function plate(overrides: Partial<TakumiOgDefinition<Copy>> = {}) {
  return createTakumiOg<Copy>({
    alt: (copy) => copy.title,
    fonts: fontLoader([{ name: "Inter", weight: 700, data: inter("woff2") }]),
    component: (copy) => card(copy.title),
    ...overrides,
  });
}

function collected() {
  const warnings: RenderGuardIssue[] = [];
  return { warnings, onWarning: (issue: RenderGuardIssue) => warnings.push(issue) };
}

/** Share of pixels whose largest RGB channel is bright. */
function brightShare(pixels: Uint8Array): number {
  let bright = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (Math.max(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!) > 200) bright += 1;
  }
  return bright / (pixels.length / 4);
}

describe("createTakumiOg", () => {
  it("renders a PNG of the plate's size with the plate's surface", async () => {
    const og = plate({ variants: { square: { size: { width: 1080, height: 1080 } } } });
    const png = await og.render({ title: "Hello" });
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { pixels, width, height } = await og.renderPixels({ title: "Hello" });
    expect([width, height, pixels.byteLength]).toEqual([1200, 630, 1200 * 630 * 4]);
    expect(brightShare(pixels)).toBeGreaterThan(0.002);

    const square = await og.variant("square").renderPixels({ title: "Hello" });
    expect([square.width, square.height]).toEqual([1080, 1080]);
    expect(og.contentType).toBe("image/png");
    expect(og.metadata("/posts/hello", { title: "Hello" }).openGraph.images[0]).toMatchObject({ width: 1200, height: 630 });
    expect(await og.renderSvg({ title: "Hello" })).toMatch(/^<svg/);
  }, RENDER_TIMEOUT);

  it("serves Fetch-shaped responses with owned headers and an ETag", async () => {
    const og = plate({ headers: { "Cache-Control": "public, max-age=60" }, etag: true });
    const response = await og.fetchableFrom((request: Request) => ({ title: new URL(request.url).hostname })).fetch(new Request("https://example.com/og"));
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Number(response.headers.get("content-length"))).toBe(bytes.byteLength);
    expect(await og.fingerprint()).not.toBe(await createNodeOg({
      alt: (copy: Copy) => copy.title,
      fonts: fontLoader([{ name: "Inter", weight: 700, data: inter("woff2") }]),
      component: (copy: Copy) => card(copy.title),
    }).fingerprint());
  }, RENDER_TIMEOUT);

  it("draws what metaplate/node draws for a simple card", async () => {
    const component = (copy: Copy) => card(copy.title);
    const takumi = await plate({ component }).render({ title: "Parity" });
    const satori = await createNodeOg({
      alt: (copy: Copy) => copy.title,
      fonts: fontLoader([{ name: "Inter", weight: 700, data: inter("woff") }]),
      component,
    }).render({ title: "Parity" });
    // Glyph anti-aliasing differs between the rasterisers; layout does not.
    expect(compareImages(satori, takumi, { threshold: 64 }).changedRatio).toBeLessThan(0.02);
  }, RENDER_TIMEOUT);

  it("encodes through a plate's output encoder", async () => {
    const encode = vi.fn(() => Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 0x10));
    const og = plate({ output: { format: "jpeg", encode } });
    expect(og.contentType).toBe("image/jpeg");
    await og.render({ title: "JPEG" });
    expect(encode).toHaveBeenCalledWith(expect.objectContaining({ width: 1200, height: 630 }));
  }, RENDER_TIMEOUT);

  it("rejects WOFF fonts, the satori option, and the avoid guard", async () => {
    const woff = plate({ fonts: fontLoader([{ name: "Inter", weight: 700, data: inter("woff") }]) });
    await expect(woff.render({ title: "x" })).rejects.toThrow(/cannot read the WOFF font "Inter".*WOFF2/);
    expect(() => plate({ satori: {} } as never)).toThrow(/does not use Satori/);
    expect(() => plate({ guards: { avoid: { level: "error", keys: ["photo"] } } } as never)).toThrow(
      /cannot run guards.avoid/,
    );
    expect(() => plate({ guards: { overflow: "warning" } } as never)).toThrow(/must be "error", "warn", or "off"/);
    await expect(plate({ fonts: async () => [] }).render({ title: "x" })).rejects.toThrow(/at least one font/);
  }, RENDER_TIMEOUT);
});

describe("guards", () => {
  it("reports text laid out outside the canvas, safe area, and other text", async () => {
    const { warnings, onWarning } = collected();
    const og = plate({
      component: () => card([text("Off the edge", 1100, 100), text("First", 100, 300), text("Second", 300, 310)]),
      guards: { overflow: "warn", safeArea: { level: "warn", inset: 80 }, textOverlap: "warn", onWarning },
    });
    await og.render({ title: "x" });
    expect(warnings.map((issue) => issue.guard).sort()).toEqual(["overflow", "safeArea", "textOverlap"]);
    expect(warnings.find((issue) => issue.guard === "overflow")).toMatchObject({
      element: "div",
      text: "Off the edge",
      box: { left: 1100, top: 100 },
    });
    expect(warnings.find((issue) => issue.guard === "textOverlap")).toMatchObject({
      text: "First",
      other: { text: "Second" },
    });
  }, RENDER_TIMEOUT);

  it("fails before painting when a guard is at error level", async () => {
    const og = plate({ component: () => card([text("Off the edge", 1100, 100)]), guards: { overflow: "error" } });
    const error = await og.render({ title: "x" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RenderGuardError);
    expect((error as RenderGuardError).issues[0]?.message).toMatch(/needs more room than its container has/);
  }, RENDER_TIMEOUT);

  it("measures rotated text by its transformed box", async () => {
    const { warnings, onWarning } = collected();
    const og = plate({
      component: () => card([{
        type: "div",
        props: { style: { position: "absolute", left: 20, top: 560, width: 1100, height: 48, fontSize: 40, transform: "rotate(-8deg)" }, children: "Tilted toward the bottom-left corner" },
      }]),
      guards: { overflow: "warn", onWarning },
    });
    await og.render({ title: "x" });
    const [issue] = warnings;
    expect(issue?.guard).toBe("overflow");
    if (issue?.guard === "overflow") expect(issue.box.top + issue.box.height).toBeGreaterThan(630);
  }, RENDER_TIMEOUT);

  it("reports characters no font or language font draws, once", async () => {
    const { warnings, onWarning } = collected();
    const og = plate({ guards: { missingGlyphs: "warn", overflow: "warn", onWarning } });
    await og.render({ title: "Hello 한국어 world" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ guard: "missingGlyphs", languageCode: "ko-KR", segment: "한국어" });
  }, RENDER_TIMEOUT);

  it("draws other scripts from languageFonts with Satori's language codes", async () => {
    const { warnings, onWarning } = collected();
    const data = vi.fn(() => squareGlyphFont("Squares KR", "한국어"));
    const og = plate({
      languageFonts: languageFontLoader({ "ko-KR": { name: "Squares", data } }),
      guards: { missingGlyphs: "warn", fontFallback: "warn", onWarning },
    });
    const withFont = await og.renderPixels({ title: "한국어" });
    const without = await plate().renderPixels({ title: "한국어" });
    expect(data).toHaveBeenCalled();
    expect(warnings).toEqual([]);
    // The squares cover far more of the card than missing-glyph boxes do.
    expect(brightShare(withFont.pixels)).toBeGreaterThan(brightShare(without.pixels) * 2);
  }, RENDER_TIMEOUT);

  it("offers Han characters to every language Satori would, as one combined code", async () => {
    const { warnings, onWarning } = collected();
    const load = vi.fn(async (code: string, segment: string) =>
      code.split("|").includes("ja-JP") ? [{ name: "Squares JP", weight: 700 as const, style: "normal" as const, data: squareGlyphFont("Squares JP", segment).buffer as ArrayBuffer }] : []);
    await plate({ languageFonts: load, guards: { missingGlyphs: "warn", onWarning } }).render({ title: "日本" });
    expect(load).toHaveBeenCalledWith("ja-JP|zh-CN|zh-TW|zh-HK", "日本");
    expect(warnings).toEqual([]);
  }, RENDER_TIMEOUT);

  it("counts a family only languageFonts supplies as loaded with fontFallback alone", async () => {
    const load = async (code: string, segment: string) =>
      code.split("|").includes("ja-JP")
        ? [{ name: "Squares JP", weight: 700 as const, style: "normal" as const, data: squareGlyphFont("Squares JP", segment).buffer as ArrayBuffer }]
        : [];
    const og = plate({
      languageFonts: load,
      component: (copy) => card(copy.title, { fontFamily: "Squares JP" }),
      guards: { fontFallback: "error" },
    });
    await expect(og.render({ title: "日本" })).resolves.toBeInstanceOf(Uint8Array);
  }, RENDER_TIMEOUT);

  it("reports a font family the plate never loaded", async () => {
    const { warnings, onWarning } = collected();
    const og = plate({
      component: (copy) => card(copy.title, { fontFamily: "Playfair Display" }),
      guards: { fontFallback: "warn", onWarning },
    });
    await og.render({ title: "Serif?" });
    expect(warnings.map((issue) => issue.guard)).toEqual(["fontFallback"]);
  }, RENDER_TIMEOUT);

  it("reports a lineClamp that Takumi ignores too, and passes one both engines honor", async () => {
    const long = "The quick brown fox jumps over the lazy dog again and again until the line wraps many times over";
    const clamped = (display: string) => ({
      type: "div",
      props: { style: { display, lineClamp: 2, width: 300, fontSize: 20, lineHeight: 1 }, children: long },
    });
    // Takumi, like Satori, does not clamp a flex container: the guard's warning holds on both.
    const heights = async (display: string) => {
      const [{ measure }, { fromJsx }] = await Promise.all([import("takumi-js"), import("takumi-js/helpers/jsx")]);
      const { node, css } = await fromJsx(card([clamped(display)]) as Parameters<typeof fromJsx>[0]);
      const measured = await measure(node, { width: 400, height: 300, fonts: [{ name: "Inter", weight: 700, data: inter("woff2") }], css });
      return measured.children[0]!.height;
    };
    expect(await heights("block")).toBe(40);
    expect(await heights("flex")).toBeGreaterThan(40);

    const { warnings, onWarning } = collected();
    const og = plate({
      component: () => card([clamped("flex"), clamped("block")]),
      guards: { lineClamp: "warn", onWarning },
    });
    await og.render({ title: "x" });
    expect(warnings.map((issue) => issue.guard === "lineClamp" && [issue.property, issue.reason, issue.display]))
      .toEqual([["lineClamp", "display", "flex"]]);
  }, RENDER_TIMEOUT);

  it("reports a frame that is one color", async () => {
    const og = plate({
      component: () => card([text("Gone", 100, 900)], { background: "#ffffff" }),
      guards: { blank: "error" },
    });
    await expect(og.render({ title: "x" })).rejects.toThrow(/Blank render/);
  }, RENDER_TIMEOUT);
});

describe("emoji", () => {
  const origin = new Map([
    ["1f44b-1f3fd", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" fill="#ff0000"/></svg>'],
    ["2764", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" fill="#ff0000"/></svg>'],
  ]);

  it("draws emoji from the plate's loader and never fetches", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const requested: string[] = [];
    const emoji = emojiLoader(async ({ grapheme }) => {
      requested.push(twemojiName(grapheme));
      const svg = origin.get(twemojiName(grapheme));
      return svg === undefined ? undefined : new Response(svg).arrayBuffer();
    });
    const { warnings, onWarning } = collected();
    const og = plate({ emoji, guards: { missingGlyphs: "warn", onWarning } });
    const { pixels } = await og.renderPixels({ title: "Hi 👋🏽 ❤️ 🫨" });
    let red = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset]! > 200 && pixels[offset + 1]! < 60 && pixels[offset + 2]! < 60) red += 1;
    }
    expect(red).toBeGreaterThan(2 * 50 * 50);
    expect(requested).toEqual(expect.arrayContaining(["1f44b-1f3fd", "2764"]));
    expect(warnings).toEqual([expect.objectContaining({ guard: "missingGlyphs", languageCode: "emoji", segment: "🫨" })]);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  }, RENDER_TIMEOUT);

  it("passes the loader each grapheme as the copy spells it, as Satori does", async () => {
    const red = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" fill="#ff0000"/></svg>';
    const requested: string[] = [];
    // Keyed by exact grapheme, U+FE0F included, as a loader written for Satori may be.
    const images = new Map([["1️⃣", red], ["❤️", red]]);
    const emoji = emojiLoader(({ grapheme }) => {
      requested.push(grapheme);
      return images.get(grapheme);
    });
    const { warnings, onWarning } = collected();
    const og = plate({ emoji, guards: { missingGlyphs: "warn", onWarning } });
    const { pixels } = await og.renderPixels({ title: "1️⃣ ❤️ #️⃣" });
    let drawn = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset]! > 200 && pixels[offset + 1]! < 60 && pixels[offset + 2]! < 60) drawn += 1;
    }
    expect(drawn).toBeGreaterThan(2 * 50 * 50);
    expect(requested).toEqual(expect.arrayContaining(["1️⃣", "❤️", "#️⃣"]));
    expect(requested).not.toContain("1⃣");
    expect(warnings).toEqual([expect.objectContaining({ guard: "missingGlyphs", languageCode: "emoji", segment: "#️⃣" })]);
  }, RENDER_TIMEOUT);

  it("reports emoji as missing glyphs without an emoji loader", async () => {
    const { warnings, onWarning } = collected();
    await plate({ guards: { missingGlyphs: "warn", onWarning } }).render({ title: "Shipped 🚀" });
    expect(warnings).toEqual([expect.objectContaining({ languageCode: "emoji", segment: "🚀" })]);
  }, RENDER_TIMEOUT);
});

describe("remote images", () => {
  afterEach(closeLocalServers);
  const png = readFileSync(path.join(root, "tests/fixtures/compare/card.png"));
  const image = (src: string): Child => ({ type: "img", props: { src, width: 200, height: 200 } });
  const background = (url: string): Child => ({
    type: "div",
    props: { style: { width: 200, height: 200, backgroundImage: `url(${url})`, backgroundSize: "100% 100%" } },
  });
  const refusal = (url: string) =>
    new RegExp(`metaplate/takumi does not fetch images: ${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*fetchImageLoader`);

  it.each([
    ["an img src", image],
    ["a CSS url() background", background],
  ])("refuses %s without making a request", async (_kind, child) => {
    const server = await localServer(serveBytes(png, "image/png"));
    const url = `${server.origin}/image.png`;
    const og = plate({ component: () => card([child(url)]) });
    await expect(og.render({ title: "x" })).rejects.toThrow(refusal(url));
    await expect(og.renderSvg({ title: "x" })).rejects.toThrow(refusal(url));
    expect(server.requests).toEqual([]);
  }, RENDER_TIMEOUT);

  it("refuses public and relative sources, and measures with the same policy", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const url of ["https://example.com/avatar.png", "/avatar.png"]) {
      const og = plate({ component: () => card([image(url)]), guards: { overflow: "warn", onWarning: () => {} } });
      await expect(og.render({ title: "x" })).rejects.toThrow(refusal(url));
    }
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  }, RENDER_TIMEOUT);

  it("draws data URIs, as an img src and as a CSS url()", async () => {
    const redSvg = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#ff0000"/></svg>');
    const redPng = await plate({ component: () => card([], { background: "#ff0000" }) }).render({ title: "x" });
    const og = plate({
      component: () => card([image(redSvg), background(`data:image/png;base64,${Buffer.from(redPng).toString("base64")}`)], { gap: 20 }),
    });
    const { pixels } = await og.renderPixels({ title: "x" });
    let drawn = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset]! > 200 && pixels[offset + 1]! < 60 && pixels[offset + 2]! < 60) drawn += 1;
    }
    // Two 200x200 boxes, each drawn red only if its image decoded.
    expect(drawn).toBeGreaterThan(2 * 190 * 190);
  }, RENDER_TIMEOUT);
});

const takumiBuild = entryBuilder("takumi");
afterAll(takumiBuild.remove);

// What Wrangler does with the entry: esbuild with the workerd import
// conditions. The bundle must carry Takumi's Wasm binding, not its native
// addon, and nothing from Satori, Resvg, or Node's built-ins.
it(
  "bundles for Cloudflare Workers with Takumi's Wasm build and no Node built-ins",
  async () => {
    const { build } = await import("esbuild");
    const { entry } = await takumiBuild.build();
    const consumer = `
      import { createTakumiOg } from ${JSON.stringify(entry.replaceAll("\\", "/"))};
      export default createTakumiOg({
        alt: (copy) => copy.title,
        fonts: () => [],
        component: (copy) => ({ type: "div", props: { children: copy.title } }),
      }).fetchableFrom(() => ({ title: "Workers" }));
    `;
    const result = await build({
      stdin: { contents: consumer, resolveDir: root, sourcefile: "takumi-consumer.js" },
      nodePaths: [path.join(root, "node_modules")],
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "browser",
      conditions: ["workerd", "worker", "browser"],
      external: ["*.wasm"],
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs).map((input) => input.replaceAll("\\", "/"));
    expect(inputs.some((input) => input.includes("node_modules/@takumi-rs/wasm/"))).toBe(true);
    expect(inputs.filter((input) => /node_modules\/(@takumi-rs\/core|satori|@resvg)\//.test(input))).toEqual([]);
    const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((entry) => entry.path));
    expect(imports.filter((specifier) => specifier.startsWith("node:"))).toEqual([]);
    expect(imports.some((specifier) => specifier.endsWith(".wasm"))).toBe(true);
  },
  60_000,
);
