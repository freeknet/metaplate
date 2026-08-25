import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runScript } from "./run-script.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const severities = new Set(["critical", "high", "medium", "low"]);
const statuses = new Set(["awaiting-alert-export", "complete"]);
const reachabilities = new Set(["published-runtime", "runtime-peer", "development-only", "optional-platform", "unknown"]);

function isExpired(value, now = new Date()) {
  const expiry = new Date(value);
  return !Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime();
}

export function validateSocketReport(report, now = new Date()) {
  const errors = [];
  const policy = report.releasePolicy;
  if (report.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (report.package !== "metaplate") errors.push("package must be metaplate");
  if (typeof report.source !== "string" || !/^https:\/\/socket\.dev\//.test(report.source)) errors.push("source must be a Socket HTTPS URL");
  if (!statuses.has(report.status)) errors.push(`unknown report status ${report.status}`);
  if (!policy || !Array.isArray(policy.blockSeverities) || !Array.isArray(policy.requireDispositionSeverities) || !Array.isArray(policy.allowedDispositionTypes) || !Array.isArray(policy.acceptedExceptionRequires)) {
    errors.push("releasePolicy is incomplete");
    return errors;
  }

  const blockSeverities = new Set(policy.blockSeverities);
  const requireDispositionSeverities = new Set(policy.requireDispositionSeverities);
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
    if (!severities.has(alert.severity)) errors.push(`${prefix}: unknown severity ${alert.severity}`);
    if (!reachabilities.has(alert.reachability)) errors.push(`${prefix}: unknown reachability ${alert.reachability}`);
    if (!alert.evidence || !alert.verification) errors.push(`${prefix}: evidence and verification are required`);
    const required = requireDispositionSeverities.has(alert.severity);
    if (required && !alert.disposition) errors.push(`${prefix}: disposition required for ${alert.severity}`);
    if (alert.disposition && !allowedDispositions.has(alert.disposition)) {
      errors.push(`${prefix}: disposition is not allowed by releasePolicy`);
    }
    if (blockSeverities.has(alert.severity)) {
      errors.push(`${prefix}: ${alert.severity} findings block release under releasePolicy`);
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
    }
  }
  if (report.status === "awaiting-alert-export" && report.alerts.length !== 0) {
    errors.push("awaiting-alert-export reports must not contain partial alerts");
  }
  if (report.status === "complete" && report.alerts.some((alert) =>
    !alert.disposition && requireDispositionSeverities.has(alert.severity))) {
    errors.push("complete reports require dispositions for all policy-severity alerts");
  }
  return errors;
}

export function loadSocketReport(file = join(root, "socket-dispositions.json")) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function main() {
  const report = loadSocketReport(process.argv[2]);
  const errors = validateSocketReport(report);
  if (errors.length > 0) throw new Error(`Invalid Socket disposition report:\n- ${errors.join("\n- ")}`);
  process.stdout.write(`Verified Socket disposition report: ${report.alerts.length} alerts, status ${report.status}.\n`);
}

runScript(main, import.meta.url);
