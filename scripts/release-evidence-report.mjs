import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { validateDeploymentManifest } from "./verify-deployment-evidence.mjs";
import { validateSocketReport } from "./verify-socket-dispositions.mjs";
import { releaseCommitSha, runScript } from "./run-script.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const REQUIRED_CHECKS = new Set([
  "production-build",
  "packed-artifact",
  "dependency-inventory",
  "deployment-evidence-policy",
  "socket-release-policy",
  "workflow-policy",
]);
export const REQUIRED_ARTIFACTS = Object.freeze([
  "dependency-inventory.json",
  "deployment-evidence.json",
  "socket-dispositions.json",
  "socket-score-report.json",
  "release-check-results.json",
  "deployment-contract-evidence.json",
]);

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readJson(file) {
  return JSON.parse(readFileSync(join(root, file), "utf8"));
}

function readOptionalJson(file) {
  try {
    return readJson(file);
  } catch {
    return undefined;
  }
}

export function validateCheckResults(checkResults, { commitSha, releaseVersion }) {
  if (!checkResults || checkResults.schemaVersion !== 1 || checkResults.commitSha !== commitSha || checkResults.releaseVersion !== releaseVersion) {
    throw new Error("release-check-results.json is missing or does not belong to the requested commit/version");
  }
  const checks = Array.isArray(checkResults.checks) ? checkResults.checks : [];
  const names = checks.map((check) => check?.name);
  if (checks.length !== REQUIRED_CHECKS.size || new Set(names).size !== REQUIRED_CHECKS.size || names.some((name) => !REQUIRED_CHECKS.has(name))) {
    throw new Error("release-check-results.json must contain each required check exactly once");
  }
  const failed = checks.filter((check) => check?.status !== "passed");
  if (failed.length > 0) {
    const detail = failed.map((check) => `${check?.name}: ${check?.error ?? "did not pass"}`).join("; ");
    throw new Error(`release-check-results.json contains a check that did not pass (${detail})`);
  }
  return checks;
}

function routeResult(routes, routeEvidence, field) {
  return routes.map((route) => ({
    route: route.id,
    status: routeEvidence?.routes?.[route.id]?.[field]?.verified === true ? "verified" : "not-evaluated",
    evidence: routeEvidence?.routes?.[route.id]?.[field] ?? null,
  }));
}

export function createEvidenceReport({ commitSha = releaseCommitSha(), generatedAt = new Date().toISOString() } = {}) {
  const packageJson = readJson("package.json");
  const inventory = readJson("dependency-inventory.json");
  const deployment = readJson("deployment-evidence.json");
  const socket = readJson("socket-dispositions.json");
  const socketScore = readJson("socket-score-report.json");
  const deploymentErrors = validateDeploymentManifest(deployment);
  const socketErrors = validateSocketReport(socket);
  const routes = Array.isArray(deployment.routes) ? deployment.routes : [];
  const socketAlerts = Array.isArray(socket.alerts) ? socket.alerts : [];
  const rawChecks = validateCheckResults(readOptionalJson("release-check-results.json"), { commitSha, releaseVersion: packageJson.version });
  const checks = rawChecks.map((check) => ({
    ...check,
    ...(check.name === "dependency-inventory" ? { summary: `${inventory.summary?.lockfilePackages ?? 0} lockfile packages classified` } : {}),
    ...(check.name === "deployment-evidence-policy" ? {
      status: deploymentErrors.length === 0 ? check.status : "failed",
      errors: deploymentErrors,
    } : {}),
    ...(check.name === "socket-release-policy" ? {
      status: socketErrors.length === 0 ? check.status : "failed",
      errors: socketErrors,
    } : {}),
  }));
  const routeEvidence = readOptionalJson("deployment-contract-evidence.json");
  const localRouteIds = routes.filter(({ status }) => status === "certified-local-contract").map(({ id }) => id);
  if (!routeEvidence || routeEvidence.commitSha !== commitSha || localRouteIds.some((id) => !routeEvidence.routes?.[id]?.imageVerification?.verified || !routeEvidence.routes?.[id]?.responseVerification?.verified)) {
    throw new Error("deployment-contract-evidence.json is missing, stale, or incomplete for local-certified routes");
  }
  const artifacts = REQUIRED_ARTIFACTS.map((file) => ({ file, sha256: sha256(join(root, file)) }));
  return {
    schemaVersion: 1,
    generatedAt,
    commitSha,
    releaseVersion: packageJson.version,
    verificationStatus: checks.some((check) => check.status === "failed") ? "failed" : "passed",
    toolchain: {
      node: process.version,
      npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/)?.[1] ?? null,
      platform: process.platform,
      arch: process.arch,
      lockfileVersion: inventory.controls?.lockfileVersion ?? null,
      lockfileSha256: inventory.controls?.lockfileSha256 ?? null,
    },
    checks,
    deploymentManifestStatus: deployment.status ?? null,
    routesEvaluated: routes.map(({ id, provider, runtime, status }) => ({ id, provider, runtime, status })),
    imageVerificationResults: routeResult(routes, routeEvidence, "imageVerification"),
    responseVerificationResults: routeResult(routes, routeEvidence, "responseVerification"),
    dependencyInventorySummary: inventory.summary,
    socketPolicy: {
      status: socket.status,
      alertCount: socketAlerts.length,
      result: socketErrors.length > 0 ? "failed" : "passed",
      scoreArtifact: "socket-score-report.json",
      baseline: {
        version: socketScore.version,
        captureKind: socketScore.captureKind,
        shallow: socketScore.shallow,
        deep: socketScore.deep,
      },
    },
    artifacts,
  };
}

function main() {
  const output = process.argv[2] ?? "release-evidence-report.json";
  const report = createEvidenceReport();
  writeFileSync(resolve(root, output), `${JSON.stringify(report, null, 2)}\n`);
  if (report.verificationStatus !== "passed") process.exitCode = 1;
  process.stdout.write(`Generated ${output}: ${report.verificationStatus}.\n`);
}

runScript(main, import.meta.url);
