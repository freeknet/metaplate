import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { completeJpeg, completePng } from "../helpers/image-fixtures.js";

type Report = { files: { file: string; valid: boolean }[] };

/** Runs a command, collecting its output. */
async function cli(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    stdout: { write: (text: string) => { stdout += text; } },
    stderr: { write: (text: string) => { stderr += text; } },
  });
  return { code, stdout, stderr };
}

/** A per-page card tree like a static export's `out/og/<page>/og-image.*`. */
async function cards() {
  const root = await mkdtemp(path.join(tmpdir(), "metaplate-run-cli-"));
  const card = completePng(1200, 630);
  const files: Record<string, Uint8Array | string> = {
    "og/home/og-image.png": card,
    "og/about/og-image.png": card,
    "og/about/og-image.jpg": completeJpeg(1200, 630),
    "og/blog/post/og-image.png": card,
    "og/notes.txt": "not an image",
    "og/.cache/og-image.png": completePng(10, 10),
  };
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), bytes);
  }
  return root;
}

const checked = (root: string, stdout: string) =>
  (JSON.parse(stdout) as Report).files.map(({ file }) => path.relative(root, path.resolve(file)).split(path.sep).join("/"));

describe("verify operands", () => {
  it("walks a directory for image files, filtered by --format", async () => {
    const root = await cards();
    const all = await cli(["verify", "--json", "--size", "1200x630", path.join(root, "og")]);
    // The hidden .cache directory is walked too: a directory means every file below it.
    expect(all.code).toBe(1);
    expect(checked(root, all.stdout)).toEqual([
      "og/.cache/og-image.png",
      "og/about/og-image.jpg",
      "og/about/og-image.png",
      "og/blog/post/og-image.png",
      "og/home/og-image.png",
    ]);

    const jpeg = await cli(["verify", "--json", "--format", "jpeg", "--size", "1200x630", path.join(root, "og")]);
    expect(jpeg.code).toBe(0);
    expect(checked(root, jpeg.stdout)).toEqual(["og/about/og-image.jpg"]);

    const empty = await cli(["verify", "--format", "gif", "--size", "1200x630", path.join(root, "og")]);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("is a directory with no gif files in it");
  });

  it("expands globs itself, skipping hidden entries", async () => {
    const root = await cards();
    const star = await cli(["verify", "--json", "--size", "1200x630", path.join(root, "og", "*", "og-image.png")]);
    expect(star.code).toBe(0);
    expect(checked(root, star.stdout)).toEqual(["og/about/og-image.png", "og/home/og-image.png"]);

    const deep = await cli(["verify", "--json", "--size", "1200x630", `${root}/og/**/*.png`]);
    expect(checked(root, deep.stdout)).toEqual(["og/about/og-image.png", "og/blog/post/og-image.png", "og/home/og-image.png"]);

    const braces = await cli(["verify", "--json", "--size", "1200x630", `${root}/og/{home,about}/og-image.[jp][pn]g`]);
    expect(checked(root, braces.stdout)).toEqual(["og/about/og-image.jpg", "og/about/og-image.png", "og/home/og-image.png"]);

    const none = await cli(["verify", "--size", "1200x630", `${root}/og/*/missing-*.png`]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("No files match");
  });

  it("checks a file named by several operands once, under its first size group", async () => {
    const root = await cards();
    const home = path.join(root, "og", "home", "og-image.png");
    const result = await cli(["verify", "--json", "--size", "1200x630", home, path.join(root, "og", "home"), "--size", "10x10", home]);
    expect(result.code).toBe(0);
    expect(checked(root, result.stdout)).toEqual(["og/home/og-image.png"]);
  });

  it("skips hidden entries under a trailing ** too", async () => {
    const root = await cards();
    const result = await cli(["verify", "--json", "--size", "1200x630", `${root}/og/**`, "--format", "png", "--size", "1200x630", `${root}/og/home/*.png`]);
    // og/notes.txt is a file, so the trailing ** names it; og/.cache/og-image.png is hidden.
    expect(checked(root, result.stdout)).toEqual([
      "og/about/og-image.jpg",
      "og/about/og-image.png",
      "og/blog/post/og-image.png",
      "og/home/og-image.png",
      "og/notes.txt",
    ]);
  });

  it("follows symbolic links to files, in directories and globs", async () => {
    const root = await cards();
    const target = path.join(root, "og", "home", "og-image.png");
    const link = path.join(root, "linked", "og-image.png");
    await mkdir(path.dirname(link));
    try {
      await symlink(target, link, "file");
    } catch (error) {
      // Windows needs Developer Mode or an elevated shell to create links.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const walked = await cli(["verify", "--json", "--size", "1200x630", path.join(root, "linked")]);
    expect(checked(root, walked.stdout)).toEqual(["linked/og-image.png"]);
    const globbed = await cli(["verify", "--json", "--size", "1200x630", `${root}/linked/*.png`]);
    expect(globbed.code).toBe(0);
    expect(checked(root, globbed.stdout)).toEqual(["linked/og-image.png"]);
  });

  it("leaves a missing plain file to fail as before", async () => {
    const result = await cli(["verify", "--size", "1200x630", "no-such-card.png"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no-such-card.png");
  });
});

describe("runCli", () => {
  it("returns exit codes without touching process.exitCode", async () => {
    const before = process.exitCode;
    expect((await cli(["--version"])).code).toBe(0);
    const failed = await cli(["verify", "--size"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("Usage: metaplate verify");
    expect(process.exitCode).toBe(before);
  });

  it("keeps concurrent runs apart", async () => {
    const root = await cards();
    const [good, bad] = await Promise.all([
      cli(["verify", "--size", "1200x630", path.join(root, "og", "home")]),
      cli(["verify", "--size", "10x10", path.join(root, "og", "home")]),
    ]);
    expect(good).toMatchObject({ code: 0, stderr: "" });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("1 of 1 files failed verification");
  });
});
