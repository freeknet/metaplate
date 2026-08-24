import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const consumer = mkdtempSync(join(tmpdir(), "metaplate-050-gaps-"));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: consumer,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    ...options,
  });
}

function failed(command, args) {
  try {
    run(command, args);
    return { status: 0, stdout: "", stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: error.stdout, stderr: error.stderr };
  }
}

writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify({ private: true, type: "module", dependencies: { metaplate: "0.5.0" } }),
);
run("npm.cmd", ["install", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund"]);

const packageRoot = join(consumer, "node_modules/metaplate");
const fromPackage = relative => pathToFileURL(join(packageRoot, relative)).href;
const core = await import(fromPackage("dist/index.js"));
const fonts = await import(fromPackage("dist/fonts.js"));
const image = await import(fromPackage("dist/image.js"));
const node = await import(fromPackage("dist/node.js"));
const render = await import(fromPackage("dist/render.js"));

const help = failed("node", [join(packageRoot, "dist/cli.js"), "--help"]);
const version = failed("node", [join(packageRoot, "dist/cli.js"), "--version"]);
assert.equal(help.status, 1);
assert.equal(version.status, 1);
assert.match(help.stderr, /^Usage: metaplate verify/);
assert.match(version.stderr, /^Usage: metaplate verify/);

const avifHeader = Uint8Array.from([
  0, 0, 0, 24,
  0x66, 0x74, 0x79, 0x70,
  0x61, 0x76, 0x69, 0x66,
  0, 0, 0, 0,
  0x61, 0x76, 0x69, 0x66,
  0x6d, 0x69, 0x66, 0x31,
]);
const svgImage = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"></svg>',
);
assert.equal(image.detectFormat(svgImage), "svg");
assert.throws(() => image.imageDimensions(svgImage), /Unrecognized image/);
assert.equal(image.detectFormat(avifHeader), undefined);
assert.throws(() => image.imageDimensions(avifHeader), /Unrecognized image/);
const avifCli = failed("node", [
  join(packageRoot, "dist/cli.js"),
  "verify",
  "--format",
  "avif",
  "--size",
  "1x1",
  "card.avif",
]);
assert.equal(avifCli.status, 1);
assert.match(avifCli.stderr, /^Invalid format/);
const svgCli = failed("node", [
  join(packageRoot, "dist/cli.js"),
  "verify",
  "--format",
  "svg",
  "--size",
  "1200x630",
  "card.svg",
]);
assert.equal(svgCli.status, 1);
assert.match(svgCli.stderr, /^Invalid format/);

const fakeFontPackage = join(consumer, "fake-font-package");
writeFileSync(join(consumer, "font.woff"), Uint8Array.of(1, 2, 3));
// Return the consumer directory so the ordinary path-containment logic still runs.
const loaded = await fonts.loadPackageFonts(
  [
    {
      name: "Localized",
      package: "fake-font",
      file: "font.woff",
      weight: 400,
      lang: "ja-JP",
    },
  ],
  { resolvePackage: () => consumer },
);
assert.equal(loaded[0].lang, undefined);

const declarations = {
  fonts: readFileSync(join(packageRoot, "dist/fonts.d.ts"), "utf8"),
  image: readFileSync(join(packageRoot, "dist/image.d.ts"), "utf8"),
  node: readFileSync(join(packageRoot, "dist/node.d.ts"), "utf8"),
  render: readFileSync(join(packageRoot, "dist/render.d.ts"), "utf8"),
};
assert.match(declarations.render, /lang\?: string/);
assert.doesNotMatch(declarations.fonts, /lang\?: string/);
assert.match(declarations.image, /"png" \| "jpeg" \| "webp"/);
assert.match(declarations.node, /checkSignature: false/);
assert.match(declarations.node, /headers\?: HeadersInit/);
assert.doesNotMatch(declarations.node, /statusText\?:/);

const publicFunctions = {
  core: Object.keys(core).sort(),
  fonts: Object.keys(fonts).sort(),
  image: Object.keys(image).sort(),
  node: Object.keys(node).sort(),
  render: Object.keys(render).sort(),
};
const allExports = Object.values(publicFunctions).flat();
assert.equal(allExports.some(name => /write|file|batch/i.test(name)), false);

console.log(
  JSON.stringify(
    {
      consumer,
      publishedVersion: "0.5.0",
      cliDiscovery: {
        helpExit: help.status,
        versionExit: version.status,
        bothPrintErrorUsage: true,
      },
      customFormatAsymmetry: {
        svgRendererHasNoVerifier: true,
        svgDetectFormat: image.detectFormat(svgImage),
        svgVerifyCliExit: svgCli.status,
        avifOutputCanOptOutOfSignatureCheck: true,
        avifDetectFormat: image.detectFormat(avifHeader) ?? null,
        avifVerifyCliExit: avifCli.status,
      },
      packageFontLanguage: {
        satoriMirrorSupportsLang: true,
        packageFontInputSupportsLang: false,
        loadedLang: loaded[0].lang ?? null,
      },
      nodeResponseControls: {
        headers: true,
        status: false,
        statusText: false,
      },
      staticGeneration: {
        fileOrBatchExportPresent: false,
        publicFunctions,
      },
    },
    null,
    2,
  ),
);
