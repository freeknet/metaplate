import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { formatVerifyPath, parseVerifyTargets, VERIFY_USAGE } from "../src/cli-args.js";
import { METAPLATE_VERSION } from "../src/version.js";

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
      files: Array<{ file: string; compatible: boolean; format: string; targets: Record<string, { compatible: boolean }> }>;
    };

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(report.schemaVersion).toBe(1);
    expect(report.files[0]).toMatchObject({
      file: "good.png",
      compatible: true,
      format: "png",
      targets: { universal: { compatible: true } },
    });
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
