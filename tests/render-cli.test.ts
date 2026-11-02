import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RENDER_CONCURRENCY,
  parseRenderInvocation,
  RENDER_USAGE,
} from "../src/cli-args.js";
import { fontsourceFontLoader } from "../src/fonts.js";
import { verifyImage } from "../src/image.js";
import { socialImageVersion } from "../src/index.js";
import { createNodeOg } from "../src/node.js";
import { createSvgOg } from "../src/render.js";
import {
  outputTarget,
  planImages,
  renderFiles,
  renderManifest,
  resolveRenderJobs,
  type ManifestImage,
  type RenderablePlate,
  type RenderJob,
  type RenderOutcome,
} from "../src/render-files.js";
import { bundleCli, runCli } from "./helpers/cli-bundle.js";
import { completePng } from "./helpers/image-fixtures.js";

const LANDSCAPE = { width: 1200, height: 630 };
const SQUARE = { width: 1080, height: 1080 };
const inter = fontsourceFontLoader([{ font: "inter", weight: 700 }]);

type Copy = { title: string };

function card(copy: Copy) {
  return {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        background: "#111",
        color: "#fff",
        fontFamily: "Inter",
        fontSize: 64,
      },
      children: copy.title,
    },
  };
}

function nodePlate(options: { basePath?: string; origin?: string; version?: "copy" } = {}) {
  return createNodeOg<Copy, "square">({
    alt: (copy) => copy.title,
    fonts: inter,
    imagePath: "og-image.png",
    variants: { square: { size: SQUARE } },
    component: card,
    ...options,
  });
}

function temporary(prefix: string) {
  return mkdtemp(path.join(tmpdir(), `metaplate-render-${prefix}-`));
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

type FakeOptions = {
  variants?: string[];
  sitePath?: (route: string) => string;
  artifact?: (route: string, copy: unknown) => Promise<Uint8Array>;
};

/** A structural plate with one `square` variant that returns fixed PNG bytes. */
function fakePlate(options: FakeOptions = {}, name?: string): RenderablePlate<unknown> {
  const size = name === undefined ? LANDSCAPE : SQUARE;
  const file = name === undefined ? "og-image.png" : `og-image-${name}.png`;
  const sitePath = options.sitePath ?? ((route: string) =>
    [route.replace(/^\/+|\/+$/g, ""), file].filter(Boolean).join("/"));
  return {
    variantName: name,
    variants: options.variants ?? ["square"],
    variant: (variant: string) => fakePlate(options, variant),
    sitePath,
    artifact: async (route: string, copy: unknown) => ({
      bytes: options.artifact ? await options.artifact(route, copy) : completePng(size.width, size.height),
      contentType: "image/png",
      format: "png",
      size,
      metadata: { openGraph: { images: [{ url: `/${sitePath(route)}` }] } },
    }),
  };
}

describe("parseRenderInvocation", () => {
  it("defaults the output, manifest, and concurrency", () => {
    expect(parseRenderInvocation(["render", "og.render.mjs"])).toEqual({
      module: "og.render.mjs",
      outDir: "public",
      manifest: path.join("public", "metaplate-manifest.json"),
      concurrency: DEFAULT_RENDER_CONCURRENCY,
      json: false,
    });
  });

  it("parses every flag in any order", () => {
    expect(parseRenderInvocation([
      "render", "--json", "--concurrency", "2", "og.ts", "--out", "dist", "--manifest", "build/manifest.json",
    ])).toEqual({
      module: "og.ts",
      outDir: "dist",
      manifest: "build/manifest.json",
      concurrency: 2,
      json: true,
    });
  });

  it.each([
    [["render"]],
    [["render", "a.mjs", "b.mjs"]],
    [["render", "--size", "1200x630", "a.mjs"]],
    [["render", "--out"]],
    [["render", "--out", "--json", "a.mjs"]],
  ])("rejects %j with the render usage", (args) => {
    expect(() => parseRenderInvocation(args)).toThrow(RENDER_USAGE);
  });

  it.each(["0", "257", "1.5", "0x4", ""])("rejects concurrency %j", (value) => {
    expect(() => parseRenderInvocation(["render", "--concurrency", value, "a.mjs"]))
      .toThrow(`Invalid concurrency. ${RENDER_USAGE}`);
  });
});

describe("render module contract", () => {
  const page = { copy: { title: "Home" } };

  it("accepts one job, an array of jobs, or a sync or async function returning either", async () => {
    const job = { plate: fakePlate(), pages: [page] };
    for (const exported of [job, [job, job], () => job, async () => [job]]) {
      const jobs = await resolveRenderJobs(exported);
      expect(jobs.length).toBeGreaterThan(0);
      expect(jobs[0]!.pages).toEqual([page]);
    }
  });

  it.each([
    [undefined, "expected a default export"],
    [[], "the default export lists no render jobs"],
    [async () => undefined, "expected a default export"],
    ["og", "job must be an object with plate and pages"],
    [{ pages: [{ copy: {} }] }, "job.plate must be a plate"],
    [[{ plate: fakePlate(), pages: [] }], "job[0].pages must be a non-empty array"],
    [{ plate: fakePlate(), pages: [{ route: "/" }] }, "job.pages[0] must be an object with a copy property"],
    [{ plate: fakePlate(), pages: [{ route: 1, copy: {} }] }, "job.pages[0].route must be a string"],
    [{ plate: { ...fakePlate(), variants: "square" }, pages: [page] }, "job.plate.variants must be an array"],
  ])("rejects %j", async (exported, message) => {
    await expect(resolveRenderJobs(exported)).rejects.toThrow(`Invalid render module: ${message}`);
  });

  it("keeps a page's version and refuses one that is not a valid token", async () => {
    const [job] = await resolveRenderJobs({ plate: fakePlate(), pages: [{ route: "/a", copy: {}, version: "r2" }] });
    expect(job!.pages).toEqual([{ route: "/a", copy: {}, version: "r2" }]);
    await expect(resolveRenderJobs({ plate: fakePlate(), pages: [{ copy: {}, version: "a&b" }] })).rejects.toThrow(
      "Invalid render module: job.pages[0].version: Invalid version",
    );
    await expect(resolveRenderJobs({ plate: fakePlate(), pages: [{ copy: {}, version: 2 }] })).rejects.toThrow(
      "Invalid render module: job.pages[0].version: Invalid version",
    );
  });

  it("names the plate factories when given a plate that cannot produce artifacts", async () => {
    const svgPlate = createSvgOg<Copy>({ alt: (copy) => copy.title, fonts: inter, component: card });
    await expect(resolveRenderJobs({ plate: svgPlate, pages: [page] })).rejects.toThrow(
      "job.plate has no artifact() method; metaplate render needs a plate from createNodeOg (metaplate/node) or createEdgeOg (metaplate/edge)",
    );
  });
});

describe("planImages", () => {
  const out = path.resolve("render-out");

  it("plans every page at the default size and then every variant, at nested image paths", () => {
    const plate = nodePlate({ basePath: "/project", origin: "https://example.com" });
    const images = planImages([{
      plate: plate as RenderablePlate<Copy> as RenderablePlate<unknown>,
      pages: [{ copy: { title: "Home" } }, { route: "/docs/guide/", copy: { title: "Guide" } }],
    }], out);
    expect(images.map(({ path: file, route, variant }) => ({ file, route, variant }))).toEqual([
      { file: "og-image.png", route: "/", variant: null },
      { file: "og-image-square.png", route: "/", variant: "square" },
      { file: "docs/guide/og-image.png", route: "/docs/guide/", variant: null },
      { file: "docs/guide/og-image-square.png", route: "/docs/guide/", variant: "square" },
    ]);
    // basePath and origin belong to the URL, not the deployed tree.
    expect(images[2]!.target).toBe(path.join(out, "docs", "guide", "og-image.png"));
    expect(plate.image("/docs/guide/", { title: "Guide" }).url)
      .toBe("https://example.com/project/docs/guide/og-image.png");
  });

  it("renders only one size when the job names a variant view", () => {
    const plate = nodePlate().variant("square");
    const images = planImages([{ plate, pages: [{ copy: { title: "Home" } }] }] as RenderJob<unknown>[], out);
    expect(images.map((image) => [image.path, image.variant])).toEqual([["og-image-square.png", "square"]]);
  });

  it("refuses two images that would land on one file, case-insensitively", () => {
    const plate = fakePlate();
    expect(() => planImages([{ plate, pages: [{ route: "/a", copy: 1 }, { route: "/a/", copy: 2 }] }], out))
      .toThrow("Invalid render module: /a/ and /a both write a/og-image.png");
    expect(() => planImages([
      { plate, pages: [{ route: "/Docs", copy: 1 }] },
      { plate, pages: [{ route: "/docs", copy: 2 }] },
    ], out)).toThrow("both write docs/og-image.png");
  });

  it("rejects dot-segment routes through the plate's own path rules", () => {
    expect(() => planImages([{ plate: nodePlate() as RenderablePlate<unknown>, pages: [{ route: "/a/../..", copy: {} }] }], out))
      .toThrow('route must not contain "." or ".." segments');
  });
});

describe("outputTarget", () => {
  const out = path.resolve("render-out");

  it("decodes percent-escapes the way a static host maps URLs onto files", () => {
    expect(outputTarget(out, "posts/caf%C3%A9/og-image.png")).toEqual({
      path: "posts/café/og-image.png",
      target: path.join(out, "posts", "café", "og-image.png"),
    });
  });

  it.each([
    ["../outside.png", "empty or dot segment"],
    ["a/%2e%2e/%2e%2e/outside.png", "empty or dot segment"],
    ["a/..%2F..%2Foutside.png", "not a portable file name"],
    ["a/..%5C..%5Coutside.png", "not a portable file name"],
    ["a//og.png", "empty or dot segment"],
    ["", "empty or dot segment"],
    ["C:%5Coutside.png", "not a portable file name"],
    ["a/b%00.png", "not a portable file name"],
    ["a/x:y/og.png", "not a portable file name"],
    ["con/og.png", "Windows cannot store"],
    ["a./og.png", "Windows cannot store"],
    ["a/%E0%A4%A.png", "malformed percent-escape"],
  ])("refuses %j", (sitePath, message) => {
    expect(() => outputTarget(out, sitePath)).toThrow(message);
  });

  it("refuses a plate whose site path climbs out of the output directory", () => {
    const plate = fakePlate({ sitePath: () => "../../escape.png" });
    expect(() => planImages([{ plate, pages: [{ copy: {} }] }], out)).toThrow("empty or dot segment");
  });
});

// Real renders load the native renderer and fonts on first use, which can pass
// Vitest's 5 s default on a cold macOS or Windows runner (6.3 s observed).
describe("renderFiles", { timeout: 30_000 }, () => {
  it("writes real plate renders whose manifest hashes match the files on disk", async () => {
    const out = await temporary("real");
    const plate = nodePlate({ basePath: "/project" }) as RenderablePlate<Copy> as RenderablePlate<unknown>;
    const images = planImages([{
      plate,
      pages: [{ copy: { title: "Home" } }, { route: "/posts/hello", copy: { title: "Hello" } }],
    }], out);
    const outcomes = await renderFiles(images, { outDir: out, concurrency: 2 });

    expect(outcomes.every((outcome) => outcome.valid)).toBe(true);
    const manifest = renderManifest(outcomes as ManifestImage[]);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.images.map(({ path: file, url, variant, size }) => ({ file, url, variant, size }))).toEqual([
      { file: "og-image.png", url: "/project/og-image.png", variant: null, size: LANDSCAPE },
      { file: "og-image-square.png", url: "/project/og-image-square.png", variant: "square", size: SQUARE },
      { file: "posts/hello/og-image.png", url: "/project/posts/hello/og-image.png", variant: null, size: LANDSCAPE },
      {
        file: "posts/hello/og-image-square.png",
        url: "/project/posts/hello/og-image-square.png",
        variant: "square",
        size: SQUARE,
      },
    ]);
    for (const image of manifest.images) {
      const bytes = await readFile(path.join(out, ...image.path.split("/")));
      expect(image).toMatchObject({
        format: "png",
        contentType: "image/png",
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        verified: true,
      });
      expect(verifyImage(bytes, image.size, "png").format).toBe("png");
      expect(Object.keys(image)).toEqual([
        "path", "url", "route", "variant", "size", "format", "contentType", "bytes", "sha256", "verified",
      ]);
    }
  });

  it("publishes versioned URLs in the manifest while writing unversioned paths", async () => {
    const out = await temporary("versioned");
    const plate = nodePlate({ basePath: "/project", version: "copy" }).variant("square");
    const home = { title: "Home" };
    const images = planImages([{
      plate: plate as RenderablePlate<Copy> as RenderablePlate<unknown>,
      pages: [{ copy: home }, { route: "/posts/hello", copy: { title: "Hello" }, version: "release-2" }],
    }], out);
    const outcomes = await renderFiles(images, { outDir: out, concurrency: 2 });

    expect(outcomes.every((outcome) => outcome.valid)).toBe(true);
    expect(renderManifest(outcomes as ManifestImage[]).images.map(({ path: file, url }) => ({ file, url }))).toEqual([
      { file: "og-image-square.png", url: `/project/og-image-square.png?v=${socialImageVersion(home)}` },
      { file: "posts/hello/og-image-square.png", url: "/project/posts/hello/og-image-square.png?v=release-2" },
    ]);
    expect(existsSync(path.join(out, "posts", "hello", "og-image-square.png"))).toBe(true);
  });

  it("writes an encoder's bytes and records an unrecognizable format as unverified", async () => {
    const out = await temporary("encoder");
    const avif = Uint8Array.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    const plate = createNodeOg<Copy>({
      alt: (copy) => copy.title,
      fonts: inter,
      imagePath: "og-image.avif",
      component: card,
      output: { contentType: "image/avif", checkSignature: false, encode: () => avif },
    });
    const [outcome] = await renderFiles(
      planImages([{ plate, pages: [{ copy: { title: "Home" } }] }] as RenderJob<unknown>[], out),
      { outDir: out, concurrency: 1 },
    );
    expect(outcome).toMatchObject({
      valid: true,
      path: "og-image.avif",
      format: null,
      contentType: "image/avif",
      bytes: avif.byteLength,
      sha256: sha256(avif),
      verified: false,
    });
  });

  it("never runs more renders at once than the concurrency limit", async () => {
    for (const limit of [1, 3]) {
      let inFlight = 0;
      let peak = 0;
      const plate = fakePlate({
        artifact: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return completePng(1200, 630);
        },
      }).variant("square");
      const out = await temporary("pool");
      const pages = Array.from({ length: 8 }, (_, index) => ({ route: `/p${index}`, copy: index }));
      const outcomes = await renderFiles(planImages([{ plate, pages }], out), { outDir: out, concurrency: limit });
      expect(peak).toBe(limit);
      // Results keep declaration order whatever order renders finish in.
      expect(outcomes.map((outcome) => outcome.route)).toEqual(pages.map((page) => page.route));
    }
  });

  it("reports a failed render or verification per image and still writes the rest", async () => {
    const out = await temporary("partial");
    const plate = fakePlate({
      variants: [],
      artifact: async (route) => {
        if (route === "/broken") throw new Error("component exploded");
        // A square's bytes under a landscape claim must fail verification.
        if (route === "/wrong-size") return completePng(1080, 1080);
        return completePng(1200, 630);
      },
    });
    const pages = [{ route: "/broken", copy: 1 }, { route: "/fine", copy: 2 }, { route: "/wrong-size", copy: 3 }];
    const outcomes: RenderOutcome[] = await renderFiles(planImages([{ plate, pages }], out), {
      outDir: out,
      concurrency: 2,
    });

    expect(outcomes.map((outcome) => [outcome.path, outcome.valid])).toEqual([
      ["broken/og-image.png", false],
      ["fine/og-image.png", true],
      ["wrong-size/og-image.png", false],
    ]);
    expect(outcomes[0]!.issues).toEqual([{ severity: "error", message: "component exploded" }]);
    expect(outcomes[2]!.issues[0]!.message).toBe("Expected 1200x630, received 1080x1080");
    expect(existsSync(path.join(out, "fine", "og-image.png"))).toBe(true);
  });

  it("refuses to write through a linked directory that leaves the output directory", async () => {
    const root = await temporary("link");
    const out = path.join(root, "out");
    const outside = path.join(root, "outside");
    await mkdir(out);
    await mkdir(outside);
    // Junctions need no privilege on Windows; elsewhere the type is ignored.
    await symlink(outside, path.join(out, "linked"), "junction");
    const outcomes = await renderFiles(
      planImages([{ plate: fakePlate({ variants: [] }), pages: [{ route: "/linked", copy: 1 }] }], out),
      { outDir: out, concurrency: 1 },
    );
    expect(outcomes[0]).toMatchObject({ valid: false, path: "linked/og-image.png" });
    expect(outcomes[0]!.issues[0]!.message).toContain("resolves outside the output directory");
    expect(existsSync(path.join(outside, "og-image.png"))).toBe(false);
  });
});

describe("metaplate render CLI", async () => {
  const bundlePath = await bundleCli();
  const pngBase64 = (width: number, height: number) => Buffer.from(completePng(width, height)).toString("base64");

  /**
   * A render module whose structural plate needs no renderer: the spawned CLI
   * is exercised end to end (loading, contract, paths, writes, verification,
   * manifest, exit code) without resolving `metaplate` from a temp dir.
   */
  function fakeModule(body: string) {
    return `
const sizes = { default: [1200, 630, ${JSON.stringify(pngBase64(1200, 630))}], square: [1080, 1080, ${JSON.stringify(pngBase64(1080, 1080))}] };
export function plate({ sitePath, bytesFor } = {}, name) {
  const [width, height, data] = sizes[name ?? "default"];
  const file = name ? "og-image-" + name + ".png" : "og-image.png";
  const pathFor = sitePath ?? ((route) => [route.replace(/^\\/+|\\/+$/g, ""), file].filter(Boolean).join("/"));
  return {
    variantName: name,
    variants: ["square"],
    variant: (variant) => plate({ sitePath, bytesFor }, variant),
    sitePath: pathFor,
    artifact: async (route) => ({
      bytes: bytesFor?.(route, name) ?? Buffer.from(data, "base64"),
      contentType: "image/png",
      format: "png",
      size: { width, height },
      metadata: { openGraph: { images: [{ url: "/site/" + pathFor(route) }] } },
    }),
  };
}
${body}
`;
  }

  async function project(files: Record<string, string>) {
    const cwd = await temporary("cli");
    for (const [name, source] of Object.entries(files)) await writeFile(path.join(cwd, name), source);
    return cwd;
  }

  it("renders every page and variant, prints each file, and writes a matching manifest", async () => {
    const cwd = await project({
      "og.render.mjs": fakeModule(`export default { plate: plate(), pages: [{ copy: {} }, { route: "/docs/start", copy: {} }] };`),
    });
    const result = runCli(bundlePath, ["render", "og.render.mjs", "--out", "site"], cwd);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ og-image.png 1200x630 png");
    expect(result.stdout).toContain("✓ docs/start/og-image-square.png 1080x1080 png");
    expect(result.stdout).toContain("Rendered 4 images into site; manifest site/metaplate-manifest.json");

    const manifest = JSON.parse(await readFile(path.join(cwd, "site", "metaplate-manifest.json"), "utf8"));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.images.map((image: ManifestImage) => [image.path, image.url, image.variant])).toEqual([
      ["og-image.png", "/site/og-image.png", null],
      ["og-image-square.png", "/site/og-image-square.png", "square"],
      ["docs/start/og-image.png", "/site/docs/start/og-image.png", null],
      ["docs/start/og-image-square.png", "/site/docs/start/og-image-square.png", "square"],
    ]);
    for (const image of manifest.images as ManifestImage[]) {
      const bytes = await readFile(path.join(cwd, "site", ...image.path.split("/")));
      expect(image.sha256).toBe(sha256(bytes));
      expect(image.bytes).toBe(bytes.byteLength);
    }
  });

  it("emits one stable JSON report and honors --manifest", async () => {
    const cwd = await project({
      "og.render.mjs": fakeModule(`export default async () => [{ plate: plate().variant("square"), pages: [{ route: "/a", copy: {} }] }];`),
    });
    const result = runCli(
      bundlePath,
      ["render", "--json", "--out", "public", "--manifest", "build/og.json", "og.render.mjs"],
      cwd,
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toEqual({
      schemaVersion: 1,
      out: "public",
      manifest: "build/og.json",
      images: [{
        path: "a/og-image-square.png",
        url: "/site/a/og-image-square.png",
        route: "/a",
        variant: "square",
        size: SQUARE,
        format: "png",
        contentType: "image/png",
        bytes: completePng(1080, 1080).byteLength,
        sha256: sha256(completePng(1080, 1080)),
        verified: true,
        valid: true,
        issues: [],
      }],
    });
    const manifest = JSON.parse(await readFile(path.join(cwd, "build", "og.json"), "utf8"));
    expect(manifest).toEqual({
      schemaVersion: 1,
      images: [Object.fromEntries(Object.entries(report.images[0]).filter(([key]) => key !== "valid" && key !== "issues"))],
    });
    expect(existsSync(path.join(cwd, "public", "metaplate-manifest.json"))).toBe(false);
  });

  it("exits non-zero, reports every failing image, and writes no manifest", async () => {
    const cwd = await project({
      "og.render.mjs": fakeModule(`
export default {
  plate: plate({ bytesFor: (route, name) => route === "/bad" && !name ? Buffer.from("not an image") : undefined }),
  pages: [{ route: "/bad", copy: {} }, { route: "/good", copy: {} }],
};`),
    });
    const human = runCli(bundlePath, ["render", "og.render.mjs"], cwd);
    expect(human.status).toBe(1);
    expect(human.stderr).toContain("✗ bad/og-image.png render failed: Unrecognized image");
    expect(human.stderr).toContain("1 of 4 images failed; no manifest was written");
    expect(human.stdout).toContain("✓ good/og-image.png 1200x630 png");
    expect(existsSync(path.join(cwd, "public", "metaplate-manifest.json"))).toBe(false);

    const json = runCli(bundlePath, ["render", "--json", "og.render.mjs"], cwd);
    expect(json.status).toBe(1);
    const report = JSON.parse(json.stdout);
    expect(report.manifest).toBeNull();
    expect(report.images[0]).toEqual({
      path: "bad/og-image.png",
      route: "/bad",
      variant: null,
      valid: false,
      issues: [{ severity: "error", message: expect.stringContaining("Unrecognized image") }],
    });
  });

  it("refuses a path outside --out before rendering anything", async () => {
    const cwd = await project({
      "og.render.mjs": fakeModule(`export default { plate: plate({ sitePath: () => "../escape.png" }), pages: [{ copy: {} }] };`),
    });
    const result = runCli(bundlePath, ["render", "--out", "site", "og.render.mjs"], cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Image path ../escape.png has an empty or dot segment");
    expect(existsSync(path.join(cwd, "escape.png"))).toBe(false);
    expect(existsSync(path.join(cwd, "site"))).toBe(false);
  });

  it("refuses a manifest path that is also an image path", async () => {
    const cwd = await project({
      "og.render.mjs": fakeModule(`export default { plate: plate(), pages: [{ copy: {} }] };`),
    });
    const result = runCli(bundlePath, ["render", "--out", "site", "--manifest", "site/og-image.png", "og.render.mjs"], cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("The manifest path site/og-image.png is also the image og-image.png\n");
    expect(existsSync(path.join(cwd, "site"))).toBe(false);
  });

  it("reports contract and load errors without the usage line, and argument errors with it", async () => {
    const cwd = await project({
      "empty.mjs": "export const plate = 1;\n",
      "missing-copy.mjs": fakeModule(`export default { plate: plate(), pages: [{ route: "/" }] };`),
    });
    const empty = runCli(bundlePath, ["render", "empty.mjs"], cwd);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toBe(
      "Invalid render module: expected a default export: a render job, an array of jobs, or a function returning either\n",
    );

    const missing = runCli(bundlePath, ["render", "missing-copy.mjs"], cwd);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("job.pages[0] must be an object with a copy property");

    const absent = runCli(bundlePath, ["render", "absent.mjs"], cwd);
    expect(absent.status).toBe(1);
    expect(absent.stderr).toContain("Cannot find module");
    expect(absent.stderr).not.toContain("Usage:");

    const usage = runCli(bundlePath, ["render"], cwd);
    expect(usage.status).toBe(1);
    expect(usage.stderr).toBe(`${RENDER_USAGE}\n`);
  });

  it("explains how to load JSX instead of failing on the extension", async () => {
    const cwd = await project({ "og.render.tsx": "export default <div />;\n" });
    const result = runCli(bundlePath, ["render", "og.render.tsx"], cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot load og.render.tsx: Node does not transform JSX");
  });

  // Type stripping is on by default from Node 22.18 and 23.6; Node 20 has none.
  const strips = Boolean((process.features as { typescript?: unknown }).typescript);
  it.runIf(strips)("loads a TypeScript module through Node's type stripping", async () => {
    const cwd = await project({
      "plate.mjs": fakeModule(""),
      "og.render.ts": `
import { plate } from "./plate.mjs";
type Copy = { title: string };
const pages: { route?: string; copy: Copy }[] = [{ copy: { title: "Home" } }];
export default { plate: plate(), pages };
`,
      "enum.ts": "enum Size { Large }\nexport default Size;\n",
    });
    const result = runCli(bundlePath, ["render", "og.render.ts"], cwd);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(existsSync(path.join(cwd, "public", "og-image-square.png"))).toBe(true);

    const enumResult = runCli(bundlePath, ["render", "enum.ts"], cwd);
    expect(enumResult.status).toBe(1);
    expect(enumResult.stderr).toContain("Node strips only erasable TypeScript syntax");
  });
});
