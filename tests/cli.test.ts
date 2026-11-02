import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatVerifyPath,
  parseVerifyPageInvocation,
  parseVerifyTargets,
  RENDER_USAGE,
  parseVerifyUrlInvocation,
  VERIFY_PAGE_USAGE,
  VERIFY_URL_USAGE,
  VERIFY_USAGE,
} from "../src/cli-args.js";
import { METAPLATE_VERSION } from "../src/version.js";
import { bundleCli, runCli } from "./helpers/cli-bundle.js";
import { closeLocalServers, localServer, redirectTo, routes, serveBytes } from "./helpers/http-fixtures.js";
import { completePng } from "./helpers/image-fixtures.js";

// The CLI runs against a freshly bundled build so spawn tests never go stale.
const bundlePath = await bundleCli();

function run(args: string[], cwd: string) {
  return runCli(bundlePath, args, cwd);
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
    expect(help.stdout).toContain(VERIFY_PAGE_USAGE);
    expect(help.stdout).toContain(RENDER_USAGE);
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

  it("accepts every documented messaging and social target", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "metaplate-cli-"));
    await writeFile(path.join(cwd, "good.png"), png());
    const targets = ["whatsapp", "bluesky", "telegram", "threads", "pinterest"];
    const result = run(
      ["verify", "--json", ...targets.flatMap((target) => ["--target", target]), "--size", "1200x630", "good.png"],
      cwd,
    );
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      files: Array<{ targets: Record<string, { compatible: boolean; issues: Array<{ severity: string }> }> }>;
    };
    expect(Object.keys(report.files[0]?.targets ?? {})).toEqual(targets);
    expect(report.files[0]?.targets.whatsapp).toEqual({ compatible: true, issues: [] });
    expect(report.files[0]?.targets.telegram?.issues).toEqual([expect.objectContaining({ severity: "unknown" })]);
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
    expect(result.stderr.split(VERIFY_URL_USAGE)).toHaveLength(2);
  });
});

it("prints the usage once for an argument error that already names it", async () => {
  const result = await runAsync(["verify", "--url", "x", "--size", "1200x630", "f.png"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toBe(`--url and --alt require at least one --target. ${VERIFY_USAGE}\n`);
});

describe("parseVerifyPageInvocation", () => {
  it("parses page URLs, target checks, and every fetch limit", () => {
    expect(
      parseVerifyPageInvocation([
        "verify-page",
        "--json",
        "--target",
        "x",
        "--target",
        "x",
        "--max-file-size",
        "5000000",
        "--max-html-bytes",
        "65536",
        "--max-images",
        "3",
        "--max-bytes",
        "1000",
        "--max-redirects",
        "1",
        "--timeout",
        "2500",
        "--allow-private",
        "--allow-port",
        "8080",
        "http://127.0.0.1:8080/",
        "http://127.0.0.1:8080/about",
      ]),
    ).toEqual({
      urls: ["http://127.0.0.1:8080/", "http://127.0.0.1:8080/about"],
      json: true,
      socialTargets: ["x"],
      maxFileSize: 5_000_000,
      fetch: {
        allowPrivate: true,
        allowedPorts: [8080],
        maxHtmlBytes: 65_536,
        maxImages: 3,
        maxBytes: 1000,
        maxRedirects: 1,
        timeoutMs: 2500,
      },
    });
  });

  it("defaults to the strict policy", () => {
    expect(parseVerifyPageInvocation(["verify-page", "https://example.com/"])).toEqual({
      urls: ["https://example.com/"],
      json: false,
      socialTargets: [],
      fetch: { allowPrivate: false, allowedPorts: [] },
    });
  });

  it.each([
    { args: ["verify-page"] },
    { args: ["verify-url", "https://example.com/"] },
    { args: ["verify-page", "--size", "1200x630", "https://example.com/"] },
    { args: ["verify-page", "--format", "png", "https://example.com/"] },
    { args: ["verify-page", "--alt", "Card", "https://example.com/"] },
    { args: ["verify-page", "--max-images", "0", "https://example.com/"] },
    { args: ["verify-page", "--max-images", "101", "https://example.com/"] },
    { args: ["verify-page", "--max-html-bytes", "0", "https://example.com/"] },
    { args: ["verify-page", "--target", "myspace", "https://example.com/"] },
    { args: ["verify-page", "--bogus", "https://example.com/"] },
  ] satisfies { args: string[] }[])("rejects invalid arguments: $args", ({ args }) => {
    expect(() => parseVerifyPageInvocation(args)).toThrow(VERIFY_PAGE_USAGE);
  });
});

describe("verify-page CLI", () => {
  afterEach(closeLocalServers);

  const card = completePng(1200, 630);
  const head = `
    <meta property="og:image" content="/og.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="Card">
    <meta name="twitter:card" content="summary_large_image">
  `;

  async function pageServer() {
    const html = (markup: string) => serveBytes(new TextEncoder().encode(`<html><head>${markup}</head></html>`), "text/html");
    const server = await localServer(routes({
      "/": html(head),
      "/moved": redirectTo("/", 302),
      "/wrong-size": html(head.replace('content="630"', 'content="600"')),
      "/og.png": serveBytes(card, "image/png"),
    }));
    return { ...server, local: ["--allow-private", "--allow-port", String(server.port)] };
  }

  it("prints a readable audit and exits zero when nothing fails", async () => {
    const server = await pageServer();
    const result = await runAsync(["verify-page", ...server.local, `${server.origin}/moved`]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.split("\n")).toEqual([
      `✓ ${server.origin}/moved (1 image reference, final URL ${server.origin}/)`,
      `  ✓ og:image[0] ${server.origin}/og.png 1200x630 png (${card.byteLength} bytes)`,
      `  ! og:image[0]: "/og.png" is relative and was resolved to ${server.origin}/og.png; Open Graph and X Card URLs should be absolute.`,
      `  ! og:image[0]: ${server.origin}/og.png is served over http; crawlers that require https will not load it.`,
      "",
    ]);
  });

  it("sends errors to stderr and exits non-zero", async () => {
    const server = await pageServer();
    const result = await runAsync(["verify-page", ...server.local, `${server.origin}/wrong-size`, `${server.origin}/`]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`✗ ${server.origin}/wrong-size (1 image reference)`);
    expect(result.stdout).toContain(`  ✗ og:image[0] ${server.origin}/og.png`);
    expect(result.stdout).toContain(`✓ ${server.origin}/ (1 image reference)`);
    expect(result.stderr).toContain(
      `✗ ${server.origin}/wrong-size og:image[0]: Metadata advertises 1200x600, but image bytes are 1200x630.`,
    );
    expect(result.stderr).toContain("1 of 2 pages failed verification");
  });

  it("emits one stable JSON report per page", async () => {
    const server = await pageServer();
    const result = await runAsync([
      "verify-page", "--json", ...server.local, "--target", "universal", `${server.origin}/`, "ftp://example.com/",
    ]);
    const report = JSON.parse(result.stdout) as { schemaVersion: number; pages: unknown[] };

    // The relative, http og:image is not crawler-ready for the universal profile.
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(report.schemaVersion).toBe(1);
    expect(report.pages[0]).toMatchObject({
      url: `${server.origin}/`,
      finalUrl: `${server.origin}/`,
      redirects: [],
      contentType: "text/html",
      baseUrl: `${server.origin}/`,
      valid: true,
      metadata: { twitter: { card: "summary_large_image" } },
      globalIssues: [],
      targets: { universal: { compatible: false, issues: [] } },
      images: [{
        source: "og:image",
        index: 0,
        declared: { url: "/og.png", width: "1200", height: "630", alt: "Card" },
        url: `${server.origin}/og.png`,
        finalUrl: `${server.origin}/og.png`,
        redirects: [],
        contentType: "image/png",
        bytes: card.byteLength,
        valid: true,
        image: { format: "png", width: 1200, height: 630, bytes: card.byteLength },
        targets: { universal: { compatible: false, issues: expect.arrayContaining([expect.objectContaining({ code: "url" })]) } },
      }],
    });
    expect(report.pages[1]).toEqual({
      url: "ftp://example.com/",
      valid: false,
      globalIssues: [expect.objectContaining({ severity: "error", code: "scheme" })],
      targets: {},
      images: [],
    });
  });

  it("refuses a loopback page without --allow-private", async () => {
    const server = await pageServer();
    const result = await runAsync(["verify-page", "--allow-port", String(server.port), `${server.origin}/`]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`✗ ${server.origin}/ verification failed: Refusing`);
    expect(result.stderr).toContain("1 of 1 pages failed verification");
    expect(server.requests).toHaveLength(0);
  });

  it("prints the verify-page usage for argument errors", async () => {
    const result = await runAsync(["verify-page", "--size", "1x1", "https://example.com/"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--size is not accepted here.");
    expect(result.stderr.split(VERIFY_PAGE_USAGE)).toHaveLength(2);
  });
});
