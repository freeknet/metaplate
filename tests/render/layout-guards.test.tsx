import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { packageFontLoader } from "../../src/fonts.js";
import { assertRenderGuards, LAYOUT_GUARD_NAMES, RenderGuardError, safeAreaBox, type RenderGuardIssue } from "../../src/render/guards.js";
import { createNodeOg } from "../../src/node.js";
import { createSvgOg, type RenderGuards } from "../../src/render.js";

// Real renders load Satori and fonts; cold macOS and Windows runners exceed
// Vitest's five-second default.
const RENDER_TIMEOUT = 30_000;

const fonts = packageFontLoader([
  { name: "Inter", package: "@fontsource/inter", file: "files/inter-latin-700-normal.woff", weight: 700 },
]);

type Copy = { title: string };

/** A border-box card whose children are placed absolutely, so each test sets exact boxes. */
const card = (children: ReactNode) => (
  <div
    style={{
      boxSizing: "border-box",
      position: "relative",
      width: "100%",
      height: "100%",
      display: "flex",
      background: "#111111",
      color: "#ffffff",
      fontFamily: "Inter",
      fontSize: 40,
    }}
  >
    {children}
  </div>
);

/** A one-line text box at a fixed place, 48px tall at this font size. */
const text = (content: string, left: number, top: number, width = 400) => (
  <div key={content} style={{ display: "flex", position: "absolute", left, top, width, height: 48 }}>
    {content}
  </div>
);

async function issues(children: ReactNode, guards: RenderGuards): Promise<RenderGuardIssue[]> {
  const found: RenderGuardIssue[] = [];
  const plate = createSvgOg<Copy>({
    alt: (copy) => copy.title,
    fonts,
    component: () => card(children),
    guards: { ...guards, onWarning: (issue) => found.push(issue) },
  });
  await plate.renderSvg({ title: "card" });
  return found;
}

describe("safeAreaBox", () => {
  it("keeps what the centered 2:1 and 1.91:1 crops keep of a landscape canvas", () => {
    // 2:1 trims (630 - 600) / 2 from the top and bottom; 1.91:1 trims less.
    expect(safeAreaBox({ width: 1200, height: 630 }, "error")).toEqual({ left: 0, top: 15, width: 1200, height: 600 });
    // Wider than both crops: they trim the sides instead, 1.91:1 the most.
    const wide = safeAreaBox({ width: 1600, height: 600 }, "error");
    expect(wide.top).toBe(0);
    expect(wide.left).toBeCloseTo((1600 - 600 * 1.91) / 2);
    // Square and portrait canvases are not cropped to a wide ratio.
    expect(safeAreaBox({ width: 600, height: 600 }, "error")).toEqual({ left: 0, top: 0, width: 600, height: 600 });
  });

  it("uses an explicit inset instead", () => {
    expect(safeAreaBox({ width: 1200, height: 630 }, { level: "error", inset: 40 })).toEqual({ left: 40, top: 40, width: 1120, height: 550 });
    expect(safeAreaBox({ width: 1200, height: 630 }, { level: "error", inset: { x: 56, y: 44 } }))
      .toEqual({ left: 56, top: 44, width: 1088, height: 542 });
  });
});

describe("safeArea guard", () => {
  it(
    "reports text inside the canvas but in the strip X's 2:1 crop removes",
    async () => {
      const found = await issues([text("Headline", 80, 60), text("example.com", 80, 575)], { safeArea: "warn" });
      expect(found).toMatchObject([
        { guard: "safeArea", text: "example.com", box: { top: 575, height: 48 }, safeArea: { top: 15, height: 600 } },
      ]);
      expect(found[0]?.message).toContain("outside the safe area 0,15 1200x600 of the 1200x630 plate");
    },
    RENDER_TIMEOUT,
  );

  it(
    "checks an explicit inset and fails the render at error level",
    async () => {
      const plate = createSvgOg<Copy>({
        alt: (copy) => copy.title,
        fonts,
        component: () => card([text("Headline", 30, 100)]),
        guards: { safeArea: { level: "error", inset: { x: 56, y: 44 } } },
      });
      const error = await plate.renderSvg({ title: "card" }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(RenderGuardError);
      expect((error as RenderGuardError).issues).toMatchObject([{ guard: "safeArea", text: "Headline" }]);
    },
    RENDER_TIMEOUT,
  );
});

describe("textOverlap guard", () => {
  it(
    "reports two text boxes that intersect, once per pair",
    async () => {
      const found = await issues(
        [text("First line", 80, 100), text("Crowding line", 80, 130), text("Clear line", 80, 300)],
        { textOverlap: "warn" },
      );
      expect(found).toMatchObject([
        { guard: "textOverlap", text: "First line", other: { text: "Crowding line" } },
      ]);
    },
    RENDER_TIMEOUT,
  );

  it(
    "accepts boxes that only touch",
    async () => {
      expect(await issues([text("Upper", 80, 100), text("Lower", 80, 148)], { textOverlap: "warn" })).toEqual([]);
    },
    RENDER_TIMEOUT,
  );
});

describe("avoid guard", () => {
  const photo = (left: number) => (
    <div key="photo" style={{ display: "flex", position: "absolute", left, top: 0, width: 400, height: 630, background: "#336699" }} />
  );

  it(
    "reports text that runs under, or within the gap of, a keyed element",
    async () => {
      // The headline ends at x = 880; the photo starts at 800 (under it) or 900 (20px away).
      const under = await issues([photo(800), text("Headline", 80, 100, 800)], { avoid: { level: "warn", keys: ["photo"] } });
      expect(under).toMatchObject([
        { guard: "avoid", text: "Headline", avoided: { key: "photo", element: "div", box: { left: 800 } } },
      ]);
      const near = await issues([photo(900), text("Headline", 80, 100, 800)], { avoid: { level: "warn", keys: ["photo"], gap: 24 } });
      expect(near).toHaveLength(1);
      expect(near[0]?.message).toContain('within 24px of the element keyed "photo"');
      const clear = await issues([photo(900), text("Headline", 80, 100, 800)], { avoid: { level: "warn", keys: ["photo"], gap: 16 } });
      expect(clear).toEqual([]);
    },
    RENDER_TIMEOUT,
  );

  it(
    "does not report a keyed element's own text",
    async () => {
      const caption = (
        <div key="photo" style={{ display: "flex", position: "absolute", left: 800, top: 0, width: 400, height: 630 }}>
          Caption
        </div>
      );
      expect(await issues([caption], { avoid: { level: "warn", keys: ["photo"] } })).toEqual([]);
    },
    RENDER_TIMEOUT,
  );
});

describe("layout guard configuration", () => {
  it("validates the object forms", () => {
    const all = [...LAYOUT_GUARD_NAMES, "blank"] as const;
    expect(() => assertRenderGuards({ avoid: "error" }, all, "x")).toThrow("guards.avoid must be { level, keys, gap? }");
    expect(() => assertRenderGuards({ avoid: { level: "error", keys: [] } }, all, "x")).toThrow("guards.avoid.keys");
    expect(() => assertRenderGuards({ avoid: { level: "error", keys: ["photo"], gap: -1 } }, all, "x")).toThrow("guards.avoid.gap");
    expect(() => assertRenderGuards({ safeArea: { level: "fatal" } }, all, "x")).toThrow('guards.safeArea.level must be "error", "warn", or "off"');
    expect(() => assertRenderGuards({ safeArea: { level: "error", inset: { x: 10 } } }, all, "x")).toThrow("guards.safeArea.inset");
    expect(() => assertRenderGuards({ textOverlap: { level: "error" } }, all, "x")).toThrow('guards.textOverlap must be "error", "warn", or "off"');
    expect(() => assertRenderGuards({
      safeArea: { level: "warn", inset: 0 },
      textOverlap: "error",
      avoid: { level: "off", keys: [7, "photo"] },
    }, all, "x")).not.toThrow();
  });

  it(
    "runs in raster plates too, before anything is rasterised",
    async () => {
      const plate = createNodeOg<Copy>({
        alt: (copy) => copy.title,
        fonts,
        component: () => card([text("example.com", 80, 600)]),
        guards: { safeArea: "error" },
      });
      await expect(plate.render({ title: "card" })).rejects.toThrow(RenderGuardError);
    },
    RENDER_TIMEOUT,
  );
});
