import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fontsourceFontLoader } from "../../src/fonts.js";
import { extractPageSocialMetadata } from "../../src/verify/html-metadata.js";
import { createNodeOg } from "../../src/node.js";
import {
  planHtmlPages,
  planImages,
  preflightHtmlPages,
  renderFiles,
  resolveRenderJobs,
  writeHtmlPages,
  type ManifestImage,
  type RenderablePlate,
} from "../../src/render/files.js";
import { bundleCli, runCli } from "../helpers/cli-bundle.js";
import { completePng } from "../helpers/image-fixtures.js";

const START = "<!-- metaplate:social -->";
const END = "<!-- /metaplate:social -->";

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Rebrand</title>
  </head>
  <body><h1>Rebrand</h1></body>
</html>
`;

function temporary(prefix: string) {
  return mkdtemp(path.join(tmpdir(), `metaplate-render-html-${prefix}-`));
}

describe("render module contract for html pages", () => {
  const plate: RenderablePlate<unknown> = {
    variantName: undefined,
    variants: [],
    variant: () => plate,
    sitePath: () => "og-image.png",
    artifact: async () => { throw new Error("unused"); },
    metadata: () => ({ openGraph: { images: [{ url: "https://example.com/og-image.png" }] } }),
  };

  it("keeps html and page", async () => {
    const page = { route: "/r", copy: {}, html: "public/r/index.html", page: { title: "R", url: "https://example.com/r/" } };
    const [job] = await resolveRenderJobs({ plate, pages: [page] });
    expect(job!.pages).toEqual([page]);
  });

  it.each([
    [{ copy: {}, html: "" }, "job.pages[0].html must be a non-empty path to an HTML file"],
    [{ copy: {}, html: 3 }, "job.pages[0].html must be a non-empty path to an HTML file"],
    [{ copy: {}, page: { title: "x" } }, "job.pages[0].page has no effect without job.pages[0].html"],
    [{ copy: {}, html: "a.html", page: "x" }, "job.pages[0].page must be an object"],
    [{ copy: {}, html: "a.html", page: { tittle: "x" } }, "job.pages[0].page has unknown field tittle; expected title, description, url"],
    [{ copy: {}, html: "a.html", page: { indent: "  " } }, "job.pages[0].page has unknown field indent"],
  ])("rejects %j", async (page, message) => {
    await expect(resolveRenderJobs({ plate, pages: [page] })).rejects.toThrow(`Invalid render module: ${message}`);
  });

  it("refuses html on a plate without metadata(), two pages naming one file, and a path outside the root", () => {
    const root = path.resolve("project");
    const bare = { ...plate, metadata: undefined };
    expect(() => planHtmlPages([{ plate: bare as unknown as RenderablePlate<unknown>, pages: [{ copy: {}, html: "a.html" }] }], "out", root))
      .toThrow("job.pages[0].html needs a plate with a metadata() method");
    expect(() => planHtmlPages([{ plate, pages: [{ copy: {}, html: "a.html" }, { route: "/b", copy: {}, html: "A.HTML" }] }], "out", root))
      .toThrow("Invalid render module: job.pages[1] and job.pages[0] both write A.HTML");
    expect(() => planHtmlPages([{ plate, pages: [{ copy: {}, html: "../a.html" }] }], "out", root))
      .toThrow("Invalid render module: job.pages[0].html ../a.html resolves outside the project directory");
  });
});

describe("writing tags with a real plate", { timeout: 30_000 }, () => {
  it("publishes exactly the manifest's versioned URLs, and an unchanged page is not rewritten", async () => {
    const root = await temporary("plate");
    const out = path.join(root, "public");
    await mkdir(path.join(out, "rebrand"), { recursive: true });
    const htmlFile = path.join(out, "rebrand", "index.html");
    await writeFile(htmlFile, PAGE);
    const og = createNodeOg<{ title: string }, "square">({
      alt: (copy) => copy.title,
      fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
      imagePath: "og-image.png",
      origin: "https://example.com",
      basePath: "/docs",
      version: "copy",
      variants: { square: { size: { width: 1080, height: 1080 } } },
      component: (copy) => ({ type: "div", props: { style: { display: "flex", fontFamily: "Inter", fontSize: 64 }, children: copy.title } }),
    }) as RenderablePlate<{ title: string }> as RenderablePlate<unknown>;
    const jobs = await resolveRenderJobs({
      plate: og,
      pages: [{
        route: "/rebrand/",
        copy: { title: "Rebrand & <Co>" },
        html: path.join("public", "rebrand", "index.html"),
        page: { title: "Rebrand & <Co>", url: "https://example.com/docs/rebrand/", siteName: "Example" },
      }],
    });
    const pages = planHtmlPages(jobs, out, root);
    expect(pages.map((page) => page.path)).toEqual(["public/rebrand/index.html"]);
    await preflightHtmlPages(pages, root);

    const outcomes = await renderFiles(planImages(jobs, out), { outDir: out, concurrency: 2 });
    expect(outcomes.every((outcome) => outcome.valid)).toBe(true);
    const first = await writeHtmlPages(pages, outcomes, root);
    expect(first).toEqual([{ path: "public/rebrand/index.html", route: "/rebrand/", valid: true, changed: true, issues: [] }]);

    const html = await readFile(htmlFile, "utf8");
    const found = extractPageSocialMetadata(html, "https://example.com/docs/rebrand/");
    expect(found.openGraph.images.map((image) => image.url)).toEqual((outcomes as ManifestImage[]).map((image) => image.url));
    expect(found.openGraph.images[0]!.url).toMatch(/^https:\/\/example\.com\/docs\/rebrand\/og-image\.png\?v=[0-9a-f]{8}$/);
    expect(found.openGraph.title).toBe("Rebrand & <Co>");
    expect(html).toContain('<meta property="og:title" content="Rebrand &amp; &lt;Co&gt;">');
    expect(html).toContain('<meta property="og:url" content="https://example.com/docs/rebrand/">');
    expect(html).toContain('<meta property="og:image:type" content="image/png">');
    expect(html).toContain('<meta name="twitter:image:alt" content="Rebrand &amp; &lt;Co&gt;">');
    expect(html.split(START)).toHaveLength(2);

    const before = await stat(htmlFile);
    const second = await writeHtmlPages(pages, outcomes, root);
    expect(second[0]).toMatchObject({ valid: true, changed: false });
    expect(await readFile(htmlFile, "utf8")).toBe(html);
    expect((await stat(htmlFile)).mtimeMs).toBe(before.mtimeMs);
  });
});

describe("metaplate render with html pages", async () => {
  const bundlePath = await bundleCli();
  const png = (width: number, height: number) => Buffer.from(completePng(width, height)).toString("base64");

  /** A structural plate with `metadata()`, so the spawned CLI needs no renderer. */
  function fakeModule(body: string) {
    return `
const sizes = { default: [1200, 630, ${JSON.stringify(png(1200, 630))}], square: [1080, 1080, ${JSON.stringify(png(1080, 1080))}] };
const versioned = (url, options) => options?.version ? url + "?v=" + options.version : url;
export function plate({ bytesFor, fingerprint, origin = "https://example.com" } = {}, name) {
  const [width, height, data] = sizes[name ?? "default"];
  const file = (size) => size ? "og-image-" + size + ".png" : "og-image.png";
  const pathFor = (route, size) => [route.replace(/^\\/+|\\/+$/g, ""), file(size)].filter(Boolean).join("/");
  const url = (route, size, options) => versioned(origin + "/" + pathFor(route, size), options);
  return {
    variantName: name,
    variants: ["square"],
    variant: (variant) => plate({ bytesFor, fingerprint, origin }, variant),
    sitePath: (route) => pathFor(route, name),
    artifact: async (route, copy, options) => ({
      bytes: bytesFor?.(route, name) ?? Buffer.from(data, "base64"),
      contentType: "image/png",
      format: "png",
      size: { width, height },
      metadata: { openGraph: { images: [{ url: url(route, name, options) }] } },
    }),
    metadata: (route, copy, options) => {
      const sizes = name ? [name] : [undefined, "square"];
      const images = sizes.map((size) => ({ url: url(route, size, options), width: 1, height: 1, alt: copy.title }));
      return { openGraph: { images }, twitter: { card: "summary_large_image", images: [images[0]] } };
    },
    image: (route, copy, options) => ({ url: url(route, name, options) }),
    ...(fingerprint === undefined ? {} : { fingerprint: async () => fingerprint + ":" + (name ?? "default") }),
  };
}
${body}
`;
  }

  async function project(files: Record<string, string>) {
    const cwd = await temporary("cli");
    for (const [name, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
      await writeFile(path.join(cwd, name), source);
    }
    return cwd;
  }

  const read = (cwd: string, file: string) => readFile(path.join(cwd, ...file.split("/")), "utf8");

  it("inserts the tags the first time, leaves the page alone on a re-run, and replaces the block when they change", async () => {
    const cwd = await project({
      "version.txt": "r1",
      "pages/rebrand.html": PAGE,
      "og.render.mjs": fakeModule(`
import { readFileSync } from "node:fs";
export default {
  plate: plate(),
  pages: [
    { route: "/", copy: { title: "Home" } },
    {
      route: "/rebrand/",
      copy: { title: "Rebrand" },
      version: readFileSync("version.txt", "utf8"),
      html: "pages/rebrand.html",
      page: { title: "Rebrand", description: "Our new look", url: "https://example.com/rebrand/", siteName: "Example" },
    },
  ],
};`),
    });

    const first = runCli(bundlePath, ["render", "og.render.mjs"], cwd);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("✓ pages/rebrand.html social tags written\n");
    expect(first.stdout).toContain("Wrote social tags into 1 of 1 HTML pages (0 unchanged)");
    const html = await read(cwd, "pages/rebrand.html");
    expect(html).toBe(PAGE.replace("  </head>", [
      `    ${START}`,
      '    <meta property="og:image" content="https://example.com/rebrand/og-image.png?v=r1">',
      '    <meta property="og:image:width" content="1">',
      '    <meta property="og:image:height" content="1">',
      '    <meta property="og:image:alt" content="Rebrand">',
      '    <meta property="og:image" content="https://example.com/rebrand/og-image-square.png?v=r1">',
      '    <meta property="og:image:width" content="1">',
      '    <meta property="og:image:height" content="1">',
      '    <meta property="og:image:alt" content="Rebrand">',
      '    <meta name="twitter:card" content="summary_large_image">',
      '    <meta name="twitter:image" content="https://example.com/rebrand/og-image.png?v=r1">',
      '    <meta name="twitter:image:alt" content="Rebrand">',
      '    <meta property="og:title" content="Rebrand">',
      '    <meta property="og:description" content="Our new look">',
      '    <meta property="og:url" content="https://example.com/rebrand/">',
      '    <meta property="og:site_name" content="Example">',
      '    <meta property="og:type" content="website">',
      `    ${END}`,
      "  </head>",
    ].join("\n")));
    const manifest = JSON.parse(await read(cwd, "public/metaplate-manifest.json")) as { images: ManifestImage[] };
    for (const image of manifest.images.filter((entry) => entry.route === "/rebrand/")) {
      expect(html).toContain(`<meta property="og:image" content="${image.url}">`);
    }

    const before = await stat(path.join(cwd, "pages", "rebrand.html"));
    const second = runCli(bundlePath, ["render", "og.render.mjs"], cwd);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("✓ pages/rebrand.html social tags unchanged\n");
    expect(second.stdout).toContain("Wrote social tags into 0 of 1 HTML pages (1 unchanged)");
    expect(await read(cwd, "pages/rebrand.html")).toBe(html);
    expect((await stat(path.join(cwd, "pages", "rebrand.html"))).mtimeMs).toBe(before.mtimeMs);

    await writeFile(path.join(cwd, "version.txt"), "r2");
    expect(runCli(bundlePath, ["render", "og.render.mjs"], cwd).status).toBe(0);
    expect(await read(cwd, "pages/rebrand.html")).toBe(html.replaceAll("?v=r1", "?v=r2"));
  });

  it("writes a page saved with a byte order mark and CRLF, keeping both, and leaves it alone on a re-run", async () => {
    const original = String.fromCharCode(0xfeff) + PAGE.replaceAll("\n", "\r\n");
    const cwd = await project({
      "public/index.html": original,
      "og.render.mjs": fakeModule(`
export default { plate: plate(), pages: [{ copy: { title: "Home" }, html: "public/index.html", page: { url: "https://example.com/" } }] };`),
    });
    const file = path.join(cwd, "public", "index.html");
    const first = runCli(bundlePath, ["render", "og.render.mjs"], cwd);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    const bytes = await readFile(file);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const html = bytes.toString("utf8");
    expect(html.slice(1).startsWith("<!doctype html>\r\n")).toBe(true);
    expect(html).toContain(`    ${START}\r\n    <meta property="og:image" content="https://example.com/og-image.png">\r\n`);
    expect(html.replaceAll("\r\n", "")).not.toContain("\n");
    expect(html.replace(/ {4}<!-- metaplate:social -->[\s\S]*<!-- \/metaplate:social -->\r\n/, "")).toBe(original);
    const metadata = extractPageSocialMetadata(html.slice(1), "https://example.com/");
    expect(metadata.openGraph.images.map((image) => image.url)).toEqual([
      "https://example.com/og-image.png",
      "https://example.com/og-image-square.png",
    ]);

    const before = await stat(file);
    const second = runCli(bundlePath, ["render", "og.render.mjs"], cwd);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("social tags unchanged");
    expect((await readFile(file)).equals(bytes)).toBe(true);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it("with --incremental, reuses the images and does not rewrite an unchanged page", async () => {
    const cwd = await project({
      "public/index.html": PAGE,
      "og.render.mjs": fakeModule(`
export default { plate: plate({ fingerprint: "1" }), pages: [{ copy: { title: "Home" }, html: "public/index.html", page: { url: "https://example.com/" } }] };`),
    });
    const run = () => {
      const result = runCli(bundlePath, ["render", "--json", "--incremental", "og.render.mjs"], cwd);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout) as { images: { reused: boolean }[]; html: unknown[] };
    };
    const first = run();
    expect(first.images.map((image) => image.reused)).toEqual([false, false]);
    expect(first.html).toEqual([{ path: "public/index.html", route: "/", valid: true, changed: true, issues: [] }]);
    const html = await read(cwd, "public/index.html");
    const before = await stat(path.join(cwd, "public", "index.html"));

    const second = run();
    expect(second.images.map((image) => image.reused)).toEqual([true, true]);
    expect(second.html).toEqual([{ path: "public/index.html", route: "/", valid: true, changed: false, issues: [] }]);
    expect(await read(cwd, "public/index.html")).toBe(html);
    expect((await stat(path.join(cwd, "public", "index.html"))).mtimeMs).toBe(before.mtimeMs);
  });

  it("leaves a page untouched when one of its images fails, and still writes the other pages", async () => {
    const cwd = await project({
      "public/bad/index.html": PAGE,
      "public/good/index.html": PAGE,
      "og.render.mjs": fakeModule(`
export default {
  plate: plate({ bytesFor: (route, name) => route === "/bad" && name === "square" ? Buffer.from("not an image") : undefined }),
  pages: [
    { route: "/bad", copy: { title: "Bad" }, html: "public/bad/index.html" },
    { route: "/good", copy: { title: "Good" }, html: "public/good/index.html" },
  ],
};`),
    });
    const human = runCli(bundlePath, ["render", "og.render.mjs"], cwd);
    expect(human.status).toBe(1);
    expect(human.stderr).toContain("✗ public/bad/index.html social tags not written: left unchanged because an image of this page failed");
    expect(human.stderr).toContain("1 of 4 images failed; no manifest was written");
    expect(human.stderr).toContain("1 of 2 HTML pages were not written; no manifest was written");
    expect(human.stdout).toContain("✓ public/good/index.html social tags written");
    expect(await read(cwd, "public/bad/index.html")).toBe(PAGE);
    expect(await read(cwd, "public/good/index.html")).toContain(START);
    expect(existsSync(path.join(cwd, "public", "metaplate-manifest.json"))).toBe(false);

    const json = runCli(bundlePath, ["render", "--json", "og.render.mjs"], cwd);
    const report = JSON.parse(json.stdout) as { manifest: unknown; html: unknown[] };
    expect(report.manifest).toBeNull();
    expect(report.html[0]).toEqual({
      path: "public/bad/index.html",
      route: "/bad",
      valid: false,
      issues: [{ severity: "error", message: "left unchanged because an image of this page failed" }],
    });
  });

  it.each([
    ["no </head>", "<html><body></body></html>", "public/index.html: the page has no </head> and no <!-- metaplate:social --> block"],
    ["a start marker without an end", `<head>${START}</head>`, "public/index.html: the page has <!-- metaplate:social --> without <!-- /metaplate:social -->"],
    ["duplicated markers", `<head>${START}${END}\n${START}${END}</head>`, "expected at most one block"],
    ["a stale og:image", `<head><meta property="og:image" content="https://example.com/old.png"></head>`, "image tags outside the <!-- metaplate:social --> block"],
  ])("refuses a page with %s before rendering anything, and keeps the previous manifest", async (_name, page, message) => {
    const cwd = await project({
      "good.mjs": fakeModule(`export default { plate: plate(), pages: [{ copy: { title: "Home" } }] };`),
      "public/index.html": page,
      "og.render.mjs": fakeModule(`
export default { plate: plate(), pages: [{ route: "/a", copy: { title: "A" }, html: "public/index.html" }] };`),
    });
    expect(runCli(bundlePath, ["render", "good.mjs"], cwd).status).toBe(0);
    const result = runCli(bundlePath, ["render", "og.render.mjs"], cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain("Usage:");
    expect(await read(cwd, "public/index.html")).toBe(page);
    expect(existsSync(path.join(cwd, "public", "a"))).toBe(false);
    expect(existsSync(path.join(cwd, "public", "metaplate-manifest.json"))).toBe(true);
  });

  it("refuses a missing page, a page outside the project, and a page that is also an output", async () => {
    const cwd = await project({
      "missing.mjs": fakeModule(`export default { plate: plate(), pages: [{ copy: { title: "A" }, html: "public/none.html" }] };`),
      "outside.mjs": fakeModule(`export default { plate: plate(), pages: [{ copy: { title: "A" }, html: "../index.html" }] };`),
      "manifest.mjs": fakeModule(`export default { plate: plate(), pages: [{ copy: { title: "A" }, html: "public/m.html" }] };`),
    });
    const missing = runCli(bundlePath, ["render", "missing.mjs"], cwd);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("public/none.html: the file does not exist; metaplate render edits an existing page");
    const outside = runCli(bundlePath, ["render", "outside.mjs"], cwd);
    expect(outside.status).toBe(1);
    expect(outside.stderr).toContain("job.pages[0].html ../index.html resolves outside the project directory");
    const manifest = runCli(bundlePath, ["render", "--manifest", "public/m.html", "manifest.mjs"], cwd);
    expect(manifest.status).toBe(1);
    expect(manifest.stderr).toContain("The HTML page public/m.html is also the manifest");
    expect(existsSync(path.join(cwd, "public"))).toBe(false);
  });

  it("requires page.url when the plate publishes relative image URLs", async () => {
    const cwd = await project({
      "public/index.html": PAGE,
      "og.render.mjs": fakeModule(`
export default { plate: plate({ origin: "" }), pages: [{ copy: { title: "A" }, html: "public/index.html" }] };`),
      "fixed.mjs": fakeModule(`
export default { plate: plate({ origin: "" }), pages: [{ copy: { title: "A" }, html: "public/index.html", page: { url: "https://example.com/" } }] };`),
    });
    const result = runCli(bundlePath, ["render", "og.render.mjs"], cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the page would get the relative image URL /og-image.png");
    expect(runCli(bundlePath, ["render", "fixed.mjs"], cwd).status).toBe(0);
    expect(await read(cwd, "public/index.html")).toContain('<meta property="og:image" content="https://example.com/og-image.png">');
  });

  it("omits the html report field for a module that names no pages", async () => {
    const cwd = await project({ "og.render.mjs": fakeModule(`export default { plate: plate(), pages: [{ copy: { title: "A" } }] };`) });
    const result = runCli(bundlePath, ["render", "--json", "og.render.mjs"], cwd);
    expect(result.status).toBe(0);
    expect(Object.keys(JSON.parse(result.stdout))).toEqual(["schemaVersion", "out", "manifest", "images"]);
    expect(result.stdout).not.toContain("HTML");
  });
});
