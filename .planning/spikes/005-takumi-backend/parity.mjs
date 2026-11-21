// Usage (inside the consumer run.mjs creates): node parity.mjs <wasm|native>
// Renders every fixture with metaplate/node and takumi-js, compares with metaplate's compareImages.
// takumi-js caches its backend per process, so Wasm and native run in separate processes.
import console from "node:console";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { createNodeOg, compareImages } from "metaplate/node";
import { fontLoader } from "metaplate/font-data";
import { packageEmojiLoader, fontsourceLanguageFontLoader } from "metaplate/fonts";
import { render, measure } from "takumi-js";
import { fixtures } from "./fixtures.mjs";

const backend = process.argv[2] ?? "wasm";
const { Response } = globalThis;
const pkgDir = (name) => fileURLToPath(new URL(`./node_modules/${name}/`, import.meta.url));
const file = (name, rel) => readFileSync(pkgDir(name) + rel);

// ---- fonts: same faces for both engines (WOFF for Satori, WOFF2 for Takumi) ----
const codepoints = new Set();
for (const f of fixtures) JSON.stringify(f.tree, (k, v) => (typeof v === "string" && !v.startsWith("data:") && [...v].forEach((c) => codepoints.add(c.codePointAt(0))), v));

function parseRanges(text) {
  return text.split(",").map((part) => {
    const [a, b] = part.trim().replace(/^U\+/i, "").split("-");
    return [parseInt(a, 16), parseInt(b ?? a, 16)];
  });
}
const jpMap = JSON.parse(file("@fontsource/noto-sans-jp", "unicode.json"));
const jpSubsets = Object.entries(jpMap)
  .map(([key, range]) => ({ id: key.replace(/[[\]]/g, ""), ranges: parseRanges(range) }))
  .filter(({ ranges, id }) => !["latin", "latin-ext", "cyrillic", "vietnamese"].includes(id) && [...codepoints].some((cp) => cp > 0x2000 && ranges.some(([a, b]) => cp >= a && cp <= b)));

const faces = [
  { name: "Inter", weight: 400, pkg: "@fontsource/inter", base: "files/inter-latin-400-normal" },
  { name: "Inter", weight: 700, pkg: "@fontsource/inter", base: "files/inter-latin-700-normal" },
  ...jpSubsets.map(({ id, ranges }) => ({ name: "Noto Sans JP", weight: 700, pkg: "@fontsource/noto-sans-jp", base: `files/noto-sans-jp-${id}-700-normal`, ranges })),
  { name: "Noto Sans Arabic", weight: 700, pkg: "@fontsource/noto-sans-arabic", base: "files/noto-sans-arabic-arabic-700-normal", ranges: parseRanges(JSON.parse(file("@fontsource/noto-sans-arabic", "unicode.json")).arabic) },
];
const satoriFonts = faces.filter((f) => f.name === "Inter").map((f) => ({ name: f.name, weight: f.weight, data: file(f.pkg, `${f.base}.woff`) }));
const takumiFonts = faces.map((f) => ({ name: f.name, weight: f.weight, data: file(f.pkg, `${f.base}.woff2`), ...(f.ranges ? { unicodeRange: f.ranges } : {}) }));

// ---- Takumi emoji: map its CDN twemoji URLs onto the same local @twemoji/svg files metaplate uses ----
const twemojiDir = pkgDir("@twemoji/svg");
const localFetch = async (url) => {
  const name = String(url).split("/").pop();
  const path = twemojiDir + name;
  if (!existsSync(path)) return new Response("missing", { status: 404 });
  return new Response(readFileSync(path), { headers: { "content-type": "image/svg+xml" } });
};
const wasmModule = backend === "wasm" ? file("@takumi-rs/wasm", "pkg/takumi_wasm_bg.wasm") : undefined;
const takumiOptions = (size) => ({
  ...size,
  fonts: takumiFonts,
  emoji: "twemoji",
  images: { fetch: localFetch },
  ...(wasmModule ? { module: wasmModule } : {}),
});

const out = new URL(`./out/`, import.meta.url);
const dirs = { satori: new URL("satori/", out), takumi: new URL(`takumi-${backend}/`, out), diff: new URL(`diff-${backend}/`, out), measure: new URL("measure/", out) };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

const results = [];
for (const fixture of fixtures) {
  const size = fixture.size ?? { width: 1200, height: 630 };
  const row = { name: fixture.name, size };
  // Satori via metaplate/node: the real plate pipeline, emoji through packageEmojiLoader.
  const satoriWarnings = [];
  const og = createNodeOg({
    alt: () => fixture.name,
    size,
    fonts: fontLoader(satoriFonts),
    languageFonts: fontsourceLanguageFontLoader({ "ja-JP": { font: "noto-sans-jp", weight: 700 }, "zh-CN": { font: "noto-sans-jp", weight: 700 }, "ar-AR": { font: "noto-sans-arabic", weight: 700 } }, { cwd: fileURLToPath(new URL(".", import.meta.url)) }),
    emoji: packageEmojiLoader("twemoji", { cwd: fileURLToPath(new URL(".", import.meta.url)) }),
    guards: { missingGlyphs: "warn", overflow: "warn", onWarning: (w) => satoriWarnings.push(`${w.guard}: ${w.message}`) },
    component: () => fixture.tree,
  });
  let satoriPng;
  try {
    const t = performance.now();
    satoriPng = await og.render({});
    row.satoriMs = Math.round(performance.now() - t);
    writeFileSync(new URL(`${fixture.name}.png`, dirs.satori), satoriPng);
  } catch (error) {
    row.satoriError = String(error?.message ?? error);
  }
  row.satoriWarnings = satoriWarnings;

  // Takumi from the same tree.
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  let takumiPng;
  try {
    const t = performance.now();
    takumiPng = await render(fixture.tree, takumiOptions(size));
    row.takumiMs = Math.round(performance.now() - t);
    writeFileSync(new URL(`${fixture.name}.png`, dirs.takumi), takumiPng);
    if (backend === "wasm") {
      const tree = await measure(fixture.tree, takumiOptions(size));
      writeFileSync(new URL(`${fixture.name}.json`, dirs.measure), JSON.stringify(tree, null, 1));
    }
  } catch (error) {
    row.takumiError = String(error?.message ?? error);
  } finally {
    console.warn = origWarn;
  }
  row.takumiWarnings = warnings;

  if (satoriPng && takumiPng) {
    const strict = compareImages(satoriPng, takumiPng, { threshold: 0, diffImage: true });
    const loose = compareImages(satoriPng, takumiPng, { threshold: 64 });
    row.strict = { changedRatio: +strict.changedRatio.toFixed(4), meanDifference: +strict.meanDifference.toFixed(4), maxDifference: strict.maxDifference, sameSize: strict.sameSize };
    row.loose64 = { changedRatio: +loose.changedRatio.toFixed(4) };
    if (strict.diffImage) writeFileSync(new URL(`${fixture.name}.png`, dirs.diff), strict.diffImage);
  }
  results.push(row);
  console.log(JSON.stringify(row));
}
writeFileSync(new URL(`results-${backend}.json`, out), JSON.stringify(results, null, 2));
