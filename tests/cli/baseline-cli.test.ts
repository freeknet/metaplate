import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseVerifyInvocation } from "../../src/cli/args.js";
import { captureCli } from "../helpers/capture-cli.js";
import { decodePngPixels } from "../../src/image/png-content.js";
import { fixture } from "../helpers/image-fixtures.js";

type BaselineReport = {
  files: { file: string; valid: boolean; baseline?: { status: string; changedPixels?: number; diff?: string } }[];
  baseline?: { unmatched: string[]; removed: string[] };
};

const cli = captureCli;

const card = (name: string) => fixture(`compare/${name}`);

/** A current tree and a baseline tree, each a map of relative path to bytes. */
async function trees(current: Record<string, Uint8Array>, baseline: Record<string, Uint8Array>) {
  const root = await mkdtemp(path.join(tmpdir(), "metaplate-baseline-"));
  for (const [tree, files] of [["out", current], ["baseline", baseline]] as const) {
    for (const [name, bytes] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, tree, name)), { recursive: true });
      await writeFile(path.join(root, tree, name), bytes);
    }
  }
  return { root, out: path.join(root, "out"), baseline: path.join(root, "baseline"), diff: path.join(root, "diff") };
}

const SIZE = ["--size", "240x126"];

describe("verify --baseline", () => {
  it("passes when every card matches its baseline", async () => {
    const dirs = await trees(
      { "home/og.png": card("card.png"), "post/og.jpg": card("card-420.jpg") },
      { "home/og.png": card("card.png"), "post/og.jpg": card("card-420.jpg") },
    );
    const result = await cli(["verify", "--baseline", dirs.baseline, ...SIZE, dirs.out]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout.match(/matches the baseline/g)).toHaveLength(2);
  });

  it("fails a changed card, a card with no baseline, and a baseline with no card", async () => {
    const dirs = await trees(
      { "home/og.png": card("card-changed.png"), "new/og.png": card("card.png") },
      { "home/og.png": card("card.png"), "gone/og.png": card("card.png") },
    );
    const result = await cli(["verify", "--json", "--baseline", dirs.baseline, "--write-diff", dirs.diff, ...SIZE, dirs.out]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as BaselineReport;
    const byName = Object.fromEntries(report.files.map((file) => [path.basename(path.dirname(file.file)), file]));
    expect(byName.home).toMatchObject({ valid: false, baseline: { status: "changed", changedPixels: 441 } });
    expect(byName.new).toMatchObject({ valid: false, baseline: { status: "missing-baseline" } });
    expect(report.baseline?.unmatched).toHaveLength(1);
    expect(report.baseline?.unmatched[0]).toMatch(/gone\/og\.png$/);

    const diff = decodePngPixels(await readFile(path.join(dirs.diff, "home", "og.png")));
    expect(diff.width).toBe(240 * 3 + 16);
    expect(byName.home?.baseline?.diff).toMatch(/diff\/home\/og\.png$/);
    // Only changed cards get a diff image.
    expect(await readdir(dirs.diff)).toEqual(["home"]);
  });

  it("prints each finding and the failure count", async () => {
    const dirs = await trees(
      { "a.png": card("card-changed.png") },
      { "a.png": card("card.png"), "b.png": card("card.png") },
    );
    const result = await cli(["verify", "--baseline", dirs.baseline, ...SIZE, dirs.out]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/✗ .*a\.png verification failed: differs from .*a\.png: 1\.46% of pixels changed by more than 0\/255 \(--max-diff 0%\)/);
    expect(result.stderr).toMatch(/✗ .*b\.png has no current file; --update-baseline removes it/);
    expect(result.stderr).toContain("1 of 1 files failed verification");
  });

  it("passes a change within --max-diff and reports it", async () => {
    const dirs = await trees({ "a.png": card("card-changed.png") }, { "a.png": card("card.png") });
    const result = await cli(["verify", "--baseline", dirs.baseline, "--max-diff", "2%", ...SIZE, dirs.out]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("1.46% of pixels changed by more than 0/255, within --max-diff");
  });

  it("raises the per-pixel tolerance with --threshold", async () => {
    const dirs = await trees({ "a.jpg": card("card-reencoded-420.jpg") }, { "a.jpg": card("card-420.jpg") });
    const strict = await cli(["verify", "--baseline", dirs.baseline, "--threshold", "0", ...SIZE, dirs.out]);
    expect(strict.code).toBe(1);
    const loose = await cli(["verify", "--baseline", dirs.baseline, "--threshold", "64", ...SIZE, dirs.out]);
    expect(loose.code).toBe(0);
  });

  it("rewrites the baseline with --update-baseline, then matches it", async () => {
    const dirs = await trees(
      { "home/og.png": card("card-changed.png"), "new/og.png": card("card.png") },
      { "home/og.png": card("card.png"), "gone/og.png": card("card.png") },
    );
    const update = await cli(["verify", "--baseline", dirs.baseline, "--update-baseline", ...SIZE, dirs.out]);
    expect(update.stderr).toBe("");
    expect(update.code).toBe(0);
    expect(update.stdout).toContain("baseline updated");
    expect(update.stdout).toContain("added to the baseline");
    expect(update.stdout).toMatch(/gone\/og\.png removed from the baseline/);
    expect(await readdir(dirs.baseline)).toEqual(["home", "new"]);

    const after = await cli(["verify", "--baseline", dirs.baseline, ...SIZE, dirs.out]);
    expect(after.code).toBe(0);
  });

  it("creates a baseline directory that does not exist yet", async () => {
    const dirs = await trees({ "a.png": card("card.png") }, {});
    const result = await cli(["verify", "--baseline", dirs.baseline, "--update-baseline", ...SIZE, dirs.out]);
    expect(result.code).toBe(0);
    expect(await readFile(path.join(dirs.baseline, "a.png"))).toEqual(card("card.png"));
  });

  it("matches a glob's files relative to the path before its first wildcard", async () => {
    const dirs = await trees({ "home/og.png": card("card.png") }, { "home/og.png": card("card.png") });
    const glob = `${dirs.out.split(path.sep).join("/")}/*/og.png`;
    const result = await cli(["verify", "--baseline", dirs.baseline, ...SIZE, glob]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("refuses two files that would share one baseline path", async () => {
    const dirs = await trees({ "a/og.png": card("card.png"), "b/og.png": card("card.png") }, {});
    const result = await cli([
      "verify", "--baseline", dirs.baseline, ...SIZE, path.join(dirs.out, "a", "og.png"), path.join(dirs.out, "b", "og.png"),
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("both match og.png in the baseline");
  });
});

describe("parseVerifyInvocation baseline flags", () => {
  const parse = (...flags: string[]) => parseVerifyInvocation(["verify", ...flags, "--size", "10x10", "a.png"]);

  it("parses --baseline and its options", () => {
    expect(parse("--baseline", "base").baseline).toEqual({ dir: "base", maxDiff: 0, update: false });
    expect(
      parse("--baseline", "base", "--max-diff", "0.5%", "--threshold", "24", "--write-diff", "diff", "--update-baseline").baseline,
    ).toEqual({ dir: "base", maxDiff: 0.005, threshold: 24, writeDiff: "diff", update: true });
    expect(parse("--baseline", "base", "--max-diff", "2").baseline?.maxDiff).toBe(0.02);
    expect(parse().baseline).toBeUndefined();
  });

  it("rejects baseline options without --baseline, and invalid values", () => {
    expect(() => parse("--max-diff", "1%")).toThrow("--max-diff requires --baseline");
    expect(() => parse("--write-diff", "d", "--update-baseline")).toThrow("--write-diff, --update-baseline require --baseline");
    expect(() => parse("--baseline", "base", "--max-diff", "101%")).toThrow("Invalid max diff");
    expect(() => parse("--baseline", "base", "--max-diff", "-1")).toThrow("Invalid max diff");
    expect(() => parse("--baseline", "base", "--threshold", "256")).toThrow("Invalid threshold");
    expect(() => parse("--baseline", "--json")).toThrow("Invalid baseline directory");
  });
});
