import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runScript } from "./run-script.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const severities = new Set(["critical", "high", "medium", "low"]);
const statuses = new Set(["complete"]);
const reachabilities = new Set([
  "published-runtime",
  "runtime-peer",
  "runtime-peer-optional",
  "runtime-optional",
  "development-only",
  "development-optional",
  "optional-platform",
  "platform-binary",
  "unknown",
  "published-package-metadata",
]);

function normalizeSeverity(value) {
  if (value === "middle") return "medium";
  return value;
}

function isExpired(value, now = new Date()) {
  const expiry = new Date(value);
  return !Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime();
}

function packageIdentityFromExample(example) {
  if (typeof example !== "string") return {};
  const value = example.replace(/^npm\//, "");
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return { package: value };
  return { package: value.slice(0, at), version: value.slice(at + 1) };
}

function alertIdentity(alert, index, source = "score") {
  const example = packageIdentityFromExample(alert.example);
  const type = alert.type ?? alert.name;
  const packageName = alert.package ?? example.package;
  const version = alert.version ?? example.version;
  const path = alert.dependencyPath ?? alert.path ?? alert.lockfilePath;
  if (!type || !packageName || !version || !path) {
    return { error: `${source} alert ${index}: high/critical alerts require type, package, version, and dependency path` };
  }
  return {
    key: [type, packageName, version, path].join("|") ,
    type,
    package: packageName,
    version,
    path,
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function scoreArtifactPath(report) {
  return resolve(root, report.export.artifact);
}

function loadScoreArtifact(report) {
  const artifactPath = scoreArtifactPath(report);
  const score = readJson(artifactPath);
  const digest = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
  return { score, artifactPath, digest };
}

function policyAlerts(score) {
  return [
    ...(Array.isArray(score.shallow?.alerts) ? score.shallow.alerts : []),
    ...(Array.isArray(score.deep?.alerts) ? score.deep.alerts : []),
  ].filter((alert) => ["high", "critical"].includes(normalizeSeverity(alert?.severity)));
}

export function validateSocketReport(report, now = new Date()) {
  const errors = [];
  const policy = report.releasePolicy;
  if (report.schemaVersion !== 2) errors.push("schemaVersion must be 2");
  if (report.package !== "metaplate") errors.push("package must be metaplate");
  if (report.version !== undefined && report.version !== "0.6.0") errors.push("version must be the 0.6.0 Socket baseline");
  if (typeof report.source !== "string" || !/^https:\/\/socket\.dev\//.test(report.source)) errors.push("source must be a Socket HTTPS URL");
  if (!statuses.has(report.status)) errors.push(`unknown report status ${report.status}`);
  if (!policy || !Array.isArray(policy.blockSeverities) || !Array.isArray(policy.requireDispositionSeverities) || !Array.isArray(policy.allowedDispositionTypes) || !Array.isArray(policy.acceptedExceptionRequires)) {
    errors.push("releasePolicy is incomplete");
    return errors;
  }

  const blockSeverities = new Set(policy.blockSeverities.map(normalizeSeverity));
  const requireDispositionSeverities = new Set(policy.requireDispositionSeverities.map(normalizeSeverity));
  const allowedDispositions = new Set(policy.allowedDispositionTypes);
  const acceptedRequires = new Set(policy.acceptedExceptionRequires);
  for (const severity of [...blockSeverities, ...requireDispositionSeverities]) {
    if (!severities.has(severity)) errors.push(`unknown policy severity ${severity}`);
  }
  if (allowedDispositions.size === 0) errors.push("allowedDispositionTypes must not be empty");
  if (acceptedRequires.size === 0) errors.push("acceptedExceptionRequires must not be empty");
  if (!Array.isArray(report.alerts)) errors.push("alerts must be an array");
  if (errors.length > 0) return errors;

  for (const [index, alert] of report.alerts.entries()) {
    const prefix = `alert ${index}`;
    if (!alert || !alert.type || !alert.package || !alert.version || !alert.path) {
      errors.push(`${prefix}: missing identity fields`);
      continue;
    }
    const severity = normalizeSeverity(alert.severity);
    if (!severities.has(severity)) errors.push(`${prefix}: unknown severity ${alert.severity}`);
    if (!reachabilities.has(alert.reachability)) errors.push(`${prefix}: unknown reachability ${alert.reachability}`);
    if (!alert.evidence || !alert.verification) errors.push(`${prefix}: evidence and verification are required`);
    const required = requireDispositionSeverities.has(severity);
    if (required && !alert.disposition) errors.push(`${prefix}: disposition required for ${severity}`);
    if (alert.disposition && !allowedDispositions.has(alert.disposition)) {
      errors.push(`${prefix}: disposition is not allowed by releasePolicy`);
    }
    if (blockSeverities.has(severity)) {
      errors.push(`${prefix}: ${severity} findings block release under releasePolicy`);
    }
    if (alert.disposition === "accepted-with-evidence") {
      for (const field of acceptedRequires) {
        if (!alert[field]) errors.push(`${prefix}: accepted exception requires ${field}`);
      }
      if (alert.expiry && isExpired(alert.expiry, now)) errors.push(`${prefix}: accepted exception is expired`);
    }
  }

  if (report.status === "complete") {
    if (!report.export || !report.export.artifact || !report.export.generatedAt || !report.export.sha256) {
      errors.push("complete reports require export artifact, generatedAt, and sha256 provenance");
    } else {
      try {
        const { score, digest } = loadScoreArtifact(report);
        if (digest !== report.export.sha256) errors.push("complete report export sha256 does not match its artifact");
        if (score.schemaVersion !== 2) errors.push("complete report score artifact schemaVersion must be 2");
        if (score.package !== report.package) errors.push("complete report score artifact package does not match disposition package");
        if (score.version !== report.version) errors.push("complete report score artifact version does not match disposition version");
        if (typeof score.source !== "string" || !/^https:\/\/socket\.dev\//.test(score.source)) errors.push("complete report score artifact source must be a Socket HTTPS URL");

        const scoreAlerts = policyAlerts(score);
        if (!Array.isArray(score.shallow?.alerts) || !Array.isArray(score.deep?.alerts)) {
          errors.push("complete report score artifact must contain shallow and deep alert arrays");
        }
        const scoreIdentities = new Map();
        for (const [index, scoreAlert] of scoreAlerts.entries()) {
          const identity = alertIdentity(scoreAlert, index);
          if (identity.error) {
            errors.push(identity.error);
          } else if (scoreIdentities.has(identity.key)) {
            errors.push(`score alert ${index}: duplicate high/critical alert identity`);
          } else {
            scoreIdentities.set(identity.key, identity);
          }
        }

        const dispositionIdentities = new Map();
        for (const [index, disposition] of report.alerts.entries()) {
          const severity = normalizeSeverity(disposition.severity);
          if (!requireDispositionSeverities.has(severity)) continue;
          const identity = alertIdentity(disposition, index, "disposition");
          if (identity.error) {
            errors.push(identity.error);
            continue;
          }
          if (dispositionIdentities.has(identity.key)) {
            errors.push(`disposition ${index}: duplicate high/critical alert identity`);
          } else {
            dispositionIdentities.set(identity.key, identity);
          }
          const scoreIdentity = scoreIdentities.get(identity.key);
          if (!scoreIdentity) {
            errors.push(`disposition ${index}: high/critical alert does not exist in score artifact`);
          }
        }

        for (const [key, scoreIdentity] of scoreIdentities) {
          if (!dispositionIdentities.has(key)) {
            errors.push(`score alert ${scoreIdentity.type} ${scoreIdentity.package}@${scoreIdentity.version}: missing disposition`);
          }
        }

        if (scoreAlerts.length === 0 && report.alerts.some((alert) => requireDispositionSeverities.has(normalizeSeverity(alert.severity)))) {
          errors.push("disposition contains policy-severity alert absent from score artifact");
        }
        const declaredHighCritical = [
          ...(Array.isArray(score.highCriticalDisposition?.high) ? score.highCriticalDisposition.high : []),
          ...(Array.isArray(score.highCriticalDisposition?.critical) ? score.highCriticalDisposition.critical : []),
        ];
        if (scoreAlerts.length === 0 && declaredHighCritical.length > 0) {
          errors.push("score artifact contains no high/critical alerts but highCriticalDisposition is non-empty");
        }
      } catch {
        errors.push(`complete report export artifact is not readable: ${report.export.artifact}`);
      }
    }
  }
  if (report.status === "complete" && report.alerts.some((alert) =>
    !alert.disposition && requireDispositionSeverities.has(normalizeSeverity(alert.severity)))) {
    errors.push("complete reports require dispositions for all policy-severity alerts");
  }
  return errors;
}

export function loadSocketReport(file = join(root, "socket-dispositions.json")) {
  return readJson(file);
}

function main() {
  const report = loadSocketReport(process.argv[2]);
  const errors = validateSocketReport(report);
  if (errors.length > 0) throw new Error(`Invalid Socket disposition report:\n- ${errors.join("\n- ")}`);
  process.stdout.write(`Verified Socket disposition report: ${report.alerts.length} alerts, status ${report.status}.\n`);
}

runScript(main, import.meta.url);
