import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(resolve(root, "package.json"), "utf8")));
const commitSha = process.env.GITHUB_SHA ?? process.env.RELEASE_COMMIT_SHA ?? "local";
const checks = [
  ["production-build", ["run", "build"]],
  ["packed-artifact", ["run", "check:package"]],
  ["dependency-inventory", ["run", "dependencies:report"]],
  ["deployment-evidence-policy", ["run", "check:deployment"]],
  ["socket-release-policy", ["run", "check:dependencies"]],
];
const results = [];
for (const [id, args] of checks) {
  const startedAt = new Date().toISOString();
  try {
    execFileSync(process.platform === "win32" ? "npm" : "npm", args, { cwd: root, stdio: "ignore", shell: process.platform === "win32" });
    results.push({ name: id, status: "passed", startedAt, finishedAt: new Date().toISOString(), command: `npm ${args.join(" ")}` });
  } catch (error) {
    results.push({ name: id, status: "failed", startedAt, finishedAt: new Date().toISOString(), command: `npm ${args.join(" ")}`, error: error instanceof Error ? error.message : String(error) });
  }
}
writeFileSync(resolve(root, "release-check-results.json"), `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), commitSha, releaseVersion: packageJson.version, checks: results }, null, 2)}\n`);
process.stdout.write(`Recorded ${results.length} release checks.\n`);
// Always leave the structured result artifact behind so the evidence report can
// explain which check failed instead of disappearing with the command status.

