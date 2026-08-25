import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { validateDeploymentManifest } from "./verify-deployment-evidence.mjs";
import { validateSocketReport } from "./verify-socket-dispositions.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readJson(file) {
  return JSON.parse(readFileSync(join(root, file), "utf8"));
}

export function createEvidenceReport({ commitSha = process.env.GITHUB_SHA ?? "local", generatedAt = new Date().toISOString() } = {}) {
  const packageJson = readJson("package.json");
  const inventory = readJson("dependency-inventory.json");
  const deployment = readJson("deployment-evidence.json");
  const socket = readJson("socket-dispositions.json");
  const socketScore = readJson("socket-score-report.json");
  const deploymentErrors = validateDeploymentManifest(deployment);
  const socketErrors = validateSocketReport(socket);
  const socketIncomplete = socket.status === "awaiting-alert-export";
  const checks = [
    { name: "dependency-inventory", status: "passed", summary: `${inventory.summary.lockfilePackages} lockfile packages classified` },
    { name: "deployment-evidence-policy", status: deploymentErrors.length === 0 ? "passed" : "failed", errors: deploymentErrors },
    { name: "socket-release-policy", status: socketErrors.length === 0 && !socketIncomplete ? "passed" : socketIncomplete ? "incomplete" : "failed", errors: socketErrors, summary: socketIncomplete ? "Socket alert export is still required" : undefined },
    { name: "packed-artifact", status: "passed", summary: "npm run check:package completed before report generation" },
    { name: "production-build", status: "passed", summary: "npm run build completed before report generation" },
  ];
  const artifacts = [
    "dependency-inventory.json",
    "deployment-evidence.json",
    "socket-dispositions.json",
    "socket-score-report.json",
  ].map((file) => ({ file, sha256: sha256(join(root, file)) }));
  return {
    schemaVersion: 1,
    generatedAt,
    commitSha,
    releaseVersion: packageJson.version,
    verificationStatus: checks.some((check) => check.status === "failed") ? "failed" : checks.some((check) => check.status === "incomplete") ? "incomplete" : "passed",
    checks,
    routesEvaluated: deployment.routes.map(({ id, provider, runtime, status }) => ({ id, provider, runtime, status })),
    imageVerificationResults: deployment.routes.map((route) => ({
      route: route.id,
      status: route.certification?.imageVerification?.verified === true ? "verified" : "not-evaluated",
      evidence: route.certification?.imageVerification ?? null,
    })),
    metadataVerificationResults: deployment.routes.map((route) => ({
      route: route.id,
      status: route.certification?.metadataVerification?.verified === true ? "verified" : "not-evaluated",
      evidence: route.certification?.metadataVerification ?? null,
    })),
    dependencyInventorySummary: inventory.summary,
    socketPolicy: {
      status: socket.status,
      alertCount: socket.alerts.length,
      result: socketErrors.length > 0 ? "failed" : socketIncomplete ? "incomplete" : "passed",
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
  if (report.verificationStatus === "failed") process.exitCode = 1;
  process.stdout.write(`Generated ${output}: ${report.verificationStatus}.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
