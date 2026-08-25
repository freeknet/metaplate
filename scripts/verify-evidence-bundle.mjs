import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const report = JSON.parse(readFileSync(join(root, "release-evidence-report.json"), "utf8"));
if (!Array.isArray(report.artifacts) || report.artifacts.length === 0) {
  throw new Error("release-evidence-report.json must list retained artifacts");
}
for (const artifact of report.artifacts) {
  if (!artifact || typeof artifact.file !== "string" || !/^[a-f0-9]{64}$/i.test(artifact.sha256 ?? "")) {
    throw new Error("release evidence contains an invalid artifact entry");
  }
  const path = resolve(root, artifact.file);
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (digest !== artifact.sha256) {
    throw new Error(`${artifact.file} is missing or does not match its recorded SHA-256`);
  }
}
process.stdout.write(`Verified retained evidence bundle: ${report.artifacts.length} artifacts.\n`);
