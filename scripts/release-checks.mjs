import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { releaseCommitSha } from "./run-script.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const commitSha = releaseCommitSha();
const npmCli = process.env.npm_execpath;
const OUTPUT_TAIL_CHARACTERS = 4000;
const checks = [
  ["production-build", ["run", "build"]],
  ["packed-artifact", ["run", "check:package"]],
  ["dependency-inventory", ["run", "dependencies:report"]],
  ["deployment-evidence-policy", ["run", "check:deployment"]],
  ["socket-release-policy", ["run", "check:dependencies"]],
  ["workflow-policy", ["run", "check:workflows"]],
];

function runNpm(args) {
  const options = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 };
  return npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], options)
    : execFileSync("npm", args, { ...options, shell: process.platform === "win32" });
}

function tail(text) {
  const value = String(text ?? "");
  return value.length > OUTPUT_TAIL_CHARACTERS ? value.slice(-OUTPUT_TAIL_CHARACTERS) : value;
}

const results = [];
for (const [id, args] of checks) {
  const startedAt = new Date().toISOString();
  const command = `npm ${args.join(" ")}`;
  try {
    runNpm(args);
    results.push({ name: id, status: "passed", startedAt, finishedAt: new Date().toISOString(), command });
  } catch (error) {
    const output = tail(`${error?.stdout ?? ""}${error?.stderr ?? ""}`);
    results.push({
      name: id,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      command,
      error: error instanceof Error ? error.message : String(error),
      output,
    });
    process.stderr.write(`Release check ${id} failed (${command}):\n${output}\n`);
  }
}
// Always leave the structured result artifact behind so the evidence report can
// explain which check failed instead of disappearing with the command status.
writeFileSync(
  resolve(root, "release-check-results.json"),
  `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), commitSha, releaseVersion: packageJson.version, checks: results }, null, 2)}\n`,
);
const failed = results.filter((result) => result.status === "failed");
process.stdout.write(`Recorded ${results.length} release checks; ${failed.length} failed.\n`);
if (failed.length > 0) process.exitCode = 1;
