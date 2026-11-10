import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { packageFontLoader } from "../../src/fonts.js";
import {
  assertRenderGuards,
  GuardReport,
  RenderGuardError,
  uniformColor,
  type RenderGuardIssue,
} from "../../src/render/guards.js";
import { createNextOg } from "../../src/next.js";
import { createNodeOg } from "../../src/node.js";
import { createSvgOg, type SatoriLayoutNode } from "../../src/render.js";

// Real renders load Satori, Resvg, and fonts; cold macOS and Windows runners
// exceed Vitest's five-second default.
const RENDER_TIMEOUT = 30_000;

const fonts = packageFontLoader([
  {
    name: "Inter",
    package: "@fontsource/inter",
    file: "files/inter-latin-700-normal.woff",
    weight: 700,
  },
]);

type Copy = { title: string };

const centered = (copy: Copy) => (
  <div
    style={{
      width: "100%",
      height: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#111111",
      color: "#ffffff",
      fontFamily: "Inter",
      fontSize: 64,
    }}
  >
    {copy.title}
  </div>
);

/**
 * The layout that shipped blank cards from this project's own Netlify Edge
 * deployment: a content-box root, 100% wide and tall, with padding, grows
 * past the canvas and draws a bottom-aligned one-line title below it.
 */
const contentBoxRoot = (copy: Copy) => (
  <div
    style={{
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      justifyContent: "flex-end",
      background: "#111111",
      color: "#ffffff",
      fontFamily: "Inter",
      fontSize: 72,
      padding: 120,
    }}
  >
    <div style={{ display: "flex" }}>{copy.title}</div>
  </div>
);

const base = {
  alt: (copy: Copy) => `${copy.title} card`,
  fonts,
};

afterEach(() => {
  vi.restoreAllMocks();
});

async function guardError(promise: Promise<unknown>): Promise<RenderGuardError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RenderGuardError);
  return error as RenderGuardError;
}

describe("uniformColor", () => {
  it("returns the color of a uniform pixmap", () => {
    const pixels = new Uint8Array(4 * 6).fill(0);
    for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([17, 17, 17, 255], offset);
    expect(uniformColor(pixels)).toEqual([17, 17, 17, 255]);
  });

  it("returns undefined as soon as one channel of one pixel differs", () => {
    for (const channel of [0, 1, 2, 3]) {
      const pixels = new Uint8Array(4 * 6).fill(200);
      pixels[4 * 5 + channel] = 201;
      expect(uniformColor(pixels)).toBeUndefined();
    }
  });

  it("treats every fully transparent pixel as the same color", () => {
    const pixels = new Uint8Array([0, 0, 0, 0, 255, 10, 20, 0, 3, 3, 3, 0]);
    expect(uniformColor(pixels)).toEqual([0, 0, 0, 0]);
    pixels[11] = 1;
    expect(uniformColor(pixels)).toBeUndefined();
  });

  it("reads a pixmap that is a view at an unaligned offset", () => {
    const backing = new Uint8Array(1 + 4 * 3).fill(9);
    backing[0] = 0;
    expect(uniformColor(backing.subarray(1))).toEqual([9, 9, 9, 9]);
  });

  it("treats a single pixel as uniform and an empty pixmap as not", () => {
    expect(uniformColor(new Uint8Array([1, 2, 3, 255]))).toEqual([1, 2, 3, 255]);
    expect(uniformColor(new Uint8Array(0))).toBeUndefined();
  });
});

describe("guard configuration", () => {
  it("rejects unknown levels, a non-object, and a non-function onWarning", () => {
    const all = ["missingGlyphs", "overflow", "blank"] as const;
    expect(() => assertRenderGuards({ overflow: "warning" }, all, "x")).toThrow(
      'guards.overflow must be "error", "warn", or "off"',
    );
    expect(() => assertRenderGuards({ blank: true }, all, "x")).toThrow(TypeError);
    expect(() => assertRenderGuards("error", all, "x")).toThrow("guards must be an object");
    expect(() => assertRenderGuards(null, all, "x")).toThrow("guards must be an object");
    expect(() => assertRenderGuards({ onWarning: "log" }, all, "x")).toThrow(
      "guards.onWarning must be a function",
    );
    expect(() => assertRenderGuards(undefined, all, "x")).not.toThrow();
    expect(() => assertRenderGuards({ missingGlyphs: "off", onWarning: () => {} }, all, "x")).not.toThrow();
  });

  it("rejects the blank guard on the SVG-only renderer at definition time", () => {
    expect(() =>
      createSvgOg({
        ...base,
        component: centered,
        guards: { blank: "error" } as never,
      }),
    ).toThrow("metaplate/render cannot run guards.blank");
    // Off is a no-op, so it is accepted anywhere.
    expect(() =>
      createSvgOg({ ...base, component: centered, guards: { blank: "off" } as never }),
    ).not.toThrow();
  });

  it("rejects guards on metaplate/next, whose ImageResponse exposes no hooks", () => {
    expect(() =>
      createNextOg({
        alt: () => "card",
        component: () => <div />,
        guards: { overflow: "error" } as never,
      }),
    ).toThrow("metaplate/next cannot run render guards");
  });

  it("rejects an invalid level on raster plates at definition time", () => {
    expect(() =>
      createNodeOg({ ...base, component: centered, guards: { blank: "fatal" } as never }),
    ).toThrow('guards.blank must be "error", "warn", or "off"');
  });
});

describe("GuardReport", () => {
  const issue = (message: string): RenderGuardIssue => ({
    guard: "blank",
    variant: undefined,
    size: { width: 1, height: 1 },
    color: [0, 0, 0, 0],
    message,
  });

  it("throws one error listing every error-level issue after warnings are reported", () => {
    const warnings: string[] = [];
    const report = new GuardReport({ blank: "error", onWarning: (warning) => warnings.push(warning.message) });
    report.add(issue("first"));
    report.add(issue("second"));
    report.add(issue("third"));
    let caught: unknown;
    try {
      report.settle();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RenderGuardError);
    const error = caught as RenderGuardError;
    expect(error.name).toBe("RenderGuardError");
    expect(error.message).toBe("first (and 2 more render guard issues)");
    expect(error.issues.map(({ message }) => message)).toEqual(["first", "second", "third"]);
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("drops issues of guards that are off and warns through console.warn by default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new GuardReport({ blank: "warn" }).add(issue("visible"));
    const quiet = new GuardReport({ blank: "off" });
    quiet.add(issue("dropped"));
    quiet.settle();
    const loud = new GuardReport({ blank: "warn" });
    loud.add(issue("visible"));
    loud.settle();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("metaplate: visible");
    // Settling twice reports nothing new.
    loud.settle();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("missingGlyphs guard", () => {
  it(
    "fails a render whose text no font or loader covers, naming the segment and language",
    async () => {
      const plate = createSvgOg({ ...base, component: centered, guards: { missingGlyphs: "error" } });
      const error = await guardError(plate.renderSvg({ title: "Hello 你好" }));
      expect(error.issues).toHaveLength(1);
      const [issue] = error.issues;
      expect(issue).toMatchObject({ guard: "missingGlyphs", segment: "你好", variant: undefined });
      expect(issue?.guard === "missingGlyphs" && issue.languageCode).toMatch(/zh|ja/);
      expect(error.message).toContain('no font or image for "你好"');
      expect(error.message).toContain("the 1200x630 plate");
    },
    RENDER_TIMEOUT,
  );

  it(
    "leaves covered text, and every render with the guard off, untouched",
    async () => {
      const guarded = createSvgOg({ ...base, component: centered, guards: { missingGlyphs: "error" } });
      const plain = createSvgOg({ ...base, component: centered });
      await expect(guarded.renderSvg({ title: "Latin only" })).resolves.toMatch(/^<svg/);
      // Off by default: the same uncovered text renders as before.
      expect(await plain.renderSvg({ title: "Hello 你好" })).toBe(
        await createSvgOg({ ...base, component: centered, guards: { missingGlyphs: "off" } }).renderSvg({
          title: "Hello 你好",
        }),
      );
    },
    RENDER_TIMEOUT,
  );

  it(
    "warns through onWarning and still returns the image",
    async () => {
      const warnings: RenderGuardIssue[] = [];
      const plate = createSvgOg({
        ...base,
        component: centered,
        guards: { missingGlyphs: "warn", onWarning: (warning) => warnings.push(warning) },
      });
      await expect(plate.renderSvg({ title: "Hello 你好" })).resolves.toMatch(/^<svg/);
      expect(warnings).toMatchObject([{ guard: "missingGlyphs", segment: "你好" }]);
    },
    RENDER_TIMEOUT,
  );

  it(
    "keeps the caller's loadAdditionalAsset and trusts the fonts it returns",
    async () => {
      const inter = await fonts();
      const loadAdditionalAsset = vi.fn(async () => [...inter]);
      const plate = createSvgOg({
        ...base,
        component: centered,
        satori: { loadAdditionalAsset },
        guards: { missingGlyphs: "error" },
      });
      await expect(plate.renderSvg({ title: "Hello 你好" })).resolves.toMatch(/^<svg/);
      expect(loadAdditionalAsset).toHaveBeenCalledWith(expect.stringMatching(/zh|ja/), "你好");

      const empty = createSvgOg({
        ...base,
        component: centered,
        satori: { loadAdditionalAsset: async () => [] },
        guards: { missingGlyphs: "error" },
      });
      await guardError(empty.renderSvg({ title: "Hello 你好" }));
    },
    RENDER_TIMEOUT,
  );

  it(
    "reports emoji without an image and accepts emoji the plate draws",
    async () => {
      const unguarded = createSvgOg({ ...base, component: centered, guards: { missingGlyphs: "error" } });
      const error = await guardError(unguarded.renderSvg({ title: "Hi 👋" }));
      expect(error.issues).toMatchObject([{ guard: "missingGlyphs", languageCode: "emoji", segment: "👋" }]);
      expect(error.message).toContain("set the plate's emoji option");

      const image = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
      const withLoader = createSvgOg({
        ...base,
        component: centered,
        emoji: async () => image,
        guards: { missingGlyphs: "error" },
      });
      await expect(withLoader.renderSvg({ title: "Hi 👋" })).resolves.toMatch(/^<svg/);

      // An emoji loader with no image for the grapheme leaves it missing.
      const noImage = createSvgOg({
        ...base,
        component: centered,
        emoji: async () => undefined,
        guards: { missingGlyphs: "error" },
      });
      await guardError(noImage.renderSvg({ title: "Hi 👋" }));

      // Satori draws graphemeImages itself, although it still asks for them.
      const grapheme = createSvgOg({
        ...base,
        component: centered,
        satori: { graphemeImages: { "👋": image } },
        guards: { missingGlyphs: "error" },
      });
      await expect(grapheme.renderSvg({ title: "Hi 👋" })).resolves.toMatch(/^<svg/);
    },
    RENDER_TIMEOUT,
  );
});

describe("overflow guard", () => {
  it(
    "fails text laid out past the canvas by a content-box root with padding",
    async () => {
      const plate = createSvgOg({ ...base, component: contentBoxRoot, guards: { overflow: "error" } });
      const error = await guardError(plate.renderSvg({ title: "Gone" }));
      expect(error.issues).toHaveLength(1);
      const [issue] = error.issues;
      expect(issue).toMatchObject({ guard: "overflow", element: "div", text: "Gone" });
      if (issue?.guard !== "overflow") throw new Error("expected an overflow issue");
      expect(issue.box.top + issue.box.height).toBeGreaterThan(630);
      expect(error.message).toContain('boxSizing: "border-box"');
    },
    RENDER_TIMEOUT,
  );

  it(
    "says text does not fit, not border-box, when a border-box root holds a title too long for it",
    async () => {
      const component = (copy: Copy) => (
        <div
          style={{
            boxSizing: "border-box",
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            padding: 56,
            background: "#111111",
            color: "#ffffff",
            fontFamily: "Inter",
          }}
        >
          <div style={{ display: "flex", fontSize: 30 }}>TOP LABEL</div>
          <div style={{ display: "flex", fontSize: 54, lineHeight: 1.1 }}>{copy.title}</div>
          <div style={{ display: "flex", fontSize: 30 }}>FOOT LABEL</div>
        </div>
      );
      const plate = createSvgOg({ ...base, component, guards: { overflow: "error" } });
      const error = await guardError(plate.renderSvg({ title: "A long card title that goes on ".repeat(60) }));
      expect(error.message).toContain("the text needs more room than its container has");
      expect(error.message).not.toContain("border-box");
    },
    RENDER_TIMEOUT,
  );

  it(
    "accepts the same layout with border-box, and bleeding elements that hold no text",
    async () => {
      const component = (copy: Copy) => (
        <div
          style={{
            boxSizing: "border-box",
            position: "relative",
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            background: "#111111",
            color: "#ffffff",
            fontFamily: "Inter",
            fontSize: 72,
            padding: 120,
          }}
        >
          <div
            style={{
              position: "absolute",
              left: -200,
              top: -200,
              width: 600,
              height: 600,
              borderRadius: 300,
              background: "#333333",
            }}
          />
          <div style={{ display: "flex" }}>{copy.title}</div>
        </div>
      );
      const detected: SatoriLayoutNode[] = [];
      const plate = createSvgOg({
        ...base,
        component,
        satori: { onNodeDetected: (node) => detected.push(node) },
        guards: { overflow: "error" },
      });
      await expect(plate.renderSvg({ title: "Visible" })).resolves.toMatch(/^<svg/);
      // The caller's own onNodeDetected still sees every node.
      expect(detected.some((node) => node.textContent === "Visible")).toBe(true);
      expect(detected.some((node) => node.left === -200)).toBe(true);
    },
    RENDER_TIMEOUT,
  );

  it(
    "names the variant and checks against that variant's canvas",
    async () => {
      const warnings: RenderGuardIssue[] = [];
      const plate = createSvgOg({
        ...base,
        component: (copy: Copy, { size }) => (
          <div
            style={{
              boxSizing: "border-box",
              width: "100%",
              height: "100%",
              display: "flex",
              background: "#111111",
              color: "#ffffff",
              fontFamily: "Inter",
              fontSize: 64,
            }}
          >
            <div style={{ display: "flex", position: "absolute", left: size.width - 100, top: 10 }}>
              {copy.title}
            </div>
          </div>
        ),
        variants: { square: { size: { width: 600, height: 600 } } },
        guards: { overflow: "warn", onWarning: (warning) => warnings.push(warning) },
      });
      await plate.variant("square").renderSvg({ title: "Right edge" });
      expect(warnings).toMatchObject([
        { guard: "overflow", variant: "square", size: { width: 600, height: 600 }, text: "Right edge" },
      ]);
      expect(warnings[0]?.message).toContain('variant "square" (600x600)');
    },
    RENDER_TIMEOUT,
  );
});

describe("blank guard", () => {
  it(
    "fails a raster render whose every pixel is one color, before encoding",
    async () => {
      const encode = vi.fn(() => new Uint8Array([1]));
      const plate = createNodeOg({
        ...base,
        component: contentBoxRoot,
        output: { contentType: "image/x-test", checkSignature: false, encode },
        guards: { blank: "error" },
      });
      const error = await guardError(plate.render({ title: "Gone" }));
      expect(error.issues).toMatchObject([{ guard: "blank", color: [17, 17, 17, 255] }]);
      expect(error.message).toContain("every pixel of the 1200x630 plate is rgba(17, 17, 17, 1)");
      expect(encode).not.toHaveBeenCalled();
      await guardError(plate.renderPixels({ title: "Gone" }));
      await guardError(plate.response({ title: "Gone" }));
    },
    RENDER_TIMEOUT,
  );

  it(
    "reports blank and overflow together when both are warnings, and passes a drawn card",
    async () => {
      const warnings: RenderGuardIssue[] = [];
      const guards = {
        blank: "warn",
        overflow: "warn",
        missingGlyphs: "warn",
        onWarning: (warning: RenderGuardIssue) => warnings.push(warning),
      } as const;
      const broken = createNodeOg({ ...base, component: contentBoxRoot, guards });
      const png = await broken.render({ title: "Gone" });
      expect(png.byteLength).toBeGreaterThan(0);
      expect(warnings.map(({ guard }) => guard)).toEqual(["overflow", "blank"]);

      warnings.length = 0;
      const drawn = createNodeOg({ ...base, component: centered, guards });
      await drawn.render({ title: "Drawn" });
      expect(warnings).toEqual([]);
    },
    RENDER_TIMEOUT,
  );

  it(
    "runs on metaplate/edge through the Wasm renderer",
    async () => {
      vi.resetModules();
      const { createEdgeOg } = await import("../../src/edge.js");
      const installed = (...segments: string[]) =>
        readFileSync(path.join(import.meta.dirname, "../..", "node_modules", ...segments));
      const plate = createEdgeOg({
        ...base,
        component: contentBoxRoot,
        resvg: { wasm: installed("@resvg", "resvg-wasm", "index_bg.wasm") },
        layout: { wasm: installed("satori", "layout.wasm") },
        guards: { blank: "error" },
      });
      const error = (await plate.render({ title: "Gone" }).catch((reason: unknown) => reason)) as Error;
      // A fresh module graph has its own RenderGuardError class.
      expect(error.name).toBe("RenderGuardError");
      expect(error.message).toContain("Blank render");
    },
    RENDER_TIMEOUT,
  );
});
