// Runtime certification smoke for the packed package.
//
//   npm run build
//   node scripts/prepare-runtime-consumer.mjs <consumer-dir>
//   cd <consumer-dir>
//   node verify-runtime.mjs --expect-runtime=node --expect-version=<version>
//   bun verify-runtime.mjs --expect-runtime=bun --expect-version=<version>
//   deno run --allow-all --no-lock verify-runtime.mjs --expect-runtime=deno --expect-version=<version>
//
// The script runs inside a consumer project that installed the packed
// tarball, and imports metaplate by package name exactly as users do. The
// `resolve-packed` step fails unless every entry resolves into that
// consumer's node_modules/metaplate at the expected version, so a run can
// never certify this checkout's dist/ by accident.
//
// Every step runs on every invocation. Nothing is skipped or feature-detected
// away: a step that cannot run is a failed step, reported by name with a
// non-zero exit, because a smoke that skips the native raster would certify a
// runtime that cannot produce an image.
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const consumer = process.cwd();
const ENTRIES = Object.freeze(["metaplate", "metaplate/render", "metaplate/node", "metaplate/fonts", "metaplate/image"]);
const ROUTE = "/runtime-smoke";
const COPY = Object.freeze({ title: "Metaplate runtime smoke" });

function detectRuntime() {
  const deno = globalThis.Deno?.version?.deno;
  if (typeof deno === "string") return { name: "deno", version: deno };
  const bun = globalThis.Bun?.version;
  if (typeof bun === "string") return { name: "bun", version: bun };
  return { name: "node", version: process.versions.node };
}

function flag(argv, name) {
  const value = argv.find((argument) => argument.startsWith(`--${name}=`));
  return value?.slice(`--${name}=`.length);
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
      const expected = flag(process.argv.slice(2), "expect-runtime");
      if (expected !== undefined) {
        assert(
          expected === runtime.name,
          `expected to run under ${expected}, but this process is ${runtime.name} ${runtime.version}`,
        );
      }
      return { runtime: runtime.name, version: runtime.version };
    }],
    ["resolve-packed", async () => {
      // Every entry must come from the installed tarball in this consumer,
      // never from a checkout's dist/ or a linked workspace copy.
      const installed = join(consumer, "node_modules", "metaplate") + sep;
      const resolved = {};
      for (const entry of ENTRIES) {
        const file = fileURLToPath(import.meta.resolve(entry));
        assert(file.startsWith(installed), `${entry} resolved to ${file}, outside ${installed}`);
        resolved[entry] = file.slice(installed.length);
      }
      const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
      const expectedVersion = flag(process.argv.slice(2), "expect-version");
      if (expectedVersion !== undefined) {
        assert(manifest.version === expectedVersion, `installed metaplate is ${manifest.version}, expected ${expectedVersion}`);
      }
      return { version: manifest.version, root: dirname(installed), resolved };
    }],
    ["import-metadata", async () => {
      // `metaplate` is metadata only and must load, alone, before any entry
      // that can reach a renderer peer has been imported.
      modules.index = await import("metaplate");
      assert(typeof modules.index.socialImageMetadata === "function", "metaplate does not export socialImageMetadata");
      return { entries: ["metaplate"] };
    }],
    ["metadata", async () => {
      const metadata = modules.index.socialImageMetadata(ROUTE, COPY.title, {});
      const image = metadata.openGraph?.images?.[0];
      assert(image?.width === 1200 && image?.height === 630, "metadata did not describe a 1200x630 image");
      return { url: image.url };
    }],
    ["import-renderers", async () => {
      modules.render = await import("metaplate/render");
      modules.node = await import("metaplate/node");
      modules.fonts = await import("metaplate/fonts");
      modules.image = await import("metaplate/image");
      for (const [entry, name] of [
        ["render", "createSvgOg"],
        ["node", "createNodeOg"],
        ["fonts", "fontsourceFontLoader"],
        ["image", "verifyImage"],
      ]) {
        assert(typeof modules[entry][name] === "function", `metaplate/${entry} does not export ${name}`);
      }
      return { entries: ["metaplate/render", "metaplate/node", "metaplate/fonts", "metaplate/image"] };
    }],
    ["font-load", async () => {
      fonts = modules.fonts.fontsourceFontLoader([{ font: "inter", weight: 700 }], { cwd: consumer });
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
      return {
        bytes: responseBytes.byteLength,
        status: response.status,
        headers: {
          "content-type": response.headers.get("content-type"),
          "content-length": response.headers.get("content-length"),
        },
      };
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
