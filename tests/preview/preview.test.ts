import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PREVIEW_HOST,
  DEFAULT_PREVIEW_PORT,
  parsePreviewInvocation,
  PREVIEW_USAGE,
} from "../../src/cli/args.js";
import { fontsourceFontLoader } from "../../src/fonts.js";
import { createNodeOg } from "../../src/node.js";
import { cropRegion, escapeHtml, galleryHtml } from "../../src/preview/page.js";
import {
  createReloadScheduler,
  GALLERY_CSP,
  isAllowedHostHeader,
  isLoopbackHost,
  startPreviewServer,
  tagLocalImport,
  watchTargets,
  type PreviewServer,
} from "../../src/preview/server.js";
import type { RenderablePlate } from "../../src/render/files.js";
import { bundleCli, runCli } from "../helpers/cli-bundle.js";
import { completePng } from "../helpers/image-fixtures.js";

const LANDSCAPE = { width: 1200, height: 630 };
const SQUARE = { width: 1080, height: 1080 };

describe("parsePreviewInvocation", () => {
  it("defaults to loopback on the preview port", () => {
    expect(parsePreviewInvocation(["preview", "og.render.mjs"])).toEqual({
      module: "og.render.mjs",
      host: DEFAULT_PREVIEW_HOST,
      port: DEFAULT_PREVIEW_PORT,
      socialTargets: [],
    });
  });

  it("parses the listen address and target checks in any order", () => {
    expect(parsePreviewInvocation([
      "preview", "--target", "linkedin", "og.ts", "--port", "0", "--host", "::1", "--max-file-size", "5000000",
    ])).toEqual({
      module: "og.ts",
      host: "::1",
      port: 0,
      socialTargets: ["linkedin"],
      maxFileSize: 5_000_000,
    });
  });

  it.each([
    [["preview"]],
    [["preview", "a.mjs", "b.mjs"]],
    [["preview", "--size", "1200x630", "a.mjs"]],
    [["preview", "--json", "a.mjs"]],
    [["preview", "--port", "65536", "a.mjs"]],
    [["preview", "--port", "-1", "a.mjs"]],
    [["preview", "--host", "--port", "a.mjs"]],
  ])("rejects %j with the preview usage", (args) => {
    expect(() => parsePreviewInvocation(args)).toThrow(PREVIEW_USAGE);
  });
});

describe("preview page", () => {
  it("escapes every character that can leave a text node or attribute", () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe(
      "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;",
    );
  });

  it.each([
    [LANDSCAPE, 2, { x: 0, y: 15, width: 1200, height: 600 }],
    [LANDSCAPE, 1, { x: 285, y: 0, width: 630, height: 630 }],
    [LANDSCAPE, 1.91, { x: 0, y: 1, width: 1200, height: 628 }],
    [SQUARE, 1.91, { x: 0, y: 257, width: 1080, height: 565 }],
    [SQUARE, 1, { x: 0, y: 0, width: 1080, height: 1080 }],
  ])("centers the largest %j region at ratio %d", (size, ratio, region) => {
    expect(cropRegion(size, ratio)).toEqual(region);
  });

  it("renders module-supplied text escaped and the module error in an alert", () => {
    const html = galleryHtml({
      module: "og<1>.mjs",
      version: "v1",
      generation: 1,
      loadedAt: new Date(0),
      error: "<script>alert(1)</script>",
      images: [{
        index: 0,
        path: "a/og-image.png",
        route: "/<b>",
        variant: null,
        result: { ok: false, message: "</pre><script>x()</script>" },
      }],
      targets: [],
      tracksImports: false,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("og&lt;1&gt;.mjs");
    expect(html).toContain("&lt;/pre&gt;&lt;script&gt;x()&lt;/script&gt;");
    expect(html).toContain("module.registerHooks");
  });
});

describe("preview server helpers", () => {
  it("propagates a preview tag to local imports only", () => {
    const parent = "file:///project/og.render.mjs?metaplate-preview=3";
    expect(tagLocalImport("file:///project/plate.mjs", parent)).toBe("file:///project/plate.mjs?metaplate-preview=3");
    expect(tagLocalImport("file:///project/node_modules/metaplate/dist/node.js", parent)).toBeUndefined();
    expect(tagLocalImport("node:fs", parent)).toBeUndefined();
    expect(tagLocalImport("file:///project/plate.mjs", "file:///project/other.mjs")).toBeUndefined();
    expect(tagLocalImport("file:///project/plate.mjs", undefined)).toBeUndefined();
    expect(tagLocalImport("file:///project/a.mjs?metaplate-preview=2", parent)).toBeUndefined();
  });

  it("watches each file through its directory", () => {
    const root = path.resolve("project");
    const targets = watchTargets([path.join(root, "og.mjs"), path.join(root, "plate.mjs"), path.join(root, "lib", "x.mjs")]);
    expect([...targets].map(([directory, names]) => [directory, [...names]])).toEqual([
      [root, ["og.mjs", "plate.mjs"]],
      [path.join(root, "lib"), ["x.mjs"]],
    ]);
  });

  it.each([
    ["127.0.0.1", true],
    ["127.4.5.6", true],
    ["localhost", true],
    ["[::1]", true],
    ["::1", true],
    ["0.0.0.0", false],
    ["192.168.1.2", false],
    ["example.com", false],
  ])("treats %s as loopback: %s", (host, loopback) => {
    expect(isLoopbackHost(host)).toBe(loopback);
  });

  it("accepts only loopback Host headers while listening on loopback", () => {
    expect(isAllowedHostHeader("127.0.0.1:4323", "127.0.0.1")).toBe(true);
    expect(isAllowedHostHeader("localhost:4323", "127.0.0.1")).toBe(true);
    expect(isAllowedHostHeader("[::1]:4323", "::1")).toBe(true);
    expect(isAllowedHostHeader("rebind.example:4323", "127.0.0.1")).toBe(false);
    expect(isAllowedHostHeader(undefined, "127.0.0.1")).toBe(false);
    expect(isAllowedHostHeader("anything.example", "0.0.0.0")).toBe(true);
  });

  it("collapses bursts and queues one reload behind a running one", async () => {
    let runs = 0;
    let release: () => void = () => undefined;
    const scheduler = createReloadScheduler(async () => {
      runs += 1;
      if (runs === 1) await new Promise<void>((resolve) => { release = resolve; });
    }, 5);
    scheduler.schedule();
    scheduler.schedule();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toBe(1);
    scheduler.schedule();
    scheduler.schedule();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toBe(1);
    release();
    await scheduler.idle();
    expect(runs).toBe(2);
  });
});

type FakeOptions = { bytesFor?: (route: string, name: string | undefined) => Uint8Array | undefined; debuggable?: boolean };

/** A structural plate with one `square` variant that returns fixed PNG bytes. */
function fakePlate(options: FakeOptions = {}, name?: string): RenderablePlate<unknown> {
  const size = name === undefined ? LANDSCAPE : SQUARE;
  const file = name === undefined ? "og-image.png" : `og-image-${name}.png`;
  const sitePath = (route: string) => [route.replace(/^\/+|\/+$/g, ""), file].filter(Boolean).join("/");
  return {
    variantName: name,
    variants: ["square"],
    variant: (variant: string) => fakePlate(options, variant),
    sitePath,
    artifact: async (route: string) => ({
      bytes: options.bytesFor?.(route, name) ?? completePng(size.width, size.height),
      contentType: "image/png",
      format: "png",
      size,
      metadata: { openGraph: { images: [{ url: `https://example.com/${sitePath(route)}`, alt: `Card for ${route}` }] } },
    }),
    ...(options.debuggable ? { renderSvg: async (_copy: unknown, render?: { debug?: boolean }) => `<svg debug="${render?.debug}"/>` } : {}),
  };
}

const servers: PreviewServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(
  exported: () => unknown,
  extra: Partial<Parameters<typeof startPreviewServer>[0]> = {},
) {
  const server = await startPreviewServer({
    module: "og.render.mjs",
    entry: path.resolve("og.render.mjs"),
    host: "127.0.0.1",
    port: 0,
    load: async () => exported(),
    watch: () => () => undefined,
    ...extra,
  });
  servers.push(server);
  return server;
}

describe("startPreviewServer", () => {
  it("serves one card per page and size, each image, and the owned headers", async () => {
    const server = await serve(() => ({
      plate: fakePlate(),
      pages: [{ copy: {} }, { route: "/posts/a&b's", copy: {} }],
    }), { socialTargets: ["linkedin"] });
    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(GALLERY_CSP);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html.match(/<article class="card"/g)).toHaveLength(4);
    expect(html).toContain("<h2>/posts/a&amp;b&#39;s</h2>");
    expect(html).toContain("Card for /posts/a&amp;b&#39;s");
    expect(html).toContain("<strong>linkedin</strong> incompatible");
    expect(html).toContain("LinkedIn full-size previews require at least 1200x627 pixels.");
    // No inline script or style: the only script is the external preview.js.
    expect(html.match(/<script\b[^>]*>/gi)).toEqual(['<script src="/assets/preview.js" defer>']);
    expect(html).not.toMatch(/<style\b|\sstyle\s*=/i);

    const image = await fetch(new URL("/image/3", server.url));
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(completePng(1080, 1080));
    expect((await fetch(new URL("/image/9", server.url))).status).toBe(404);
    // The fake plate has no renderSvg, so there is no debug view to serve.
    expect((await fetch(new URL("/debug/0.svg", server.url))).status).toBe(404);
    expect((await fetch(new URL("/image/0", server.url), { method: "POST" })).status).toBe(405);
  });

  it("serves the Satori debug SVG when the plate has renderSvg", async () => {
    const server = await serve(() => ({ plate: fakePlate({ debuggable: true }), pages: [{ copy: {} }] }));
    const debug = await fetch(new URL("/debug/0.svg", server.url));
    expect(debug.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(await debug.text()).toBe('<svg debug="true"/>');
  });

  it("reports a failing image on its card and keeps the rest", async () => {
    const server = await serve(() => ({
      plate: fakePlate({ bytesFor: (route, name) => route === "/bad" && !name ? completePng(1080, 1080) : undefined }),
      pages: [{ route: "/bad", copy: {} }],
    }));
    const html = await (await fetch(server.url)).text();
    expect(html).toContain('<pre class="error" role="alert">Expected 1200x630, received 1080x1080</pre>');
    expect(html.match(/<article class="card"/g)).toHaveLength(1);
    expect((await fetch(new URL("/image/0", server.url))).status).toBe(500);
  });

  it("shows a module error, then recovers on reload, announcing each version", async () => {
    let broken = true;
    const server = await serve(() => {
      if (broken) throw new SyntaxError("Unexpected end of input");
      return { plate: fakePlate(), pages: [{ copy: {} }] };
    });
    expect(await (await fetch(server.url)).text()).toContain("<pre>Unexpected end of input</pre>");

    const controller = new AbortController();
    const events = await fetch(new URL("/events", server.url), { signal: controller.signal });
    const reader = events.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toMatch(/event: version\ndata: [\w-]+:1\n/);

    broken = false;
    await server.reload();
    expect(server.generation()).toBe(2);
    const second = new TextDecoder().decode((await reader.read()).value);
    expect(second).toMatch(/data: [\w-]+:2\n/);
    controller.abort();
    const html = await (await fetch(server.url)).text();
    expect(html).not.toContain("module-error");
    expect(html.match(/<article class="card"/g)).toHaveLength(2);
  });

  it("refuses a path render would refuse, before rendering", async () => {
    const plate = { ...fakePlate(), variants: [], sitePath: () => "../escape.png" };
    const server = await serve(() => ({ plate, pages: [{ copy: {} }] }));
    expect(await (await fetch(server.url)).text()).toContain("Image path ../escape.png has an empty or dot segment");
  });

  it("answers only requests addressed to this machine", async () => {
    const server = await serve(() => ({ plate: fakePlate(), pages: [{ copy: {} }] }));
    const { request } = await import("node:http");
    const status = await new Promise<number | undefined>((resolve, reject) => {
      request({ host: "127.0.0.1", port: server.port, path: "/", headers: { Host: "rebind.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject).end();
    });
    expect(status).toBe(403);
  });

  it("names the busy port and how to choose another", async () => {
    const first = await serve(() => ({ plate: fakePlate(), pages: [{ copy: {} }] }));
    await expect(serve(() => ({ plate: fakePlate(), pages: [{ copy: {} }] }), { port: first.port }))
      .rejects.toThrow(`Port ${first.port} on 127.0.0.1 is already in use; pass --port`);
  });
});

describe("renderSvg debug option", { timeout: 30_000 }, () => {
  it("draws Satori's layout boxes only when asked", async () => {
    const og = createNodeOg<{ title: string }>({
      alt: (copy) => copy.title,
      fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
      component: (copy) => ({
        type: "div",
        props: { style: { width: "100%", height: "100%", display: "flex", fontFamily: "Inter" }, children: copy.title },
      }),
    });
    const copy = { title: "Boxes" };
    expect(await og.renderSvg(copy)).not.toContain("#ff5757");
    expect(await og.renderSvg(copy, { debug: true })).toContain('stroke="#ff5757"');
  });
});

describe("metaplate preview CLI", { timeout: 60_000 }, async () => {
  const bundlePath = await bundleCli();
  const png = Buffer.from(completePng(1200, 630)).toString("base64");

  /** Starts the CLI, waits for its URL line, and returns it with a stop function. */
  async function start(cwd: string, args: string[]) {
    const child = spawn(process.execPath, [bundlePath, "preview", "--port", "0", ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const match = /at (http:\/\/\S+)/.exec(stdout);
        if (match) resolve(match[1]!);
      });
      child.on("exit", (code) => reject(new Error(`preview exited ${code}: ${stderr}`)));
    });
    return {
      url,
      stderr: () => stderr,
      stop: () => new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
        child.kill();
      }),
    };
  }

  async function until(check: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for the preview to reload");
  }

  const tracks = typeof (nodeModule as { registerHooks?: unknown }).registerHooks === "function";
  it.runIf(tracks)("reloads when the module or a local file it imports changes", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "metaplate-preview-cli-"));
    const plateSource = (label: string) => `
const data = ${JSON.stringify(png)};
export const label = ${JSON.stringify(label)};
export const plate = {
  variantName: undefined,
  variants: [],
  variant() { throw new Error("no variants"); },
  sitePath: (route) => [route.replace(/^\\/+|\\/+$/g, ""), "og-image.png"].filter(Boolean).join("/"),
  artifact: async (route) => ({
    bytes: Buffer.from(data, "base64"),
    contentType: "image/png",
    format: "png",
    size: { width: 1200, height: 630 },
    metadata: { openGraph: { images: [{ url: "/og-image.png", alt: label }] } },
  }),
};
`;
    await writeFile(path.join(cwd, "plate.mjs"), plateSource("first"));
    await writeFile(
      path.join(cwd, "og.render.mjs"),
      `import { plate } from "./plate.mjs";\nexport default { plate, pages: [{ route: "/one", copy: {} }] };\n`,
    );
    const preview = await start(cwd, ["og.render.mjs"]);
    try {
      const page = async () => (await fetch(preview.url)).text();
      expect(await page()).toContain('alt="first"');

      await writeFile(path.join(cwd, "plate.mjs"), plateSource("second"));
      await until(async () => (await page()).includes('alt="second"'));

      await writeFile(
        path.join(cwd, "og.render.mjs"),
        `import { plate } from "./plate.mjs";\nexport default { plate, pages: [{ route: "/two", copy: {} }] };\n`,
      );
      await until(async () => (await page()).includes("<h2>/two</h2>"));

      await writeFile(path.join(cwd, "og.render.mjs"), "export default {\n");
      await until(async () => (await page()).includes("module-error"));
      expect(preview.stderr()).toContain("✗ og.render.mjs:");
    } finally {
      await preview.stop();
    }
  });

  it("warns before listening beyond this machine, and reports a failed listen", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "metaplate-preview-cli-"));
    await writeFile(path.join(cwd, "og.render.mjs"), "export default {};\n");
    // 192.0.2.1 (TEST-NET-1) is never a local address, so the listen fails
    // after the warning instead of opening a port to the network.
    const result = runCli(bundlePath, ["preview", "--port", "0", "--host", "192.0.2.1", "og.render.mjs"], cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--host 192.0.2.1 makes the preview reachable from other machines");
    expect(result.stderr).not.toContain("Usage:");
  });

  it("refuses a module that does not exist without starting a server", () => {
    const result = runCli(bundlePath, ["preview", "absent.mjs"], tmpdir());
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Cannot find render module absent.mjs\n");
  });
});
