// Shared { type, props } trees rendered by both metaplate/node (Satori+resvg) and takumi-js.
import { readFileSync } from "node:fs";
import { URL } from "node:url";

const h = (type, style, children, extra = {}) => ({ type, props: { style, children, ...extra } });
const dataUri = (file, mime) => `data:${mime};base64,${readFileSync(new URL(file, import.meta.url)).toString("base64")}`;
// photo.png is drawn by run.mjs with resvg-js; card.jpg and card-truncated.png are
// tests/fixtures/card.jpg and tests/fixtures/card.png copied by run.mjs.
const PNG = dataUri("./photo.png", "image/png");
const TRUNCATED = dataUri("./card-truncated.png", "image/png");
const JPG = dataUri("./card.jpg", "image/jpeg");

const root = (style, children) =>
  h("div", { boxSizing: "border-box", width: "100%", height: "100%", fontFamily: "Inter", ...style }, children);

/** The Cloudflare repro card (examples/hosted/cloudflare/worker). */
const reproCard = (title) =>
  root(
    { display: "flex", alignItems: "flex-end", padding: 64, background: "#1e1b4b", color: "#eef2ff", fontSize: 60, fontWeight: 700 },
    `${title} · metaplate/edge on Cloudflare Workers`,
  );

/** examples/api/long-titles.tsx: flex column, clamped block title. */
const longTitle = (title, clamp) =>
  root(
    { display: "flex", flexDirection: "column", justifyContent: "center", padding: 72, background: "#111", color: "#fff" },
    [h("div", { display: "block", lineClamp: clamp, fontSize: 60, fontWeight: 700, lineHeight: 1.1 }, title)],
  );

const LONG =
  "Typed social-image contracts for TypeScript: rendering, metadata, routes, and verification, with guards that stop a broken card from shipping to production on a Friday";

export const fixtures = [
  { name: "repro-card", tree: reproCard("Hello") },
  {
    name: "block-default",
    // No display set anywhere: both Satori 0.63 and Takumi default a bare div to block.
    tree: h("div", { width: "100%", height: "100%", background: "#fef3c7", color: "#78350f", fontFamily: "Inter", fontSize: 48, padding: 48, boxSizing: "border-box" }, [
      h("div", { fontWeight: 700 }, "First block child"),
      h("div", { fontWeight: 400, marginTop: 24 }, "Second block child stacks below the first one"),
    ]),
  },
  {
    name: "typography",
    tree: root({ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", padding: 64, background: "#fff", color: "#0f172a" }, [
      h("div", { fontSize: 28, fontWeight: 700, letterSpacing: 6, textTransform: "uppercase", color: "rgba(15,23,42,0.6)" }, "metaplate release notes"),
      h("div", { fontSize: 72, fontWeight: 700, lineHeight: 1.05, textAlign: "center", marginTop: 24 }, "Weights, tracking, and centered wrapping text"),
      h("div", { fontSize: 32, fontWeight: 400, marginTop: 24, textDecoration: "underline" }, "Regular 400 with underline"),
    ]),
  },
  {
    name: "fallback-family",
    // fontFamily names a face that is not loaded; both engines should fall back.
    tree: root({ display: "flex", alignItems: "center", padding: 64, background: "#ecfeff", color: "#164e63", fontFamily: "Nonexistent Sans", fontSize: 64, fontWeight: 700 }, "Unknown family falls back"),
  },
  {
    name: "cjk",
    tree: root({ display: "flex", flexDirection: "column", justifyContent: "center", padding: 72, background: "#fff7ed", color: "#7c2d12" }, [
      h("div", { fontSize: 72, fontWeight: 700, lineHeight: 1.2 }, "日本語のタイトル：画像を生成する"),
      h("div", { fontSize: 36, fontWeight: 700, marginTop: 24 }, "Latin and 漢字 mixed in one line"),
    ]),
  },
  {
    name: "arabic-rtl",
    tree: root({ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-end", padding: 72, background: "#f0fdf4", color: "#14532d" }, [
      h("div", { fontSize: 72, fontWeight: 700, direction: "rtl", textAlign: "right" }, "مرحبا بالعالم"),
      h("div", { fontSize: 40, fontWeight: 700, marginTop: 24, direction: "rtl", textAlign: "right" }, "صورة اجتماعية للموقع 2026"),
    ]),
  },
  {
    name: "emoji",
    tree: root({ display: "flex", alignItems: "center", padding: 72, background: "#eef2ff", color: "#312e81", fontSize: 80, fontWeight: 700 }, "Shipped 🚀 🎉 👋🏽"),
  },
  {
    name: "missing-glyphs",
    // Korean with no Korean font loaded: tofu or nothing, depending on the engine.
    tree: root({ display: "flex", alignItems: "center", padding: 72, background: "#fdf2f8", color: "#831843", fontSize: 72, fontWeight: 700 }, "Hello 한국어 world"),
  },
  {
    name: "images",
    tree: root({ display: "flex", alignItems: "center", gap: 48, padding: 64, background: "#18181b", color: "#fafafa", fontSize: 40, fontWeight: 700 }, [
      { type: "img", props: { src: PNG, width: 480, height: 252, style: { borderRadius: 24 } } },
      { type: "img", props: { src: JPG, width: 300, height: 300, style: { objectFit: "cover", borderRadius: 150 } } },
      h("div", { display: "flex" }, "PNG + JPEG"),
    ]),
  },
  {
    name: "image-truncated-png",
    // tests/fixtures/card.png: IDAT holds 75% of the pixel rows.
    tree: root({ display: "flex", padding: 64, background: "#18181b" }, [{ type: "img", props: { src: TRUNCATED, width: 600, height: 315 } }]),
  },
  {
    name: "gradients",
    tree: root({ display: "flex", alignItems: "flex-end", padding: 64, backgroundImage: "linear-gradient(135deg, #6366f1 0%, #ec4899 50%, #f59e0b 100%)", color: "#fff", fontSize: 64, fontWeight: 700 }, [
      h("div", { width: 240, height: 240, borderRadius: 120, backgroundImage: "radial-gradient(circle at 30% 30%, #ffffff, #1e3a8a)", marginRight: 48 }, []),
      h("div", { display: "flex" }, "Linear + radial"),
    ]),
  },
  {
    name: "inset-absolute",
    tree: root({ display: "flex", position: "relative", background: "#0c0a09", color: "#fafaf9", fontSize: 56, fontWeight: 700 }, [
      h("div", { position: "absolute", inset: 40, border: "6px solid #f97316", borderRadius: 32 }, []),
      h("div", { position: "absolute", top: 120, left: 120, right: 120, display: "flex" }, "Absolutely positioned with inset"),
      h("div", { position: "absolute", bottom: 80, right: 80, fontSize: 28, color: "#a8a29e" }, "bottom/right corner"),
    ]),
  },
  { name: "line-clamp", tree: longTitle(LONG, 2) },
  {
    name: "text-overflow-ellipsis",
    tree: root({ display: "flex", flexDirection: "column", justifyContent: "center", padding: 72, background: "#f8fafc", color: "#0f172a" }, [
      h("div", { display: "block", width: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 56, fontWeight: 700 }, LONG),
    ]),
  },
  {
    name: "unclamped-overflow",
    // Long title with no clamp: overflows the card (what the overflow guard catches).
    tree: root({ display: "flex", flexDirection: "column", justifyContent: "center", padding: 72, background: "#111", color: "#fff" }, [
      h("div", { fontSize: 76, fontWeight: 700, lineHeight: 1.1 }, LONG),
    ]),
  },
  {
    name: "borders-shadows",
    tree: root({ display: "flex", alignItems: "center", justifyContent: "center", background: "#e2e8f0" }, [
      h("div", { display: "flex", alignItems: "center", justifyContent: "center", width: 700, height: 340, background: "#fff", border: "4px dashed #0ea5e9", borderRadius: 40, boxShadow: "0 20px 40px rgba(15,23,42,0.35)", fontSize: 48, fontWeight: 700, color: "#0369a1", opacity: 0.9 }, "Border, radius, shadow"),
    ]),
  },
  {
    name: "flex-layout",
    tree: root({ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, background: "#fafaf9", color: "#1c1917" }, [
      h("div", { display: "flex", justifyContent: "space-between", fontSize: 32, fontWeight: 700 }, [h("div", {}, "metaplate"), h("div", {}, "2026-11-20")]),
      h("div", { display: "flex", flexWrap: "wrap", gap: 16 }, ["satori", "takumi", "resvg", "workerd", "wasm", "fonts", "emoji"].map((tag) =>
        h("div", { padding: "8px 20px", borderRadius: 999, background: "#1c1917", color: "#fafaf9", fontSize: 28, fontWeight: 400 }, tag))),
      h("div", { fontSize: 64, fontWeight: 700, transform: "rotate(-2deg)" }, "Space-between, wrap, gap, rotate"),
    ]),
  },
  { name: "size-twitter-1200x600", tree: reproCard("X card"), size: { width: 1200, height: 600 } },
  { name: "size-square-1080", tree: reproCard("Square"), size: { width: 1080, height: 1080 } },
  { name: "size-portrait-1080x1920", tree: reproCard("Portrait"), size: { width: 1080, height: 1920 } },
];
