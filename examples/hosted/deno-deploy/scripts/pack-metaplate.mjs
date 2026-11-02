// Builds metaplate from this checkout and packs it into this directory as
// metaplate.tgz, the file package.json depends on. The tarball's SHA-256, the
// package version, and the checkout's commit go to metaplate-pack.json, which
// main.ts serves at / so a deployment identifies exactly what it runs.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmPackResult } from "../../../../scripts/package/npm-pack-result.mjs";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(here, "../../..");
const run = (command, cwd) => execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

run("npm run build", root);
const packed = npmPackResult(run(`npm pack --json --pack-destination "${here}"`, root));
const tarball = join(here, "metaplate.tgz");
renameSync(join(here, packed.filename), tarball);

// A build checkout without git history (some hosted builders) records null.
const git = (args) => {
  try {
    return execSync(`git ${args}`, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const commit = git("rev-parse HEAD");
const status = commit === null ? null : git("status --porcelain --untracked-files=no");
const summary = {
  version: packed.version,
  sha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"),
  commit,
  dirty: status === null ? null : status !== "",
};
writeFileSync(join(here, "metaplate-pack.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
