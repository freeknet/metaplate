import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { REQUIRED_ARTIFACTS, REQUIRED_CHECKS } from "./release-evidence-report.mjs";
import { releaseCommitSha, runScript } from "./run-script.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readJson(file) {
  return JSON.parse(readFileSync(join(root, file), "utf8"));
}

/**
 * A retained bundle is only evidence when the report it hashes actually
 * passed, belongs to this commit and version, and lists every artifact the
 * policy requires; verifying digests alone would certify a failed run.
 */
export function validateEvidenceBundle(report, { commitSha, releaseVersion, digest }) {
  const errors = [];
  if (report?.schemaVersion !== 1) errors.push("release-evidence-report.json schemaVersion must be 1");
  if (report?.verificationStatus !== "passed") {
    errors.push(`release-evidence-report.json verificationStatus is ${report?.verificationStatus ?? "missing"}, not passed`);
  }
  if (report?.commitSha !== commitSha) errors.push(`release-evidence-report.json commitSha ${report?.commitSha} does not match ${commitSha}`);
  if (report?.releaseVersion !== releaseVersion) {
    errors.push(`release-evidence-report.json releaseVersion ${report?.releaseVersion} does not match package.json ${releaseVersion}`);
  }
  const checkNames = Array.isArray(report?.checks) ? report.checks.map((check) => check?.name) : [];
  for (const name of REQUIRED_CHECKS) {
    if (!checkNames.includes(name)) errors.push(`release-evidence-report.json is missing the ${name} check`);
  }
  if (Array.isArray(report?.checks) && report.checks.some((check) => check?.status !== "passed")) {
    errors.push("release-evidence-report.json lists a check that did not pass");
  }
  const artifacts = Array.isArray(report?.artifacts) ? report.artifacts : [];
  const files = new Set();
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact.file !== "string" || !/^[a-f0-9]{64}$/i.test(artifact.sha256 ?? "")) {
      errors.push("release evidence contains an invalid artifact entry");
      continue;
    }
    files.add(artifact.file);
    const actual = digest(artifact.file);
    if (actual !== artifact.sha256) errors.push(`${artifact.file} is missing or does not match its recorded SHA-256`);
  }
  for (const file of REQUIRED_ARTIFACTS) {
    if (!files.has(file)) errors.push(`release evidence does not retain ${file}`);
  }
  return errors;
}

function main() {
  const report = readJson("release-evidence-report.json");
  const packageJson = readJson("package.json");
  const errors = validateEvidenceBundle(report, {
    commitSha: releaseCommitSha(),
    releaseVersion: packageJson.version,
    digest: (file) => {
      try {
        return createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex");
      } catch {
        return undefined;
      }
    },
  });
  if (errors.length > 0) throw new Error(`Invalid retained evidence bundle:\n- ${errors.join("\n- ")}`);
  process.stdout.write(`Verified retained evidence bundle: ${report.artifacts.length} artifacts for ${report.commitSha}.\n`);
}

runScript(main, import.meta.url);
