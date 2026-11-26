import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fontLoader } from "../../src/font-data.js";
import { compareImages, createNodeOg } from "../../src/node.js";
import { createTakumiOg } from "../../src/takumi.js";
import { fixture } from "../helpers/image-fixtures.js";

// Satori and Takumi draw the same plates through metaplate's two adapters, and
// each fixture's difference must stay inside its budget. The fixtures come from
// the Takumi backend spike (.planning/spikes/005-takumi-backend), minus the
// ones that need Japanese, Arabic, or twemoji packages; emoji and language
// fonts have their own tests in takumi.test.ts. A Takumi (or Satori) bump that
// moves layout fails here before it merges.
//
// The budget is the share of pixels whose largest channel moves by more than
// 64/255, which leaves out most glyph anti-aliasing: resvg and Takumi
// rasterise glyphs differently on every card with text. Budgets sit above the
// measured value with headroom for platform rasteriser noise, not for layout
// changes. To see a failing fixture, render both sides and diff them with
// `metaplate verify --baseline <satori-dir> --write-diff <out>`. Set
// PARITY_REPORT=1 (with `--silent=false`) to print every measured share, and
// re-derive budgets from them after reviewing a bump that moves them: about
// 1.5x the measured share, and at least 0.005 above it.

const RENDER_TIMEOUT = 30_000;
const THRESHOLD = 64;

const root = path.join(import.meta.dirname, "../..");
const inter = (weight: 400 | 700, extension: "woff" | "woff2") =>
  readFileSync(path.join(root, "node_modules/@fontsource/inter/files", `inter-latin-${weight}-normal.${extension}`));
const faces = (extension: "woff" | "woff2") =>
  fontLoader([400, 700].map((weight) => ({ name: "Inter", weight: weight as 400 | 700, data: inter(weight as 400 | 700, extension) })));

type Tree = { type: string; props: Record<string, unknown> };
type Size = { width: number; height: number };

const h = (type: string, style: Record<string, unknown>, children: unknown, extra: Record<string, unknown> = {}): Tree => ({
  type,
  props: { style, children, ...extra },
});
const card = (style: Record<string, unknown>, children: unknown) =>
  h("div", { boxSizing: "border-box", width: "100%", height: "100%", fontFamily: "Inter", ...style }, children);
const dataUri = (bytes: Uint8Array, mime: string) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

/** The Cloudflare Workers example card. */
const reproCard = (title: string) =>
  card(
    { display: "flex", alignItems: "flex-end", padding: 64, background: "#1e1b4b", color: "#eef2ff", fontSize: 60, fontWeight: 700 },
    `${title} · metaplate/takumi on Cloudflare Workers`,
  );

const LONG =
  "Typed social-image contracts for TypeScript: rendering, metadata, routes, and verification, with guards that stop a broken card from shipping to production on a Friday";

type Fixture = { name: string; tree: () => Tree; size?: Size; budget: number };

let photo = "";
const jpeg = dataUri(fixture("card.jpg"), "image/jpeg");

const fixtures: Fixture[] = [
  { name: "repro card", tree: () => reproCard("Hello"), budget: 0.015 },
  {
    name: "block layout without display",
    tree: () =>
      h("div", { width: "100%", height: "100%", background: "#fef3c7", color: "#78350f", fontFamily: "Inter", fontSize: 48, padding: 48, boxSizing: "border-box" }, [
        h("div", { fontWeight: 700 }, "First block child"),
        h("div", { fontWeight: 400, marginTop: 24 }, "Second block child stacks below the first one"),
      ]),
    budget: 0.015,
  },
  {
    name: "typography",
    tree: () =>
      card({ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", padding: 64, background: "#fff", color: "#0f172a" }, [
        h("div", { fontSize: 28, fontWeight: 700, letterSpacing: 6, textTransform: "uppercase", color: "rgba(15,23,42,0.6)" }, "metaplate release notes"),
        h("div", { fontSize: 72, fontWeight: 700, lineHeight: 1.05, textAlign: "center", marginTop: 24 }, "Weights, tracking, and centered wrapping text"),
        h("div", { fontSize: 32, fontWeight: 400, marginTop: 24, textDecoration: "underline" }, "Regular 400 with underline"),
      ]),
    budget: 0.008,
  },
  {
    name: "unknown font family",
    tree: () =>
      card({ display: "flex", alignItems: "center", padding: 64, background: "#ecfeff", color: "#164e63", fontFamily: "Nonexistent Sans", fontSize: 64, fontWeight: 700 }, "Unknown family falls back"),
    budget: 0.005,
  },
  {
    name: "missing glyphs",
    tree: () =>
      card({ display: "flex", alignItems: "center", padding: 72, background: "#fdf2f8", color: "#831843", fontSize: 72, fontWeight: 700 }, "Hello 한국어 world"),
    budget: 0.005,
  },
  {
    // Satori shrinks the 480px image to fit the row; Takumi keeps its width.
    name: "PNG and JPEG images",
    tree: () =>
      card({ display: "flex", alignItems: "center", gap: 48, padding: 64, background: "#18181b", color: "#fafafa", fontSize: 40, fontWeight: 700 }, [
        { type: "img", props: { src: photo, width: 480, height: 252, style: { borderRadius: 24 } } },
        { type: "img", props: { src: jpeg, width: 300, height: 300, style: { objectFit: "cover", borderRadius: 150 } } },
        h("div", { display: "flex" }, "PNG + JPEG"),
      ]),
    budget: 0.025,
  },
  {
    name: "gradients",
    tree: () =>
      card({ display: "flex", alignItems: "flex-end", padding: 64, backgroundImage: "linear-gradient(135deg, #6366f1 0%, #ec4899 50%, #f59e0b 100%)", color: "#fff", fontSize: 64, fontWeight: 700 }, [
        h("div", { width: 240, height: 240, borderRadius: 120, backgroundImage: "radial-gradient(circle at 30% 30%, #ffffff, #1e3a8a)", marginRight: 48 }, []),
        h("div", { display: "flex" }, "Linear + radial"),
      ]),
    budget: 0.005,
  },
  {
    name: "inset and absolute positioning",
    tree: () =>
      card({ display: "flex", position: "relative", background: "#0c0a09", color: "#fafaf9", fontSize: 56, fontWeight: 700 }, [
        h("div", { position: "absolute", inset: 40, border: "6px solid #f97316", borderRadius: 32 }, []),
        h("div", { position: "absolute", top: 120, left: 120, right: 120, display: "flex" }, "Absolutely positioned with inset"),
        h("div", { position: "absolute", bottom: 80, right: 80, fontSize: 28, color: "#a8a29e" }, "bottom/right corner"),
      ]),
    budget: 0.01,
  },
  {
    name: "line clamp",
    tree: () =>
      card({ display: "flex", flexDirection: "column", justifyContent: "center", padding: 72, background: "#111", color: "#fff" }, [
        h("div", { display: "block", lineClamp: 2, fontSize: 60, fontWeight: 700, lineHeight: 1.1 }, LONG),
      ]),
    budget: 0.005,
  },
  {
    name: "text-overflow ellipsis",
    tree: () =>
      card({ display: "flex", flexDirection: "column", justifyContent: "center", padding: 72, background: "#f8fafc", color: "#0f172a" }, [
        h("div", { display: "block", width: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 56, fontWeight: 700 }, LONG),
      ]),
    budget: 0.008,
  },
  {
    // Same seven lines; their positions drift a few pixels.
    name: "unclamped overflow",
    tree: () =>
      card({ display: "flex", flexDirection: "column", justifyContent: "center", padding: 72, background: "#111", color: "#fff" }, [
        h("div", { fontSize: 76, fontWeight: 700, lineHeight: 1.1 }, LONG),
      ]),
    budget: 0.035,
  },
  {
    // Without boxSizing, Satori draws the box 708px wide (content-box) and
    // Takumi 700px (border-box); Satori's shadow is softer.
    name: "borders and shadows",
    tree: () =>
      card({ display: "flex", alignItems: "center", justifyContent: "center", background: "#e2e8f0" }, [
        h("div", { display: "flex", alignItems: "center", justifyContent: "center", width: 700, height: 340, background: "#fff", border: "4px dashed #0ea5e9", borderRadius: 40, boxShadow: "0 20px 40px rgba(15,23,42,0.35)", fontSize: 48, fontWeight: 700, color: "#0369a1", opacity: 0.9 }, "Border, radius, shadow"),
      ]),
    budget: 0.027,
  },
  {
    name: "flex space-between, wrap, gap, and rotate",
    tree: () =>
      card({ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, background: "#fafaf9", color: "#1c1917" }, [
        h("div", { display: "flex", justifyContent: "space-between", fontSize: 32, fontWeight: 700 }, [h("div", {}, "metaplate"), h("div", {}, "2026-11-20")]),
        h("div", { display: "flex", flexWrap: "wrap", gap: 16 }, ["satori", "takumi", "resvg", "workerd", "wasm", "fonts", "emoji"].map((tag) =>
          h("div", { padding: "8px 20px", borderRadius: 999, background: "#1c1917", color: "#fafaf9", fontSize: 28, fontWeight: 400 }, tag))),
        h("div", { fontSize: 64, fontWeight: 700, transform: "rotate(-2deg)" }, "Space-between, wrap, gap, rotate"),
      ]),
    budget: 0.015,
  },
  { name: "X card 1200x600", tree: () => reproCard("X card"), size: { width: 1200, height: 600 }, budget: 0.017 },
  { name: "square 1080x1080", tree: () => reproCard("Square"), size: { width: 1080, height: 1080 }, budget: 0.012 },
  { name: "portrait 1080x1920", tree: () => reproCard("Portrait"), size: { width: 1080, height: 1920 }, budget: 0.008 },
];

function plates(tree: () => Tree, size?: Size) {
  const shared = { alt: () => "parity", component: tree, ...(size ? { size } : {}) };
  return {
    satori: createNodeOg<Record<string, never>>({ ...shared, fonts: faces("woff") }),
    takumi: createTakumiOg<Record<string, never>>({ ...shared, fonts: faces("woff2") }),
  };
}

beforeAll(async () => {
  // A valid photographic PNG for the image fixture, drawn by resvg.
  const png = await createNodeOg<Record<string, never>>({
    alt: () => "photo",
    size: { width: 480, height: 252 },
    fonts: faces("woff"),
    component: () =>
      h("div", { display: "flex", width: "100%", height: "100%", backgroundImage: "linear-gradient(160deg, #0ea5e9, #22c55e 60%, #facc15)" }, [
        h("div", { position: "absolute", left: 300, top: 40, width: 120, height: 120, borderRadius: 60, background: "#fff7ed" }, []),
      ]),
  }).render({});
  photo = dataUri(png, "image/png");
}, RENDER_TIMEOUT);

describe("Satori and Takumi parity", () => {
  it.each(fixtures)("draws $name within $budget of Satori", async ({ name, tree, size, budget }) => {
    const { satori, takumi } = plates(tree, size);
    const [expected, actual] = await Promise.all([satori.render({}), takumi.render({})]);
    const result = compareImages(expected, actual, { threshold: THRESHOLD });
    if (process.env.PARITY_REPORT) console.log(`PARITY ${name}: ${result.changedRatio.toFixed(4)} / ${budget}`);
    expect(result.sameSize).toBe(true);
    expect(result.changedRatio).toBeLessThanOrEqual(budget);
  }, RENDER_TIMEOUT);

  // A documented difference: resvg draws the rows a truncated PNG holds, and
  // Takumi refuses the render. If Takumi starts drawing it, docs/takumi.md
  // needs updating.
  it("refuses a truncated PNG that Satori draws in part", async () => {
    const tree = () =>
      card({ display: "flex", padding: 64, background: "#18181b" }, [
        { type: "img", props: { src: dataUri(fixture("card.png"), "image/png"), width: 600, height: 315 } },
      ]);
    const { satori, takumi } = plates(tree);
    await expect(satori.render({})).resolves.toBeInstanceOf(Uint8Array);
    await expect(takumi.render({})).rejects.toThrow(/PNG|decod/i);
  }, RENDER_TIMEOUT);
});
