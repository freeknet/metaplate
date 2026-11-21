// Spike 005: Takumi as a second rendering backend.
// Builds a fresh temporary consumer with pinned versions, then runs the parity
// harness (Wasm and native), the diff contact sheets, and the guard probes.
// Usage: node .planning/spikes/005-takumi-backend/run.mjs
import { execFileSync } from "node:child_process";
import console from "node:console";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const consumer = mkdtempSync(join(tmpdir(), "metaplate-takumi-spike-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const run = (command, args) =>
  execFileSync(command, args, {
    cwd: consumer,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  });

writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify(
    {
      private: true,
      type: "module",
      dependencies: {
        metaplate: "0.8.4",
        satori: "0.63.2",
        "@resvg/resvg-js": "2.6.2",
        "takumi-js": "2.22.1",
        "@fontsource/inter": "5.3.0",
        "@fontsource/noto-sans-jp": "5.3.1",
        "@fontsource/noto-sans-arabic": "5.3.0",
        "@twemoji/svg": "15.0.0",
      },
    },
    null,
    2,
  ),
);
// Native bindings (resvg-js, @takumi-rs/core) are optional dependencies: keep them.
run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);

for (const file of ["fixtures.mjs", "parity.mjs", "sheet.mjs", "probe.mjs"]) copyFileSync(join(here, file), join(consumer, file));
copyFileSync(join(repo, "tests/fixtures/card.jpg"), join(consumer, "card.jpg"));
// tests/fixtures/card.png is deliberately truncated (its IDAT holds 75% of the rows).
copyFileSync(join(repo, "tests/fixtures/card.png"), join(consumer, "card-truncated.png"));
writeFileSync(
  join(consumer, "make-photo.mjs"),
  `import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset=".5" stop-color="#ec4899"/><stop offset="1" stop-color="#f59e0b"/></linearGradient><radialGradient id="r" cx=".3" cy=".3"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#1e3a8a"/></radialGradient></defs><rect width="1200" height="630" fill="url(#g)"/><circle cx="200" cy="430" r="120" fill="url(#r)"/></svg>';
writeFileSync("photo.png", new Resvg(svg).render().asPng());`,
);
run(process.execPath, ["make-photo.mjs"]);

const summary = {};
for (const backend of ["wasm", "native"]) {
  run(process.execPath, ["parity.mjs", backend]);
  summary[backend] = JSON.parse(readFileSync(join(consumer, `out/results-${backend}.json`), "utf8")).map((row) => ({
    name: row.name,
    changedRatio: row.strict?.changedRatio,
    changedRatioAt64: row.loose64?.changedRatio,
    satoriMs: row.satoriMs,
    takumiMs: row.takumiMs,
    takumiError: row.takumiError,
    satoriWarnings: row.satoriWarnings.length,
    takumiWarnings: row.takumiWarnings,
  }));
}
run(process.execPath, ["sheet.mjs"]);
const probes = run(process.execPath, ["probe.mjs"]);

console.log(JSON.stringify({ consumer, summary, probes: probes.trim().split("\n") }, null, 2));
console.log(`Images: ${join(consumer, "out")} (satori/, takumi-wasm/, takumi-native/, diff-*/, sheet-*.png, measure/)`);
