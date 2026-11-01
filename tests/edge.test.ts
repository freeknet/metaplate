import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fontLoader } from "../src/font-data.js";
import { imageDimensions, verifyImage } from "../src/image.js";
import { createNodeOg } from "../src/node.js";

// Edge runtimes cannot read node_modules, so the entry takes Wasm and font
// bytes from its caller. The test plays that caller: it reads the bytes with
// Node and hands them over, leaving `metaplate/edge` itself Node-free.
const root = path.join(import.meta.dirname, "..");
const installed = (...segments: string[]) =>
  readFileSync(path.join(root, "node_modules", ...segments));
const resvgWasm = installed("@resvg", "resvg-wasm", "index_bg.wasm");
const layoutWasm = installed("satori", "layout.wasm");

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
});

it(
  "renders a PNG through @resvg/resvg-wasm with caller-supplied Wasm bytes",
  async () => {
    const { createEdgeOg } = await edgeEntry();
    const plate = createEdgeOg({ ...definition, resvg: { wasm: resvgWasm } });

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
    const edge = createEdgeOg({ ...shared, resvg: { wasm: resvgWasm } });
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
  "lays out through satori/standalone when the Yoga module is supplied",
  async () => {
    const { createEdgeOg } = await edgeEntry();
    const plate = createEdgeOg({
      ...definition,
      resvg: { wasm: () => Promise.resolve(resvgWasm) },
      layout: { wasm: layoutWasm },
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
  "takes the Wasm module once through initEdgeRenderer",
  async () => {
    const { createEdgeOg, initEdgeRenderer } = await edgeEntry();
    await initEdgeRenderer(resvgWasm);
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
      resvg: { wasm: resvgWasm },
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
  const plate = createEdgeOg({ ...definition, resvg: { wasm: resvgWasm } });

  expect(typeof plate.fetchable).toBe("function");
  expect(typeof plate.fetchableFrom).toBe("function");
  expect(typeof plate.handlerFrom).toBe("function");
  expect("handler" in plate).toBe(false);
});

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
    const plate = createEdgeOg(definition);

    await expect(plate.render({ title: "No Wasm" })).rejects.toThrow(
      /pass it as resvg\.wasm to createEdgeOg or call initEdgeRenderer\(wasm\) first/i,
    );
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
    const plate = createEdgeOg({ ...definition, resvg: { wasm: resvgWasm } });

    await expect(plate.render({ title: "Missing" })).rejects.toThrow(
      "Cannot find @resvg/resvg-wasm, required by metaplate/edge. " +
        "Install it with: npm install @resvg/resvg-wasm",
    );
  },
  30_000,
);

// The same check package verification applies to `metaplate/font-data`, run
// against a build of this entry with the project's own tsup configuration so
// it does not depend on a stale or absent dist directory.
it(
  "bundles metaplate/edge without Node built-ins or CommonJS require",
  async () => {
    const { build } = await import("tsup");
    const { default: config } = await import("../tsup.config.js");
    const outDir = mkdtempSync(path.join(tmpdir(), "metaplate-edge-build-"));
    try {
      await build({
        ...(config as object),
        entry: { edge: path.join(root, "src", "edge.ts") },
        outDir,
        dts: false,
        sourcemap: false,
        clean: false,
        silent: true,
      });
      const source = readFileSync(path.join(outDir, "edge.js"), "utf8");

      expect(source).not.toMatch(/\bnode:/);
      expect(source).not.toMatch(/\brequire\(/);
      expect(source).not.toMatch(/\bBuffer\b/);
      expect(source).not.toContain("@resvg/resvg-js");
      expect(source).toContain('import("@resvg/resvg-wasm")');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  },
  60_000,
);
