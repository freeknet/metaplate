// Runtime certification smoke for the built package.
//
//   node scripts/verify-runtime.mjs [--expect-runtime=node]
//   bun scripts/verify-runtime.mjs --expect-runtime=bun
//   deno run --allow-all --no-lock scripts/verify-runtime.mjs --expect-runtime=deno
//
// Run `npm run build` first. The script imports the built `dist/` entries by
// relative path rather than by the `metaplate` self-reference: Node and Bun
// resolve a package's own name through its exports map, but Deno's handling
// of a self-reference from outside node_modules is not something this script
// should be certifying, so every runtime loads the same files the same way.
// The peers (`satori`, `@resvg/resvg-js`) and the font package still resolve
// as bare specifiers from node_modules, which is the part under test.
//
// Every step runs on every invocation. Nothing is skipped or feature-detected
// away: a step that cannot run is a failed step, reported by name with a
// non-zero exit, because a smoke that skips the native raster would certify a
// runtime that cannot produce an image.
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = "/runtime-smoke";
const COPY = Object.freeze({ title: "Metaplate runtime smoke" });

function detectRuntime() {
  const deno = globalThis.Deno?.version?.deno;
  if (typeof deno === "string") return { name: "deno", version: deno };
  const bun = globalThis.Bun?.version;
  if (typeof bun === "string") return { name: "bun", version: bun };
  return { name: "node", version: process.versions.node };
}

function expectedRuntime(argv) {
  const flag = argv.find((argument) => argument.startsWith("--expect-runtime="));
  return flag?.slice("--expect-runtime=".length);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const runtime = detectRuntime();
const completed = [];

function report(stream, payload) {
  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(step, error) {
  report(process.stderr, {
    ok: false,
    runtime,
    nodeCompatibility: process.versions.node,
    failedStep: step,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    cause: error instanceof Error && error.cause !== undefined ? String(error.cause) : undefined,
    completedSteps: completed,
  });
  process.exitCode = 1;
  // Deno honours process.exitCode through its Node layer; setting its own
  // exit code too keeps a failure from ever exiting 0 on an older Deno 2.
  if (globalThis.Deno && "exitCode" in globalThis.Deno) globalThis.Deno.exitCode = 1;
}

async function step(name, run) {
  try {
    const detail = await run();
    completed.push({ step: name, ...detail });
    return true;
  } catch (error) {
    fail(name, error);
    return false;
  }
}

function card(copy) {
  return {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#111111",
        color: "#ffffff",
        fontFamily: "Inter",
        fontSize: 64,
        fontWeight: 700,
      },
      children: copy.title,
    },
  };
}

async function main() {
  const modules = {};
  let fonts;
  let svgPlate;
  let nodePlate;
  let artifact;
  let responseBytes;

  const steps = [
    ["runtime", async () => {
      const expected = expectedRuntime(process.argv.slice(2));
      if (expected !== undefined) {
        assert(
          expected === runtime.name,
          `expected to run under ${expected}, but this process is ${runtime.name} ${runtime.version}`,
        );
      }
      return { runtime: runtime.name, version: runtime.version };
    }],
    ["import-metadata", async () => {
      // `metaplate` is metadata only and must load, alone, before any entry
      // that can reach a renderer peer has been imported.
      modules.index = await import("../dist/index.js");
      assert(typeof modules.index.socialImageMetadata === "function", "dist/index.js does not export socialImageMetadata");
      return { entries: ["metaplate"] };
    }],
    ["metadata", async () => {
      const metadata = modules.index.socialImageMetadata(ROUTE, COPY.title, {});
      const image = metadata.openGraph?.images?.[0];
      assert(image?.width === 1200 && image?.height === 630, "metadata did not describe a 1200x630 image");
      return { url: image.url };
    }],
    ["import-renderers", async () => {
      modules.render = await import("../dist/render.js");
      modules.node = await import("../dist/node.js");
      modules.fonts = await import("../dist/fonts.js");
      modules.image = await import("../dist/image.js");
      for (const [entry, name] of [
        ["render", "createSvgOg"],
        ["node", "createNodeOg"],
        ["fonts", "fontsourceFontLoader"],
        ["image", "verifyImage"],
      ]) {
        assert(typeof modules[entry][name] === "function", `dist/${entry}.js does not export ${name}`);
      }
      return { entries: ["metaplate/render", "metaplate/node", "metaplate/fonts", "metaplate/image"] };
    }],
    ["font-load", async () => {
      fonts = modules.fonts.fontsourceFontLoader([{ font: "inter", weight: 700 }], { cwd: root });
      const loaded = await fonts();
      assert(loaded.length === 1, `expected 1 font face, loaded ${loaded.length}`);
      const [face] = loaded;
      assert(face.name === "Inter" && face.weight === 700, `unexpected face ${face.name} ${face.weight}`);
      assert(face.data.byteLength > 1_000, `font data is only ${face.data.byteLength} bytes`);
      return { family: face.name, weight: face.weight, bytes: face.data.byteLength };
    }],
    ["satori-render", async () => {
      const definition = { alt: (copy) => copy.title, fonts, component: card };
      svgPlate = modules.render.createSvgOg(definition);
      nodePlate = modules.node.createNodeOg(definition);
      const svg = await svgPlate.renderSvg(COPY);
      assert(typeof svg === "string" && svg.startsWith("<svg"), "Satori did not return SVG markup");
      // Satori draws text as glyph outlines, so a path proves the font shaped text.
      assert(svg.includes("<path"), "SVG has no glyph paths; the font was not used");
      const dimensions = modules.image.verifyImage(new Uint8Array(Buffer.from(svg)), svgPlate.size, "svg");
      return { width: dimensions.width, height: dimensions.height, characters: svg.length };
    }],
    ["resvg-raster", async () => {
      // The same copy already rendered through Satori above, so a failure here
      // is the native Resvg binding loading or rasterizing under this runtime.
      artifact = await nodePlate.artifact(ROUTE, COPY);
      assert(artifact.bytes instanceof Uint8Array, "artifact bytes are not a Uint8Array");
      assert(artifact.contentType === "image/png", `artifact content type is ${artifact.contentType}`);
      return { bytes: artifact.byteLength, format: artifact.format };
    }],
    ["response", async () => {
      const handle = nodePlate.handlerFrom(async (title) => ({ title }));
      const response = await handle(COPY.title);
      assert(response instanceof globalThis.Response, "handlerFrom did not return a Web Response");
      assert(response.status === 200, `response status is ${response.status}`);
      assert(response.headers.get("content-type") === "image/png", `content-type is ${response.headers.get("content-type")}`);
      responseBytes = new Uint8Array(await response.arrayBuffer());
      assert(
        response.headers.get("content-length") === String(responseBytes.byteLength),
        `content-length ${response.headers.get("content-length")} does not match ${responseBytes.byteLength} body bytes`,
      );
      return { bytes: responseBytes.byteLength };
    }],
    ["verify", async () => {
      const fromArtifact = modules.image.verifyImage(artifact.bytes, nodePlate.size, "png");
      const fromResponse = modules.image.verifyImage(responseBytes, nodePlate.size, "png");
      assert(
        Buffer.compare(Buffer.from(artifact.bytes), Buffer.from(responseBytes)) === 0,
        "artifact and response rendered different bytes for the same copy",
      );
      assert(artifact.metadata.openGraph?.images?.[0]?.type === "image/png", "artifact metadata does not advertise image/png");
      return { format: fromArtifact.format, width: fromResponse.width, height: fromResponse.height };
    }],
  ];

  for (const [name, run] of steps) {
    if (!(await step(name, run))) return;
  }

  report(process.stdout, {
    ok: true,
    runtime,
    nodeCompatibility: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    steps: completed,
  });
}

await main();
