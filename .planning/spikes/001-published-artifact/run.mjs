import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const consumer = mkdtempSync(join(tmpdir(), "metaplate-050-artifact-"));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: consumer,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    ...options,
  });
}

writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify(
    {
      private: true,
      type: "module",
      dependencies: { metaplate: "0.5.0" },
      devDependencies: { typescript: "5.9.2" },
    },
    null,
    2,
  ),
);

run("npm.cmd", ["install", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund"]);

const installed = JSON.parse(readFileSync(join(consumer, "node_modules/metaplate/package.json"), "utf8"));
assert.equal(installed.version, "0.5.0");

const packageList = JSON.parse(run("npm.cmd", ["ls", "--depth=0", "--json"]));
for (const peer of ["satori", "@resvg/resvg-js", "next", "react"]) {
  assert.equal(packageList.dependencies?.[peer], undefined, `${peer} must remain absent`);
}

writeFileSync(
  join(consumer, "runtime-probe.mjs"),
  String.raw`
import assert from "node:assert/strict";
import * as core from "metaplate";
import * as fonts from "metaplate/fonts";
import * as image from "metaplate/image";
import * as node from "metaplate/node";
import * as png from "metaplate/png";
import * as render from "metaplate/render";
import * as next from "metaplate/next";

assert.equal(core.socialImagePath("/posts/one", "card.png", "/site", "https://example.com"), "https://example.com/site/posts/one/card.png");
assert.equal(typeof fonts.packageFontLoader, "function");
assert.equal(typeof image.verifyImage, "function");
assert.equal(typeof png.verifyPng, "function");

const svg = render.createSvgOg({
  component: () => ({ type: "div", props: { children: "hello" } }),
  alt: () => "hello",
  fonts: () => [{ name: "Test", data: new Uint8Array([0]) }],
});
await assert.rejects(svg.renderSvg({}), error => /npm install satori/.test(error.message));

const raster = node.createNodeOg({
  component: () => ({ type: "div", props: { children: "hello" } }),
  alt: () => "hello",
  fonts: () => [{ name: "Test", data: new Uint8Array([0]) }],
});
await assert.rejects(
  raster.render({}),
  error => /npm install satori @resvg\/resvg-js/.test(error.message),
);

const nextPlate = next.createNextOg({
  component: () => ({ type: "div", props: { children: "hello" } }),
  alt: () => "hello",
});
await assert.rejects(nextPlate.render({}), error => /npm install next/.test(error.message));

console.log(JSON.stringify({ node: process.version, entrypoints: 7, optionalPeerBoundaries: 3 }));
`,
);

writeFileSync(
  join(consumer, "consumer.ts"),
  String.raw`
import { socialImageMetadata } from "metaplate";
import { packageFontLoader } from "metaplate/fonts";
import { verifyImage } from "metaplate/image";
import { createNodeOg, type RenderedPixels } from "metaplate/node";
import { verifyPng } from "metaplate/png";
import { createSvgOg, type SatoriNode } from "metaplate/render";

const node: SatoriNode = { type: "div", props: { children: "typed" } };
const fonts = packageFontLoader([]);
const svg = createSvgOg({ component: () => node, alt: () => "typed", fonts });
const raster = createNodeOg({ component: () => node, alt: () => "typed", fonts });
const pixels: RenderedPixels = { pixels: new Uint8Array(4), width: 1, height: 1 };
void [socialImageMetadata("/", "typed"), verifyImage, verifyPng, svg, raster, pixels];
`,
);

writeFileSync(
  join(consumer, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022", "DOM"],
        strict: true,
        noEmit: true,
        types: [],
        skipLibCheck: false,
      },
      include: ["consumer.ts"],
    },
    null,
    2,
  ),
);

const runtime = [];
runtime.push(JSON.parse(run("node", ["runtime-probe.mjs"]).trim()));
runtime.push(JSON.parse(run("npx.cmd", ["--yes", "--package=node@20", "node", "runtime-probe.mjs"]).trim()));
runtime.push(JSON.parse(run("npx.cmd", ["--yes", "--package=node@24", "node", "runtime-probe.mjs"]).trim()));
run(join(consumer, "node_modules/.bin/tsc.cmd"), ["--project", "tsconfig.json"]);

let cli;
try {
  run("node", ["node_modules/metaplate/dist/cli.js"]);
  cli = { exitCode: 0, stderr: "" };
} catch (error) {
  cli = { exitCode: error.status, stderr: error.stderr };
}
assert.equal(cli.exitCode, 1);
assert.match(cli.stderr, /^Usage: metaplate verify/);

console.log(
  JSON.stringify(
    {
      consumer,
      installedVersion: installed.version,
      installedTopLevel: Object.keys(packageList.dependencies ?? {}).sort(),
      runtime,
      typecheck: "passed without React or Node type packages",
      cli: "published executable returned documented usage",
    },
    null,
    2,
  ),
);
