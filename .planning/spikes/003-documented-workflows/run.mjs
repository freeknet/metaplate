import { execFileSync } from "node:child_process";
import console from "node:console";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const consumer = mkdtempSync(join(tmpdir(), "metaplate-050-workflows-"));

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
      dependencies: {
        "@fontsource/inter": "latest",
        "@resvg/resvg-js": "latest",
        metaplate: "0.5.0",
        next: "latest",
        react: "latest",
        "react-dom": "latest",
        satori: "latest",
        sharp: "latest",
      },
    },
    null,
    2,
  ),
);
run("npm.cmd", ["install", "--ignore-scripts=false", "--no-audit", "--no-fund"]);

writeFileSync(
  join(consumer, "probe.mjs"),
  String.raw`
import assert from "node:assert/strict";
import { createElement as h } from "react";
import sharp from "sharp";
import { socialImageMetadata } from "metaplate";
import { packageFontLoader } from "metaplate/fonts";
import { verifyImage } from "metaplate/image";
import { createNextOg } from "metaplate/next";
import { createNodeOg } from "metaplate/node";
import { createSvgOg } from "metaplate/render";

const copy = { eyebrow: "Release audit", title: "Metaplate 0.5.0", alt: "Metaplate release card" };
const fonts = packageFontLoader([
  {
    name: "Inter",
    package: "@fontsource/inter",
    file: "files/inter-latin-700-normal.woff",
    weight: 700,
  },
]);
const firstFonts = await fonts();
const secondFonts = await fonts();
assert.strictEqual(firstFonts, secondFonts);
assert.ok(firstFonts[0].data.byteLength > 1_000);

const component = value => ({
  type: "div",
  props: {
    style: {
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      background: "#111827",
      color: "#ffffff",
      fontFamily: "Inter",
      padding: 72,
    },
    children: [
      { type: "div", props: { style: { fontSize: 28 }, children: value.eyebrow } },
      { type: "div", props: { style: { fontSize: 72 }, children: value.title } },
    ],
  },
});

const metadata = socialImageMetadata("/docs", copy.alt, {
  origin: "https://example.com",
  basePath: "/project",
  imagePath: "og-image.png",
  size: { width: 1200, height: 630 },
  type: "image/png",
});
assert.equal(metadata.openGraph.images[0].url, "https://example.com/project/docs/og-image.png");
assert.deepEqual(metadata.openGraph.images, metadata.twitter.images);

const svgPlate = createSvgOg({ component, alt: value => value.alt, fonts });
const svg = await svgPlate.renderSvg(copy);
assert.match(svg, /^<svg/);
assert.match(svg, /width="1200" height="630"/);

const pngPlate = createNodeOg({
  component,
  alt: value => value.alt,
  fonts,
  origin: "https://example.com",
  basePath: "/project",
  imagePath: "og-image.png",
  headers: { "Cache-Control": "public, max-age=86400", "Content-Type": "text/plain" },
});
const png = await pngPlate.render(copy);
assert.deepEqual(verifyImage(png, pngPlate.size, "png"), { width: 1200, height: 630, format: "png" });
const response = await pngPlate.response(copy);
assert.equal(response.headers.get("content-type"), "image/png");
assert.equal(response.headers.get("cache-control"), "public, max-age=86400");
assert.deepEqual(
  verifyImage(await response.arrayBuffer(), pngPlate.size, "png"),
  { width: 1200, height: 630, format: "png" },
);
const handled = await pngPlate.handler(copy)();
assert.equal(handled.headers.get("content-type"), "image/png");

const concurrent = await Promise.all(
  Array.from({ length: 8 }, (_, index) => pngPlate.render({ ...copy, title: "Card " + index })),
);
for (const bytes of concurrent) verifyImage(bytes, pngPlate.size, "png");

const jpegPlate = createNodeOg({
  component,
  alt: value => value.alt,
  fonts,
  imagePath: "og-image.jpg",
  output: {
    format: "jpeg",
    encode: ({ pixels, width, height }) =>
      sharp(pixels, { raw: { width, height, channels: 4 } }).jpeg({ quality: 80 }).toBuffer(),
  },
});
const jpeg = await jpegPlate.render(copy);
assert.deepEqual(verifyImage(jpeg, jpegPlate.size, "jpeg"), { width: 1200, height: 630, format: "jpeg" });
assert.equal(jpegPlate.contentType, "image/jpeg");
assert.equal(jpegPlate.image("/docs", copy).type, "image/jpeg");

const wrongEncoder = createNodeOg({
  component,
  alt: value => value.alt,
  fonts,
  output: { format: "jpeg", encode: () => png },
});
await assert.rejects(wrongEncoder.render(copy), /not the declared jpeg format/);

let nextResult;
try {
  const nextPlate = createNextOg({
    component: value =>
      h("div", { style: { width: "100%", height: "100%", display: "flex", fontFamily: "Inter" } }, value.title),
    alt: value => value.alt,
    fonts,
    response: { status: 201, headers: { "X-Metaplate-Probe": "next" } },
  });
  const nextResponse = await nextPlate.render(copy);
  assert.equal(nextResponse.status, 201);
  assert.equal(nextResponse.headers.get("content-type"), "image/png");
  assert.equal(nextResponse.headers.get("x-metaplate-probe"), "next");
  const nextPng = await nextResponse.arrayBuffer();
  assert.deepEqual(verifyImage(nextPng, nextPlate.size, "png"), { width: 1200, height: 630, format: "png" });
  nextResult = { status: nextResponse.status, contentType: nextResponse.headers.get("content-type") };
} catch (error) {
  nextResult = { error: { code: error.code, message: error.message } };
}

console.log(JSON.stringify({
  metadataUrl: metadata.openGraph.images[0].url,
  fontBytes: firstFonts[0].data.byteLength,
  svgBytes: Buffer.byteLength(svg),
  pngBytes: png.byteLength,
  jpegBytes: jpeg.byteLength,
  concurrentRenders: concurrent.length,
  nodeResponse: { status: response.status, contentType: response.headers.get("content-type") },
  nextResponse: nextResult,
  wrongEncoderRejected: true,
}, null, 2));
`,
);

const report = JSON.parse(run("node", ["probe.mjs"]));
const installed = JSON.parse(run("npm.cmd", ["ls", "--depth=0", "--json"]));
const versions = Object.fromEntries(
  Object.entries(installed.dependencies ?? {}).map(([name, value]) => [name, value.version]),
);

run("node", ["--input-type=module", "--eval", "await import('next/og.js')"]);

const appDirectory = join(consumer, "app");
mkdirSync(appDirectory);
writeFileSync(
  join(consumer, "next.config.mjs"),
  "export default { output: 'export' };\n",
);
writeFileSync(
  join(appDirectory, "layout.js"),
  `import { createElement as h } from "react";
export default function Layout({ children }) { return h("html", null, h("body", null, children)); }
`,
);
writeFileSync(
  join(appDirectory, "page.js"),
  `import { createElement as h } from "react";
export default function Page() { return h("main", null, "Metaplate probe"); }
`,
);
writeFileSync(
  join(appDirectory, "opengraph-image.js"),
  `import { createElement as h } from "react";
import { createNextOg } from "metaplate/next";
const copy = { title: "Metaplate probe", alt: "Metaplate probe card" };
const og = createNextOg({
  component: value => h("div", { style: { width: "100%", height: "100%", display: "flex", background: "#111827", color: "#fff" } }, value.title),
  alt: value => value.alt,
});
export const dynamic = "force-static";
export const size = og.size;
export const contentType = og.contentType;
export default function Image() { return og.render(copy); }
`,
);

let nextBuild;
try {
  const output = run(join(consumer, "node_modules/.bin/next.cmd"), ["build"], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
  nextBuild = { succeeded: true, generatedImage: /opengraph-image/.test(output) };
} catch (error) {
  nextBuild = { succeeded: false, status: error.status, stderr: error.stderr };
}

console.log(JSON.stringify({ consumer, versions, report, nextBuild }, null, 2));
