import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

/**
 * Bundles `src/cli/main.ts` (fast, no types) into a temp dir so spawn-based tests
 * never run a stale build, and the bundle cannot leak into lint or the
 * package tarball.
 */
export async function bundleCli(): Promise<string> {
  const bundleDir = await mkdtemp(path.join(tmpdir(), "metaplate-cli-bundle-"));
  const bundlePath = path.join(bundleDir, "cli.mjs");
  await build({
    entryPoints: [path.join(import.meta.dirname, "..", "..", "src", "cli", "main.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundlePath,
  });
  return bundlePath;
}

/** Runs the bundled CLI to completion in `cwd`. */
export function runCli(bundlePath: string, args: string[], cwd: string) {
  return spawnSync(process.execPath, [bundlePath, ...args], { cwd, encoding: "utf8" });
}
