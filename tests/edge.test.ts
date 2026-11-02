import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { build as esbuild } from "esbuild";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { emojiLoader, twemojiName } from "../src/emoji.js";
import { fontLoader } from "../src/font-data.js";
import { imageAssetLoader, imageDimensions, verifyImage } from "../src/image.js";
import { createNodeOg } from "../src/node.js";

// Edge runtimes cannot read node_modules, so the entry takes Wasm and font
// bytes from its caller. The test plays that caller: it reads the bytes with
// Node and hands them over, leaving `metaplate/edge` itself Node-free.
const root = path.join(import.meta.dirname, "..");
const installed = (...segments: string[]) =>
  readFileSync(path.join(root, "node_modules", ...segments));
const resvgWasm = installed("@resvg", "resvg-wasm", "index_bg.wasm");
const layoutWasm = installed("satori", "layout.wasm");
/** Both Wasm modules every edge plate needs, as a Worker would import them. */
const wasm = { resvg: { wasm: resvgWasm }, layout: { wasm: layoutWasm } };

const definition = {
  alt: (copy: { title: string }) => `${copy.title} social card`,
  fonts: fontLoader([
    {
      name: "Inter",
      weight: 700,
      data: installed("@fontsource", "inter", "files", "inter-latin-700-normal.woff"),
    },
  ]),
  component: (copy: { title: string }) => ({
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
      },
      children: copy.title,
    },
  }),
};

/** A fresh entry per test: the Wasm sources the entry holds are module-wide. */
async function edgeEntry() {
  vi.resetModules();
  return import("../src/edge.js");
}

function missingModule(specifier: string) {
  return Object.assign(
    new Error(`Cannot find package '${specifier}' imported from /app/node_modules/metaplate/dist/edge.js`),
    { code: "ERR_MODULE_NOT_FOUND" },
  );
}

afterEach(() => {
  vi.doUnmock("@resvg/resvg-wasm");
  vi.doUnmock("../src/peers.js");
  vi.doUnmock("satori/standalone");
  vi.unstubAllGlobals();
});

it(
  "renders a PNG through @resvg/resvg-wasm with caller-supplied Wasm bytes",
  async () => {
    const { createEdgeOg } = await edgeEntry();
    const plate = createEdgeOg({ ...definition, ...wasm });

    expect(plate.contentType).toBe("image/png");
    const png = await plate.render({ title: "Edge PNG" });
    expect(verifyImage(png, plate.size, "png")).toEqual({
      width: 1200,
      height: 630,
      format: "png",
    });

    const { pixels, width, height } = await plate.renderPixels({ title: "Edge pixels" });
    expect(pixels.length).toBe(width * height * 4);
  },
  30_000,
);

// An edge function serves emoji from its own origin through a fetch-shaped
// source; here the "origin" is an in-memory map keyed by Twemoji file name.
it(
  "draws emoji from a caller-supplied source without Node built-ins",
  async () => {
    const { createEdgeOg } = await edgeEntry();
    const origin = new Map([
      ["1f44b-1f3fd", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" fill="#ff0000"/></svg>'],
    ]);
    const requested: string[] = [];
    const emoji = emojiLoader(async ({ grapheme }) => {
      requested.push(twemojiName(grapheme));
      const svg = origin.get(twemojiName(grapheme));
      return svg === undefined ? undefined : new Response(svg).arrayBuffer();
    });
    const plate = createEdgeOg({ ...definition, ...wasm, emoji });

    const { pixels } = await plate.renderPixels({ title: "Hi 👋🏽 🫨" });
    let red = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset]! > 200 && pixels[offset + 1]! < 50 && pixels[offset + 2]! < 50) red += 1;
    }
    expect(red).toBeGreaterThan(1000);
    expect(requested.sort()).toEqual(["1f44b-1f3fd", "1fae8"]);
    for (const file of ["emoji.ts", "bytes.ts"]) {
      expect(readFileSync(path.join(root, "src", file), "utf8")).not.toMatch(/^import .*["']node:/m);
    }
  },
  30_000,
);

// An edge function reads its logo from its own origin; here the "origin" is a
// Response built in memory, loaded once by the runtime-neutral loader.
it(
  "draws an imageAsset from an async component with @resvg/resvg-wasm",
  async () => {
    const { createEdgeOg } = await edgeEntry();
    let fetches = 0;
    const logo = imageAssetLoader(() => {
      fetches += 1;
      return new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"><rect width="2" height="1" fill="#ff0000"/></svg>',
      );
    });
    const plate = createEdgeOg({
      ...definition,
      ...wasm,
      size: { width: 120, height: 60 },
      component: async () => {
        const { src } = await logo();
        return {
          type: "div",
          props: {
            style: { display: "flex", width: "100%", height: "100%" },
            children: { type: "img", props: { src, width: 120, height: 60 } },
          },
        };
      },
    });

    for (let render = 0; render < 2; render += 1) {
      const { pixels } = await plate.renderPixels({ title: "unused" });
      let red = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset]! > 200 && pixels[offset + 1]! < 50 && pixels[offset + 3]! > 200) red += 1;
      }
      expect(red / (pixels.length / 4)).toBeGreaterThan(0.95);
    }
    expect(fetches).toBe(1);
  },
  30_000,
);

// The two encoders are different builds of the same Resvg release, so their
// bytes may differ; what a consumer relies on (dimensions, media type, and
// headers) must not.
it(
  "matches metaplate/node dimensions, content type, headers, and artifacts",
  async () => {
    const { createEdgeOg } = await edgeEntry();
    const shared = {
      ...definition,
      etag: true,
      origin: "https://example.com",
      headers: { "Cache-Control": "public, max-age=3600" },
    };
    const edge = createEdgeOg({ ...shared, ...wasm });
    const node = createNodeOg(shared);
    const copy = { title: "Parity" };

    expect(edge.contentType).toBe(node.contentType);
    expect(edge.size).toEqual(node.size);
    expect(edge.metadata("/docs", copy)).toEqual(node.metadata("/docs", copy));

    const [edgeResponse, nodeResponse] = await Promise.all([
      edge.response(copy),
      node.response(copy),
    ]);
    const edgeBytes = new Uint8Array(await edgeResponse.arrayBuffer());
    const nodeBytes = new Uint8Array(await nodeResponse.arrayBuffer());
    expect(imageDimensions(edgeBytes)).toEqual(imageDimensions(nodeBytes));

    for (const name of ["content-type", "cache-control"]) {
      expect(edgeResponse.headers.get(name)).toBe(nodeResponse.headers.get(name));
    }
    expect(edgeResponse.headers.get("content-length")).toBe(String(edgeBytes.byteLength));
    expect(nodeResponse.headers.get("content-length")).toBe(String(nodeBytes.byteLength));

    // Web Crypto in the edge entry must produce the same strong ETag that
    // node:crypto produces for the same bytes.
    const sha256 = (bytes: Uint8Array) => `"${createHash("sha256").update(bytes).digest("hex")}"`;
    expect(edgeResponse.headers.get("etag")).toBe(sha256(edgeBytes));
    expect(nodeResponse.headers.get("etag")).toBe(sha256(nodeBytes));

    const [edgeArtifact, nodeArtifact] = await Promise.all([
      edge.artifact("/docs", copy),
      node.artifact("/docs", copy),
    ]);
    expect(edgeArtifact.image).toEqual(nodeArtifact.image);
    expect(edgeArtifact.contentType).toBe(nodeArtifact.contentType);
    expect(edgeArtifact.metadata).toEqual(nodeArtifact.metadata);
    expect(edgeArtifact.etag).toBe(sha256(edgeArtifact.bytes));
  },
  30_000,
);

it(
  "resolves lazily supplied Wasm sources on the first render",
  async () => {
    const { createEdgeOg } = await edgeEntry();
    const plate = createEdgeOg({
      ...definition,
      resvg: { wasm: () => Promise.resolve(resvgWasm) },
      layout: { wasm: () => Promise.resolve(layoutWasm) },
    });

    const route = plate.fetchableFrom((request: Request) => ({
      title: new URL(request.url).searchParams.get("title") ?? "Untitled",
    }));
    const response = await route.fetch(new Request("https://example.com/og?title=Standalone"));

    expect(response.headers.get("content-type")).toBe("image/png");
    verifyImage(new Uint8Array(await response.arrayBuffer()), plate.size, "png");
  },
  30_000,
);

it(
  "takes both Wasm modules once through initEdgeRenderer",
  async () => {
    const { createEdgeOg, initEdgeRenderer } = await edgeEntry();
    await initEdgeRenderer(resvgWasm, { layout: layoutWasm });
    const plate = createEdgeOg(definition);

    const response = await plate.fetchable({ title: "Initialised" }).fetch();
    expect(response.headers.get("content-type")).toBe("image/png");
    verifyImage(new Uint8Array(await response.arrayBuffer()), plate.size, "png");
  },
  30_000,
);

it(
  "renders declared size variants through @resvg/resvg-wasm",
  async () => {
    const { createEdgeOg } = await edgeEntry();
    const contexts: { variant: string | undefined; width: number; height: number }[] = [];
    const plate = createEdgeOg({
      ...definition,
      ...wasm,
      imagePath: "og-image.png",
      variants: { square: { size: { width: 1080, height: 1080 } } },
      component: (copy: { title: string }, { variant, size }) => {
        contexts.push({ variant, ...size });
        return definition.component(copy);
      },
    });
    const square = plate.variant("square");
    const copy = { title: "Square" };

    expect(plate.variants).toEqual(["square"]);
    expect(square.variantName).toBe("square");
    expect(square.size).toEqual({ width: 1080, height: 1080 });
    expect(square.contentType).toBe("image/png");
    expect("handler" in square).toBe(false);

    const png = await square.render(copy);
    expect(verifyImage(png, square.size, "png")).toEqual({
      width: 1080,
      height: 1080,
      format: "png",
    });
    expect(contexts).toEqual([{ variant: "square", width: 1080, height: 1080 }]);

    const response = await square.fetchable(copy).fetch();
    expect(response.headers.get("content-type")).toBe("image/png");
    verifyImage(new Uint8Array(await response.arrayBuffer()), square.size, "png");

    const artifact = await square.artifact("/docs", copy);
    expect(artifact.image).toEqual({ width: 1080, height: 1080, format: "png" });
    expect(artifact.metadata.openGraph.images.map((image) => image.url)).toEqual([
      "/docs/og-image-square.png",
    ]);
    expect(plate.metadata("/docs", copy).openGraph.images.map((image) => image.url)).toEqual([
      "/docs/og-image.png",
      "/docs/og-image-square.png",
    ]);

    // Resvg size checks cover every declared size, not only the default.
    expect(() =>
      createEdgeOg({
        ...definition,
        variants: { square: { size: { width: 1080, height: 1080 } } },
        resvg: { fitTo: { mode: "width", value: 1200 } },
      }),
    ).toThrow(/must preserve the plate.s 1080x1080 dimensions/);
  },
  30_000,
);

it("offers Fetch-shaped handlers and no copy-bound handler", async () => {
  const { createEdgeOg } = await edgeEntry();
  const plate = createEdgeOg({ ...definition, ...wasm });

  expect(typeof plate.fetchable).toBe("function");
  expect(typeof plate.fetchableFrom).toBe("function");
  expect(typeof plate.handlerFrom).toBe("function");
  expect("handler" in plate).toBe(false);
});

it(
  "verifies signed paths with Web Crypto before rendering on the edge entry",
  async () => {
    const { createEdgeOg } = await edgeEntry();
    const secret = "edge-secret-0123456789abcdefghijklmno";
    const component = vi.fn(definition.component);
    const plate = createEdgeOg({ ...definition, ...wasm, imagePath: "og.png", component });
    const route = plate.fetchableFrom(
      (request: Request) => ({ title: new URL(request.url).pathname.split("/")[2] ?? "home" }),
      { signed: { secret, status: 404 } },
    );
    const metadata = await plate.signedMetadata("/og/edge", { title: "edge" }, { secret });
    const url = new URL(metadata.openGraph.images[0]!.url, "https://edge.example");

    const rejected = await route.fetch(new Request(new URL("/og/other/og.png", url)));
    expect(rejected.status).toBe(404);
    expect(component).not.toHaveBeenCalled();

    const response = await route.fetch(new Request(url));
    expect(response.status).toBe(200);
    verifyImage(new Uint8Array(await response.arrayBuffer()), plate.size, "png");
    expect(component).toHaveBeenCalledOnce();
  },
  30_000,
);

it("rejects output encoders and dimension-changing Resvg settings", async () => {
  const { createEdgeOg } = await edgeEntry();

  expect(() =>
    createEdgeOg({
      ...definition,
      output: { format: "jpeg", encode: () => Uint8Array.of(0xff, 0xd8, 0xff) },
    } as unknown as Parameters<typeof createEdgeOg>[0]),
  ).toThrow(/renders PNG only/);
  expect(() =>
    createEdgeOg({ ...definition, resvg: { fitTo: { mode: "width", value: 600 } } }),
  ).toThrow(/must preserve.*1200x630/);
  expect(() =>
    createEdgeOg({ ...definition, headers: { "Content-Type": "image/jpeg" } }),
  ).toThrow(/owned by Metaplate/);
});

it(
  "explains how to supply the Wasm module when none was given",
  async () => {
    vi.doMock("@resvg/resvg-wasm", () => ({
      initWasm: () => Promise.resolve(),
      Resvg: class {
        constructor() {
          throw new Error("Wasm has not been initialized. Call `initWasm()` function.");
        }
      },
    }));
    const { createEdgeOg } = await edgeEntry();
    const plate = createEdgeOg({ ...definition, layout: { wasm: layoutWasm } });

    await expect(plate.render({ title: "No Wasm" })).rejects.toThrow(
      /pass it as resvg\.wasm to createEdgeOg or to initEdgeRenderer\(wasm, \{ layout \}\)/i,
    );
  },
  30_000,
);

const MISSING_LAYOUT =
  /no satori\/layout\.wasm module.*pass it as layout\.wasm to createEdgeOg or to initEdgeRenderer/is;

it(
  "requires satori/layout.wasm and accepts it once supplied after a failed render",
  async () => {
    const { createEdgeOg, initEdgeRenderer } = await edgeEntry();
    const plate = createEdgeOg({ ...definition, resvg: { wasm: resvgWasm } });

    await expect(plate.render({ title: "No layout" })).rejects.toThrow(MISSING_LAYOUT);
    await expect(
      initEdgeRenderer(resvgWasm, {} as Parameters<typeof initEdgeRenderer>[1]),
    ).rejects.toThrow(MISSING_LAYOUT);

    // A layout source supplied later, here through initEdgeRenderer, serves
    // the plate that failed: the slot only fills once a source exists.
    await initEdgeRenderer(resvgWasm, { layout: layoutWasm });
    verifyImage(await plate.render({ title: "Layout supplied" }), plate.size, "png");
  },
  30_000,
);

it(
  "retries a layout source whose first initialisation failed",
  async () => {
    const { createEdgeOg } = await edgeEntry();
    let calls = 0;
    const plate = createEdgeOg({
      ...definition,
      resvg: { wasm: resvgWasm },
      layout: {
        wasm: () => {
          calls += 1;
          if (calls === 1) throw new Error("layout fetch failed");
          return layoutWasm;
        },
      },
    });

    await expect(plate.render({ title: "First" })).rejects.toThrow("layout fetch failed");
    verifyImage(await plate.render({ title: "Second" }), plate.size, "png");
    expect(calls).toBe(2);
  },
  30_000,
);

// Both packages keep their Wasm instance process-wide and Vitest does not
// reload node_modules between tests, so a failed initialisation is staged
// through each package's init function rather than with real bad bytes.
const BAD_WASM = "bad" as unknown as Uint8Array;

async function initAccepting(module: unknown, initialised: unknown[]): Promise<void> {
  if (module === BAD_WASM) throw new WebAssembly.CompileError("not a Wasm module");
  initialised.push(module);
}

it(
  "replaces a layout module that failed to initialise with one supplied later",
  async () => {
    const initialised: unknown[] = [];
    vi.doMock("satori/standalone", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      init: (module: unknown) => initAccepting(module, initialised),
    }));
    const { createEdgeOg, initEdgeRenderer } = await edgeEntry();

    await expect(initEdgeRenderer(resvgWasm, { layout: BAD_WASM })).rejects.toThrow("not a Wasm module");
    // A corrected module replaces the failed one in the same isolate.
    await initEdgeRenderer(resvgWasm, { layout: layoutWasm });
    expect(initialised).toEqual([layoutWasm]);
    const plate = createEdgeOg(definition);
    verifyImage(await plate.render({ title: "Corrected layout" }), plate.size, "png");
  },
  30_000,
);

it(
  "replaces a Resvg module that failed to initialise, but keeps one that succeeded",
  async () => {
    const initialised: unknown[] = [];
    vi.doMock("@resvg/resvg-wasm", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      initWasm: (module: unknown) => initAccepting(module, initialised),
    }));
    const { initEdgeRenderer } = await edgeEntry();

    await expect(initEdgeRenderer(BAD_WASM, { layout: layoutWasm })).rejects.toThrow("not a Wasm module");
    await initEdgeRenderer(resvgWasm, { layout: layoutWasm });
    expect(initialised).toEqual([resvgWasm]);

    // Once initialised, the module is a process-wide singleton: later sources
    // are ignored rather than re-initialising it.
    await initEdgeRenderer(BAD_WASM, { layout: layoutWasm });
    expect(initialised).toEqual([resvgWasm]);
  },
  30_000,
);

it(
  "names the install command when @resvg/resvg-wasm is missing",
  async () => {
    // Vitest wraps errors thrown by a module-mock factory, which hides the
    // resolver's error code, so the peer's own import is replaced instead,
    // keeping the entry's real peer description and guidance path.
    vi.doMock("../src/peers.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/peers.js")>();
      const { optionalPeer } = await import("../src/optional-peer.js");
      return {
        ...actual,
        loadResvgWasm: optionalPeer(actual.RESVG_WASM_PEER, () =>
          Promise.reject(missingModule("@resvg/resvg-wasm")),
        ),
      };
    });
    const { createEdgeOg } = await edgeEntry();
    // No layout module either: a missing package is reported before a missing
    // Wasm source, so the install command comes first.
    const plate = createEdgeOg({ ...definition, resvg: { wasm: resvgWasm } });

    await expect(plate.render({ title: "Missing" })).rejects.toThrow(
      "Cannot find @resvg/resvg-wasm, required by metaplate/edge. " +
        "Install it with: npm install @resvg/resvg-wasm",
    );
  },
  30_000,
);

/**
 * Replaces `satori/standalone` with a build whose render rejects with
 * `error`, as Satori's bundled HarfBuzz does in Cloudflare Workers, and
 * returns what a render of an otherwise complete edge plate rejects with.
 */
async function renderFailure(error: unknown): Promise<unknown> {
  vi.doMock("satori/standalone", () => ({
    init: () => undefined,
    default: () => Promise.reject(error),
  }));
  const { createEdgeOg } = await edgeEntry();
  const plate = createEdgeOg({ ...definition, ...wasm });
  return plate.render({ title: "HarfBuzz" }).then(
    () => expect.fail("the render should have failed"),
    (failure: unknown) => failure,
  );
}

const HARFBUZZ_RUNTIME =
  /Satori's bundled HarfBuzz text shaper compiles WebAssembly at runtime and expects self\.location, which this runtime forbids \(Cloudflare Workers and other V8 isolates that disallow Wasm code generation\)\. metaplate\/edge runs on edge runtimes that allow it, such as Deno and Netlify Edge Functions\. See https:\/\/github\.com\/lnorton89\/metaplate\/blob\/main\/docs\/edge\.md#edge-runtimes-with-metaplateedge/;

/** Asserts that a render failing with `original` rejects with the explanation. */
async function expectExplained(original: Error): Promise<void> {
  const failure = await renderFailure(original);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(HARFBUZZ_RUNTIME);
  expect((failure as Error).cause).toBe(original);
}

it(
  "explains HarfBuzz's self.location read in a worker scope without location",
  async () => {
    // workerd defines WorkerGlobalScope but no location; Node has neither.
    vi.stubGlobal("WorkerGlobalScope", class WorkerGlobalScope {});
    expect(typeof (globalThis as { location?: unknown }).location).toBe("undefined");

    await expectExplained(new TypeError("Cannot read properties of undefined (reading 'href')"));
  },
  30_000,
);

it(
  "explains a refused HarfBuzz Wasm compilation",
  async () => {
    await expectExplained(
      new WebAssembly.RuntimeError(
        "Aborted(CompileError: WebAssembly.instantiate(): Wasm code generation disallowed by embedder). " +
          "Build with -sASSERTIONS for more info.",
      ),
    );
  },
  30_000,
);

it(
  "passes other Satori errors through unchanged",
  async () => {
    // Outside a worker scope, the same href message is not HarfBuzz's.
    const href = new TypeError("Cannot read properties of undefined (reading 'href')");
    expect(await renderFailure(href)).toBe(href);

    const unrelated = new Error("Unsupported CSS property: grid");
    expect(await renderFailure(unrelated)).toBe(unrelated);
  },
  30_000,
);

/**
 * `dist/edge.js` as the project's own tsup configuration builds it, so the
 * bundle checks below never depend on a stale or absent dist directory.
 */
let edgeBuild: Promise<{ outDir: string; entry: string }> | undefined;

function buildEdgeEntry() {
  edgeBuild ??= (async () => {
    const { build } = await import("tsup");
    const { default: config } = await import("../tsup.config.js");
    const outDir = mkdtempSync(path.join(tmpdir(), "metaplate-edge-build-"));
    await build({
      ...(config as object),
      entry: { edge: path.join(root, "src", "edge.ts") },
      outDir,
      dts: false,
      sourcemap: false,
      clean: false,
      silent: true,
    });
    return { outDir, entry: path.join(outDir, "edge.js") };
  })();
  return edgeBuild;
}

afterAll(async () => {
  if (edgeBuild) rmSync((await edgeBuild).outDir, { recursive: true, force: true });
});

// The same check package verification applies to `metaplate/font-data`.
// Satori's default build embeds its own Yoga, so referencing it as well as
// `satori/standalone` would make every edge bundler ship both builds.
it(
  "bundles metaplate/edge without Node built-ins, CommonJS require, or Satori's default build",
  async () => {
    const source = readFileSync((await buildEdgeEntry()).entry, "utf8");

    expect(source).not.toMatch(/\bnode:/);
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/\bBuffer\b/);
    expect(source).not.toContain("@resvg/resvg-js");
    expect(source).toContain('import("@resvg/resvg-wasm")');
    expect(source).toContain('import("satori/standalone")');
    // The peer description names the package; no import may use it bare.
    expect(source).not.toMatch(/\b(?:import\s*\(\s*|from\s*|import\s*)(["'`])satori\1/);
  },
  60_000,
);

// What an edge platform's bundler does with the entry: esbuild (which
// Wrangler, Vercel, and Netlify build on) follows every dynamic import, so the
// metafile lists each Satori build the deployed function would carry. The
// Wasm imports stay external, as Wrangler uploads them as separate modules.
it(
  "lets an esbuild-bundled edge consumer carry only satori/standalone",
  async () => {
    const { entry } = await buildEdgeEntry();
    const consumer = `
      import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
      import layoutWasm from "satori/layout.wasm";
      import { createEdgeOg } from ${JSON.stringify(entry.replaceAll("\\", "/"))};

      export default createEdgeOg({
        alt: (copy) => copy.title,
        resvg: { wasm: resvgWasm },
        layout: { wasm: layoutWasm },
        fonts: () => [],
        component: (copy) => ({ type: "div", props: { children: copy.title } }),
      }).fetchableFrom(() => ({ title: "Edge" }));
    `;
    const result = await esbuild({
      stdin: { contents: consumer, resolveDir: root, sourcefile: "edge-consumer.js" },
      bundle: true,
      write: false,
      metafile: true,
      minify: true,
      format: "esm",
      platform: "browser",
      conditions: ["workerd", "worker", "browser"],
      nodePaths: [path.join(root, "node_modules")],
      external: ["*.wasm"],
      logLevel: "silent",
    });

    const satoriInputs = Object.keys(result.metafile.inputs)
      .map((input) => input.replaceAll("\\", "/"))
      .filter((input) => input.includes("node_modules/satori/"));
    expect(satoriInputs).toEqual(["node_modules/satori/dist/standalone.js"]);
    expect(satoriInputs.some((input) => input.includes("node_modules/satori/dist/index"))).toBe(false);

    const bytes = result.outputFiles[0]!.contents;
    // Recorded in the test output: the JavaScript an edge function ships
    // besides the two Wasm modules.
    console.info(
      `metaplate/edge consumer bundle (minified, Wasm external): ${bytes.byteLength} bytes, ` +
        `${gzipSync(bytes).byteLength} bytes gzip`,
    );
  },
  60_000,
);
