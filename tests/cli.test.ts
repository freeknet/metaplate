import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatVerifyPath,
  parseVerifyTargets,
  parseVerifyUrlInvocation,
  VERIFY_URL_USAGE,
  VERIFY_USAGE,
} from "../src/cli-args.js";
import { METAPLATE_VERSION } from "../src/version.js";
import { closeLocalServers, localServer, redirectTo, routes, serveBytes } from "./helpers/http-fixtures.js";
import { completePng } from "./helpers/image-fixtures.js";

// The CLI runs against the built bundle; rebuild it (fast, no types) so the
// spawn-based tests never go stale. The bundle is written into a temp dir so
// it cannot leak into lint or the package tarball.
import { build } from "esbuild";
const bundleDir = await mkdtemp(path.join(tmpdir(), "metaplate-cli-bundle-"));
const bundlePath = path.join(bundleDir, "cli.mjs");
await build({
  entryPoints: [path.join(import.meta.dirname, "..", "src", "cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundlePath,
});

function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, [bundlePath, ...args], { cwd, encoding: "utf8" });
}

/** Spawns without blocking, so an in-process test server can still answer. */
function runAsync(args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [bundlePath, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

it("keeps parent directories when files share a basename", () => {
  expect(formatVerifyPath("out/docs/opengraph-image", "/workspace")).toBe(
    "out/docs/opengraph-image",
  );
  expect(formatVerifyPath("out/reference/opengraph-image", "/workspace")).toBe(
    "out/reference/opengraph-image",
  );
});

describe("parseVerifyTargets", () => {
  it("applies one size to multiple files", () => {
    expect(
      parseVerifyTargets(["verify", "--size", "1200x630", "one.png", "two.png"]),
    ).toEqual([
      { file: "one.png", size: { width: 1200, height: 630 } },
      { file: "two.png", size: { width: 1200, height: 630 } },
    ]);
  });

  it("supports repeated size groups", () => {
    expect(
      parseVerifyTargets([
        "verify",
        "--size",
        "512x512",
        "mark.png",
        "--size",
        "1280x640",
        "banner.png",
      ]),
    ).toEqual([
      { file: "mark.png", size: { width: 512, height: 512 } },
      { file: "banner.png", size: { width: 1280, height: 640 } },
    ]);
  });

  it("parses an expected format", () => {
    expect(
      parseVerifyTargets(["verify", "--format", "jpeg", "--size", "1200x630", "card.jpg"]),
    ).toEqual([
      { file: "card.jpg", size: { width: 1200, height: 630 }, format: "jpeg" },
    ]);
  });

  it.each([
    { args: [] },
    { args: ["verify"] },
    { args: ["verify", "orphan.png"] },
    { args: ["verify", "--size", "wide", "image.png"] },
    { args: ["verify", "--size", "0x630", "image.png"] },
    { args: ["verify", "--size", "99999999999999999999x630", "image.png"] },
    { args: ["verify", "--size", "1200.5x630", "image.png"] },
    { args: ["verify", "--size", "-1200x630", "image.png"] },
    { args: ["verify", "--max-file-size", "", "--size", "1200x630", "image.png"] },
    { args: ["verify", "--max-file-size", "0x10", "--size", "1200x630", "image.png"] },
    { args: ["verify", "--max-file-size", "-1", "--size", "1200x630", "image.png"] },
    { args: ["verify", "--max-file-size", "1.5", "--size", "1200x630", "image.png"] },
    { args: ["verify", "--target", "myspace", "--size", "1200x630", "image.png"] },
    { args: ["verify", "--url", "https://example.com/og.png", "--size", "1200x630", "image.png"] },
    { args: ["verify", "--alt", "Card", "--size", "1200x630", "image.png"] },
  ] satisfies { args: string[] }[])(`rejects invalid arguments: $args`, ({ args }) => {
    expect(() => parseVerifyTargets(args)).toThrow(VERIFY_USAGE);
  });
});

describe("verify CLI", () => {
  // A minimal structurally-complete PNG: signature, IHDR, one IDAT, IEND.
  function png(): Buffer {
    function chunk(type: string, payload: number[]) {
      const length = Buffer.from([
        (payload.length >>> 24) & 0xff,
        (payload.length >>> 16) & 0xff,
        (payload.length >>> 8) & 0xff,
        payload.length & 0xff,
      ]);
      return Buffer.concat([
        length,
        Buffer.from(type, "ascii"),
        Buffer.from(payload),
        Buffer.alloc(4),
      ]);
    }
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", [
        (1200 >>> 24) & 0xff,
        (1200 >>> 16) & 0xff,
        (1200 >>> 8) & 0xff,
        1200 & 0xff,
        (630 >>> 24) & 0xff,
        (630 >>> 16) & 0xff,
        (630 >>> 8) & 0xff,
        630 & 0xff,
        8,
        6,
        0,
        0,
        0,
      ]),
      // A complete (empty) zlib datastream: 0x78 0x9C header, an empty
      // deflate block, and the Adler-32 of the empty input.
      chunk("IDAT", [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
      chunk("IEND", []),
    ]);
  }

  function svg(): string {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><path d="M0 0h1v1H0z"/></svg>';
  }

  it("provides successful help and version discovery commands", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "metaplate-cli-"));
    const help = run(["--help"], cwd);
    const shortHelp = run(["-h"], cwd);
    const version = run(["--version"], cwd);
    const shortVersion = run(["-v"], cwd);
    const packageVersion = JSON.parse(
      await readFile(path.join(import.meta.dirname, "..", "package.json"), "utf8"),
    ).version;

    expect(help.status).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain(VERIFY_USAGE);
    expect(help.stdout).toContain(VERIFY_URL_USAGE);
    expect(shortHelp.stdout).toBe(help.stdout);
    expect(version.status).toBe(0);
    expect(version.stderr).toBe("");
    expect(version.stdout.trim()).toBe(METAPLATE_VERSION);
    expect(shortVersion.stdout).toBe(version.stdout);
    expect(METAPLATE_VERSION).toBe(packageVersion);
  });

  it("reports every failing target and exits non-zero", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "metaplate-cli-"));
    await writeFile(path.join(cwd, "good.png"), png());
    await writeFile(path.join(cwd, "bad.png"), Buffer.from("not an image"));

    const result = run(
      ["verify", "--size", "1200x630", "bad.png", "good.png", "does-not-exist.png"],
      cwd,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("✓ good.png 1200x630");
    expect(result.stderr).toContain("✗ bad.png");
    expect(result.stderr).toContain("✗ does-not-exist.png");
    expect(result.stderr).toContain("2 of 3 files failed verification");
  });

  it("emits stable JSON for a compatible social target", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "metaplate-cli-"));
    await writeFile(path.join(cwd, "good.png"), png());

    const result = run([
      "verify",
      "--json",
      "--target",
      "universal",
      "--url",
      "https://example.com/og.png",
      "--alt",
      "Project card",
      "--size",
      "1200x630",
      "good.png",
    ], cwd);
    const report = JSON.parse(result.stdout) as {
      schemaVersion: number;
      files: Array<{
        file: string;
        valid: boolean;
        image: { format: string; width: number; height: number; bytes: number };
        globalIssues: Array<{ code?: string }>;
        targets: Record<string, { compatible: boolean }>;
      }>;
    };

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(report.schemaVersion).toBe(1);
    expect(report.files[0]).toMatchObject({
      file: "good.png",
      valid: true,
      image: { format: "png", width: 1200, height: 630 },
      globalIssues: [],
      targets: { universal: { compatible: true } },
    });
  });

  it("does not invent URL or alt metadata for target-only checks", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "metaplate-cli-"));
    await writeFile(path.join(cwd, "good.png"), png());
    const result = run(["verify", "--json", "--target", "universal", "--size", "1200x630", "good.png"], cwd);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as { files: Array<{ valid: boolean; targets: Record<string, { compatible: boolean; issues: unknown[] }> }> };
    expect(report.files[0]?.valid).toBe(true);
    expect(report.files[0]?.targets.universal).toMatchObject({ compatible: true, issues: [] });
  });

  it("counts failed files rather than individual findings", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "metaplate-cli-"));
    await writeFile(path.join(cwd, "good.png"), png());
    const result = run(["verify", "--target", "linkedin", "--max-file-size", "1", "--size", "1200x630", "good.png"], cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("1 of 1 files failed verification");
    expect(result.stderr).not.toContain("2 of 1 files failed verification");
  });

  it("enforces --max-file-size without requiring a social target", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "metaplate-cli-"));
    await writeFile(path.join(cwd, "good.png"), png());
    const result = run(["verify", "--json", "--max-file-size", "1", "--size", "1200x630", "good.png"], cwd);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as {
      files: Array<{ valid: boolean; globalIssues: Array<{ code?: string }> }>;
    };
    expect(report.files[0]?.valid).toBe(false);
    expect(report.files[0]?.globalIssues.some(({ code }) => code === "file-size")).toBe(true);
  });

  it("verifies GIF files, reports them as universal-incompatible, and rejects a facebook-only claim mismatch", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "metaplate-cli-"));
    const gif = Uint8Array.from([
      ...new TextEncoder().encode("GIF89a"),
      0x10, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00,
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x10, 0x00, 0x00,
      0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
    ]);
    await writeFile(path.join(cwd, "card.gif"), gif);

    const plain = run(["verify", "--format", "gif", "--size", "16x16", "card.gif"], cwd);
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain("✓ card.gif 16x16");

    const universal = run(
      ["verify", "--json", "--target", "universal", "--target", "facebook", "--size", "16x16", "card.gif"],
      cwd,
    );
    expect(universal.status).toBe(1);
    const report = JSON.parse(universal.stdout) as {
      files: Array<{
        valid: boolean;
        image: { format: string };
        targets: Record<string, { compatible: boolean; issues: Array<{ code?: string }> }>;
      }>;
    };
    expect(report.files[0]?.valid).toBe(true);
    expect(report.files[0]?.image.format).toBe("gif");
    expect(report.files[0]?.targets.universal?.compatible).toBe(false);
    expect(report.files[0]?.targets.universal?.issues.some(({ code }) => code === "format")).toBe(true);
    expect(report.files[0]?.targets.facebook?.compatible).toBe(true);
  });

  it("honors --format and rejects a format mismatch", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "metaplate-cli-"));
    await writeFile(path.join(cwd, "good.png"), png());

    const wrong = run(
      ["verify", "--format", "jpeg", "--size", "1200x630", "good.png"],
      cwd,
    );
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("Expected jpeg 1200x630, received png");

    const right = run(
      ["verify", "--format", "png", "--size", "1200x630", "good.png"],
      cwd,
    );
    expect(right.status).toBe(0);
    expect(right.stdout).toContain("✓ good.png 1200x630");

    await writeFile(path.join(cwd, "good.svg"), svg());
    const verifiedSvg = run(
      ["verify", "--format", "svg", "--size", "1200x630", "good.svg"],
      cwd,
    );
    expect(verifiedSvg.status).toBe(0);
    expect(verifiedSvg.stdout).toContain("✓ good.svg 1200x630");
  });
});

describe("parseVerifyUrlInvocation", () => {
  it("parses URL groups, shared verify flags, and fetch limits", () => {
    expect(
      parseVerifyUrlInvocation([
        "verify-url",
        "--json",
        "--allow-private",
        "--allow-port",
        "8080",
        "--allow-port",
        "8080",
        "--max-bytes",
        "1000",
        "--max-redirects",
        "0",
        "--timeout",
        "2500",
        "--format",
        "png",
        "--size",
        "1200x630",
        "http://127.0.0.1:8080/og.png",
      ]),
    ).toEqual({
      targets: [{ url: "http://127.0.0.1:8080/og.png", size: { width: 1200, height: 630 }, format: "png" }],
      json: true,
      socialTargets: [],
      fetch: { allowPrivate: true, allowedPorts: [8080], maxBytes: 1000, maxRedirects: 0, timeoutMs: 2500 },
    });
  });

  it("defaults to the strict policy", () => {
    expect(parseVerifyUrlInvocation(["verify-url", "--size", "1x1", "https://example.com/og.png"]).fetch).toEqual({
      allowPrivate: false,
      allowedPorts: [],
    });
  });

  it.each([
    { args: ["verify-url"] },
    { args: ["verify", "--size", "1x1", "https://example.com/og.png"] },
    { args: ["verify-url", "https://example.com/og.png"] },
    { args: ["verify-url", "--allow-port", "0", "--size", "1x1", "https://example.com/og.png"] },
    { args: ["verify-url", "--allow-port", "65536", "--size", "1x1", "https://example.com/og.png"] },
    { args: ["verify-url", "--max-bytes", "0", "--size", "1x1", "https://example.com/og.png"] },
    { args: ["verify-url", "--max-redirects", "21", "--size", "1x1", "https://example.com/og.png"] },
    { args: ["verify-url", "--timeout", "1e3", "--size", "1x1", "https://example.com/og.png"] },
    { args: ["verify-url", "--alt", "Card", "--size", "1x1", "https://example.com/og.png"] },
  ] satisfies { args: string[] }[])("rejects invalid arguments: $args", ({ args }) => {
    expect(() => parseVerifyUrlInvocation(args)).toThrow(VERIFY_URL_USAGE);
  });
});

describe("verify-url CLI", () => {
  afterEach(closeLocalServers);

  const card = completePng(1200, 630);

  async function cardServer() {
    const server = await localServer(routes({
      "/og.png": serveBytes(card, "image/png"),
      "/moved": redirectTo("/og.png", 301),
      "/mislabeled": serveBytes(card, "image/jpeg"),
    }));
    return { ...server, local: ["--allow-private", "--allow-port", String(server.port)] };
  }

  it("verifies a local development URL and reports its byte count", async () => {
    const server = await cardServer();
    const result = await runAsync(["verify-url", ...server.local, "--format", "png", "--size", "1200x630", `${server.origin}/og.png`]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`✓ ${server.origin}/og.png 1200x630 (${card.byteLength} bytes)\n`);
  });

  it("emits the verify JSON shape plus the final URL after redirects", async () => {
    const server = await cardServer();
    const result = await runAsync([
      "verify-url", "--json", ...server.local, "--target", "universal", "--size", "1200x630", `${server.origin}/moved`,
    ]);
    const report = JSON.parse(result.stdout) as { schemaVersion: number; urls: unknown[] };

    // The bytes are valid, but target checks judge the URL as it would be
    // published, and crawlers need https.
    expect(result.status).toBe(1);
    expect(report.schemaVersion).toBe(1);
    expect(report.urls[0]).toMatchObject({
      url: `${server.origin}/moved`,
      finalUrl: `${server.origin}/og.png`,
      redirects: [`${server.origin}/og.png`],
      contentType: "image/png",
      bytes: card.byteLength,
      valid: true,
      image: { format: "png", width: 1200, height: 630, bytes: card.byteLength },
      globalIssues: [],
      targets: { universal: { compatible: false, issues: [expect.objectContaining({ code: "url" })] } },
    });
  });

  it("refuses a loopback URL without --allow-private and exits non-zero", async () => {
    const server = await cardServer();
    const result = await runAsync([
      "verify-url", "--allow-port", String(server.port), "--size", "1200x630", `${server.origin}/og.png`,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`✗ ${server.origin}/og.png verification failed: Refusing`);
    expect(result.stderr).toContain("a loopback address");
    expect(result.stderr).toContain("1 of 1 URLs failed verification");
    expect(server.requests).toHaveLength(0);
  });

  it("reports every failing URL with stable codes in JSON", async () => {
    const server = await cardServer();
    const result = await runAsync([
      "verify-url", "--json", ...server.local, "--size", "1200x630",
      `${server.origin}/mislabeled`, "file:///etc/passwd", `http://user:hunter2@127.0.0.1:${server.port}/og.png`,
    ]);
    const report = JSON.parse(result.stdout) as {
      urls: Array<{ url: string; valid: boolean; globalIssues: Array<{ code?: string }> }>;
    };

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("hunter2");
    expect(report.urls.map(({ valid }) => valid)).toEqual([false, false, false]);
    expect(report.urls.map(({ globalIssues }) => globalIssues[0]?.code)).toEqual([
      "content-type",
      "scheme",
      "credentials",
    ]);
  });

  it("prints the verify-url usage for argument errors", async () => {
    const result = await runAsync(["verify-url", "--timeout", "soon", "--size", "1x1", "https://example.com/og.png"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid timeout.");
    expect(result.stderr).toContain(VERIFY_URL_USAGE);
  });
});
