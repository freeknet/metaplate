// Probes for the guard assessment: run inside the consumer run.mjs creates.
import console from "node:console";
import { readFileSync } from "node:fs";
import { render, measure } from "takumi-js";
const module = readFileSync("node_modules/@takumi-rs/wasm/pkg/takumi_wasm_bg.wasm");
const inter = readFileSync("node_modules/@fontsource/inter/files/inter-latin-700-normal.woff2");
const base = { width: 1200, height: 630, module, fonts: [{ name: "Inter", weight: 700, data: inter }] };
const warns = []; const ow = console.warn; console.warn = (...a) => warns.push(a.join(" "));
const h = (style, children) => ({ type: "div", props: { style, children } });

// 1. loadFallbackFonts as the missingGlyphs hook
const calls = [];
await render(h({ display: "flex", fontFamily: "Inter", fontSize: 60 }, "Hello 한국어 🚀 world"), { ...base, emoji: "from-font", loadFallbackFonts: (chars) => { calls.push(chars); return []; } });
console.log("1 loadFallbackFonts calls:", JSON.stringify(calls), "warns:", warns.splice(0));

// 2. box-sizing default, no boxSizing anywhere. Satori (content-box) lays the
// root out at 1328 wide and the child at 708; border-box gives 1200 and 700.
const m = await measure(h({ width: "100%", height: "100%", padding: 64, display: "flex" }, [h({ width: 700, padding: 20, border: "4px solid red", height: 100 }, [])]), base);
console.log("2 box-sizing: root width", m.width, "(content-box 1328) child width", m.children[0].width, "(content-box 748)");

// 3. invalid / unsupported styles
try { await render(h({ display: "flex", fontFamily: "Inter", color: "notacolor", foo: "bar", fontSize: "huge" }, "x"), base); console.log("3 invalid style: rendered, warns:", warns.splice(0)); } catch (e) { console.log("3 invalid style threw:", e.message); }

// 4. raw output for the blank guard
const raw = await render(h({ width: "100%", height: "100%", background: "#123456" }, []), { ...base, format: "raw" });
console.log("4 raw bytes", raw.length, "expected", 1200 * 630 * 4, "first px", [...raw.slice(0, 4)]);

// 5. text drawn fully off-canvas: blank?
const raw2 = await render(h({ width: "100%", height: "100%", background: "#fff", display: "flex", fontFamily: "Inter", fontSize: 60 }, [h({ position: "absolute", top: 900 }, "off canvas")]), { ...base, format: "raw" });
console.log("5 off-canvas uniform?", raw2.every((v, i) => v === raw2[i % 4]));
console.warn = ow;
