import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** The commit every generated evidence artifact is bound to. */
export function releaseCommitSha() {
  return process.env.GITHUB_SHA ?? process.env.RELEASE_COMMIT_SHA ?? "local";
}

export function runScript(main, importMetaUrl) {
  if (!process.argv[1] || resolve(process.argv[1]) !== fileURLToPath(importMetaUrl)) return;
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
