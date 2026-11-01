// Copies the two Wasm modules and the font into the publish directory. Edge
// functions have no filesystem, so og.ts fetches them from its own origin.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const assets = {
  "public/wasm/resvg.wasm": "node_modules/@resvg/resvg-wasm/index_bg.wasm",
  "public/wasm/layout.wasm": "node_modules/satori/layout.wasm",
  "public/fonts/inter-latin-700-normal.woff": "node_modules/@fontsource/inter/files/inter-latin-700-normal.woff",
};
for (const [target, source] of Object.entries(assets)) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
