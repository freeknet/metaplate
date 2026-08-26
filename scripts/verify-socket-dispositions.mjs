import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runScript } from "./run-script.mjs";
import {
  classifyLockPackages,
  strongestReachability,
} from "./dependency-model.mjs";
import {
  REACHABILITY_VALUES,
  SOCKET_RELEASE_POLICY,
  validateReleasePolicy,
  normalizeSeverity,
  validateSocketSource,
  normalizeAlertIdentity,
  validateScoreAlert,
  validateResolvedEvidence,
  validateUnresolvedEvidence,
  validateSocketScoreVector,
  validateDeepAuxiliary,
  validateCapturedAt,
  validateNormalizedAt,
  validatePackageSizeBytes,
  validateCanonicalSeverity,
} from "./socket-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statuses = new Set(["complete"]);

function isExpired(value, now = new Date()) {
  const expiry = new Date(value);
  return !Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime();
}

function policyAlertIdentity(alert, index, source = "score") {
  const identity = normalizeAlertIdentity(alert);
  if (identity.error) return { error: `${source} alert ${index}: ${identity.error}` };

  const evidence = alert.dependencyEvidence ?? {};
  const path = alert.dependencyPath ?? alert.path;
  const effectiveReachability = evidence.reachability ?? alert.reachability;
  const severity = normalizeSeverity(alert.severity);

  if (!identity.package || !identity.version || !path) {
    return {
      error: `${source} alert ${index}: high/critical alerts require package, version, and dependency path`,
    };
  }
  return {
    key: [identity.type, identity.package, identity.version, path].join("|"),
    type: identity.type,
    package: identity.package,
    version: identity.version,
    path,
    reachability: effectiveReachability,
    severity,
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
  const digest = createHash("sha256")
    .update(readFileSync(artifactPath))
    .digest("hex");
  return { score, artifactPath, digest };
}

function currentInventory() {
  const manifest = readJson(join(root, "package.json"));
  const lockfile = readJson(join(root, "package-lock.json"));
  return classifyLockPackages({ root, manifest, lockfile });
}

function policyAlerts(score) {
  return [
    ...(Array.isArray(score.shallow?.alerts) ? score.shallow.alerts : []),
    ...(Array.isArray(score.deep?.alerts) ? score.deep.alerts : []),
  ].filter((alert) =>
    SOCKET_RELEASE_POLICY.requireDispositionSeverities.includes(
      normalizeSeverity(alert?.severity),
    ),
  );
}

/**
 * Validate every score artifact alert's schema and dependency evidence.
 */
function validateScoreAlertSchemas(score, inventory, errors) {
  const shallowScoreError = validateSocketScoreVector(score.shallow?.score, "shallow");
  if (shallowScoreError) errors.push(`score artifact: ${shallowScoreError}`);
  const deepScoreError = validateSocketScoreVector(score.deep?.score, "deep");
  if (deepScoreError) errors.push(`score artifact: ${deepScoreError}`);

  const auxErrors = validateDeepAuxiliary(score.deep, "score.deep");
  for (const err of auxErrors) errors.push(`score artifact: ${err}`);

  const capErr = validateCapturedAt(score.capturedAt);
  if (capErr) errors.push(`score artifact: ${capErr}`);

  const sizeErr = validatePackageSizeBytes(score.packageSizeBytes);
  if (sizeErr) errors.push(`score artifact: ${sizeErr}`);

  const allAlerts = [
    ...(Array.isArray(score.shallow?.alerts) ? score.shallow.alerts.map((a, i) => ({ alert: a, idx: i, scope: "shallow" })) : []),
    ...(Array.isArray(score.deep?.alerts) ? score.deep.alerts.map((a, i) => ({ alert: a, idx: i, scope: "deep" })) : []),
  ];

  for (const { alert, idx, scope } of allAlerts) {
    const prefix = `${scope}[${idx}]`;
    const schemaError = validateScoreAlert(alert, prefix);
    if (schemaError) {
      errors.push(`score artifact: ${schemaError}`);
      continue;
    }

    const identity = normalizeAlertIdentity(alert);
    if (identity.error) {
      errors.push(`score artifact: ${prefix}: ${identity.error}`);
      continue;
    }

    const matches =
      identity.package && identity.version
        ? inventory.filter(
            (e) => e.name === identity.package && e.version === identity.version,
          )
        : [];

    if (matches.length > 0) {
      const evError = validateResolvedEvidence(alert, prefix);
      if (evError) {
        errors.push(`score artifact: ${evError}`);
      } else {
        const evidence = alert.dependencyEvidence;
        const expectedPaths = [...new Set(matches.flatMap((e) => e.dependencyPaths ?? []))].sort();
        const expectedReachability = strongestReachability(matches.map((e) => e.classification));
        if (JSON.stringify(evidence.paths ?? []) !== JSON.stringify(expectedPaths)) {
          errors.push(`score artifact: ${prefix}: dependencyEvidence.paths does not match current inventory`);
        }
        if (evidence.reachability !== expectedReachability) {
          errors.push(`score artifact: ${prefix}: dependencyEvidence.reachability does not match current inventory`);
        }
        if (alert.reachability !== undefined && alert.reachability !== evidence.reachability) {
          errors.push(`score artifact: ${prefix}: alert.reachability does not match dependencyEvidence.reachability`);
        }
        if (alert.dependencyPath !== undefined && !evidence.paths.includes(alert.dependencyPath)) {
          errors.push(`score artifact: ${prefix}: alert.dependencyPath is not in dependencyEvidence.paths`);
        }
      }
    } else if (alert.dependencyEvidence) {
      const evError = validateUnresolvedEvidence(alert, prefix);
      if (evError) {
        errors.push(`score artifact: ${evError}`);
      }
    } else if (identity.package && identity.version) {
      errors.push(`score artifact: ${prefix}: missing dependencyEvidence for unresolved alert`);
    }
  }
}

export function validateSocketReport(report, now = new Date()) {
  const errors = [];
  const policy = report.releasePolicy;

  if (report.schemaVersion !== 2) errors.push("schemaVersion must be 2");
  if (report.package !== "metaplate") errors.push("package must be metaplate");
  if (report.version !== undefined && report.version !== "0.6.0")
    errors.push("version must be the 0.6.0 Socket baseline");

  if (typeof report.source === "string") {
    const sourceError = validateSocketSource(report.source, "metaplate", report.version);
    if (sourceError) errors.push(sourceError);
  } else {
    errors.push("source must be a Socket HTTPS URL");
  }

  if (!statuses.has(report.status))
    errors.push(`unknown report status ${report.status}`);

  if (!policy) {
    errors.push("releasePolicy is missing");
    if (!Array.isArray(report.alerts)) errors.push("alerts must be an array");
    return errors;
  }
  const policyErrors = validateReleasePolicy(policy);
  errors.push(...policyErrors);
  if (policyErrors.length > 0) {
    if (!Array.isArray(report.alerts)) errors.push("alerts must be an array");
    return errors;
  }

  const blockSeverities = new Set(SOCKET_RELEASE_POLICY.blockSeverities);
  const requireDispositionSeverities = new Set(SOCKET_RELEASE_POLICY.requireDispositionSeverities);
  const allowedDispositions = new Set(SOCKET_RELEASE_POLICY.allowedDispositionTypes);
  const acceptedRequires = new Set(SOCKET_RELEASE_POLICY.acceptedExceptionRequires);

  if (!Array.isArray(report.alerts)) {
    errors.push("alerts must be an array");
    return errors;
  }

  for (const [index, alert] of report.alerts.entries()) {
    const prefix = `alert ${index}`;
    if (!alert || typeof alert !== "object") {
      errors.push(`${prefix}: must be an object`);
      continue;
    }

    const requiredStrings = ["type", "package", "version", "path", "reachability", "evidence", "verification"];
    for (const field of requiredStrings) {
      if (typeof alert[field] !== "string" || !alert[field].trim()) {
        errors.push(`${prefix}: ${field} must be a non-empty string`);
        break;
      }
    }
    if (errors.length > 0 && errors[errors.length - 1].includes(prefix)) continue;

    const sevErr = validateCanonicalSeverity(alert.severity);
    if (sevErr) {
      errors.push(`${prefix}: ${sevErr}`);
      continue;
    }

    if (alert.disposition && !allowedDispositions.has(alert.disposition)) {
      errors.push(`${prefix}: disposition "${alert.disposition}" is not allowed by release policy`);
    }

    if (!REACHABILITY_VALUES.includes(alert.reachability)) {
      errors.push(`${prefix}: reachability "${alert.reachability}" is not a recognized value`);
    }

    if (!requireDispositionSeverities.has(alert.severity)) {
      errors.push(`${prefix}: disposition reports should only contain high/critical alerts, got "${alert.severity}"`);
    }

    if (requireDispositionSeverities.has(alert.severity) && !alert.disposition) {
      errors.push(`${prefix}: disposition required for ${alert.severity}`);
    }

    if (blockSeverities.has(alert.severity)) {
      errors.push(`${prefix}: ${alert.severity} findings block release under release policy`);
    }

    if (alert.disposition === "accepted-with-evidence") {
      for (const field of acceptedRequires) {
        if (typeof alert[field] !== "string" || !alert[field].trim()) {
          errors.push(`${prefix}: accepted exception requires ${field} as a non-empty string`);
        }
      }
      if (typeof alert.expiry === "string" && alert.expiry.trim()) {
        const expiryError = validateCapturedAt(alert.expiry, `${prefix} expiry`);
        if (expiryError) {
          errors.push(expiryError);
        } else if (isExpired(alert.expiry, now)) {
          errors.push(`${prefix}: accepted exception is expired`);
        }
      }
    }
  }

  if (report.status === "complete") {
    if (!report.export || !report.export.artifact || !report.export.generatedAt || !report.export.sha256) {
      errors.push("complete reports require export artifact, generatedAt, and sha256 provenance");
    } else {
      try {
        const { score, digest } = loadScoreArtifact(report);
        if (digest !== report.export.sha256)
          errors.push("complete report export sha256 does not match its artifact");
        if (score.schemaVersion !== 2)
          errors.push("complete report score artifact schemaVersion must be 2");
        if (score.package !== report.package)
          errors.push("complete report score artifact package does not match disposition package");
        if (score.version !== report.version)
          errors.push("complete report score artifact version does not match disposition version");

        if (typeof score.source === "string") {
          const scoreSourceError = validateSocketSource(score.source, score.package, score.version);
          if (scoreSourceError) errors.push(`complete report score artifact: ${scoreSourceError}`);
        } else {
          errors.push("complete report score artifact source must be a Socket HTTPS URL");
        }

        if (score.captureKind === "socket-cli-import") {
          if (!/^[a-f0-9]{64}$/i.test(score.provenance?.inputSha256 ?? ""))
            errors.push("socket-cli-import score artifact requires a valid 64-character inputSha256");
          const normalizedAtError = validateNormalizedAt(score.normalizedAt);
          if (normalizedAtError)
            errors.push(`socket-cli-import score artifact: ${normalizedAtError}`);
        } else if (score.captureKind === "historical-normalized-snapshot") {
          if (score.provenance?.rawInputSha256 !== null || score.provenance?.rawInputRetained !== false)
            errors.push("historical-normalized-snapshot must explicitly state that raw input is unavailable");
        } else {
          errors.push(`unknown score artifact captureKind ${score.captureKind}`);
        }

        const inventory = currentInventory();
        validateScoreAlertSchemas(score, inventory, errors);

        const allScoreAlerts = [...(score.shallow?.alerts ?? []), ...(score.deep?.alerts ?? [])];
        for (const [index, scoreAlert] of allScoreAlerts.entries()) {
          const identity = normalizeAlertIdentity(scoreAlert);
          if (identity.error || !identity.package || !identity.version) continue;
          const matches = inventory.filter(
            (entry) => entry.name === identity.package && entry.version === identity.version,
          );
          if (matches.length === 0) {
            if (
              scoreAlert.dependencyEvidence?.unresolved !== true ||
              scoreAlert.dependencyEvidence?.reachability !== "unknown" ||
              (scoreAlert.dependencyEvidence?.paths ?? []).length !== 0
            ) {
              errors.push(`score alert ${index}: unmatched package/version must be explicitly unresolved`);
            }
            continue;
          }
          const paths = [...new Set(matches.flatMap((entry) => entry.dependencyPaths ?? []))].sort();
          const expectedReachability = strongestReachability(matches.map((entry) => entry.classification));
          const evidence = scoreAlert.dependencyEvidence;
          if (
            !evidence ||
            JSON.stringify(evidence.paths ?? []) !== JSON.stringify(paths) ||
            evidence.reachability !== expectedReachability
          ) {
            errors.push(`score alert ${index}: dependency evidence does not match current inventory`);
          }
        }

        if (!Array.isArray(score.shallow?.alerts) || !Array.isArray(score.deep?.alerts))
          errors.push("complete report score artifact must contain shallow and deep alert arrays");

        for (const [index, scoreAlert] of allScoreAlerts.entries()) {
          const severity = normalizeSeverity(scoreAlert?.severity);
          if (blockSeverities.has(severity)) {
            const identity = normalizeAlertIdentity(scoreAlert);
            const label = identity.error
              ? `score alert ${index}`
              : `${identity.type} ${identity.package ?? "unknown"}@${identity.version ?? "unknown"}`;
            errors.push(`score artifact: ${severity} finding ${label} blocks release under release policy`);
          }
        }

        const scoreAlerts = policyAlerts(score);
        const scoreIdentities = new Map();
        const scoreEvidenceByKey = new Map();
        for (const [index, scoreAlert] of scoreAlerts.entries()) {
          const identity = policyAlertIdentity(scoreAlert, index);
          if (identity.error) {
            errors.push(identity.error);
          } else if (scoreIdentities.has(identity.key)) {
            errors.push(`score alert ${index}: duplicate high/critical alert identity`);
          } else {
            scoreIdentities.set(identity.key, identity);
            scoreEvidenceByKey.set(identity.key, scoreAlert.dependencyEvidence ?? null);
          }
        }

        const dispositionIdentities = new Map();
        for (const [index, disposition] of report.alerts.entries()) {
          const severity = normalizeSeverity(disposition.severity);
          if (!requireDispositionSeverities.has(severity)) continue;
          const identity = policyAlertIdentity(disposition, index, "disposition");
          if (identity.error) {
            errors.push(identity.error);
            continue;
          }
          if (dispositionIdentities.has(identity.key)) {
            errors.push(`disposition ${index}: duplicate high/critical alert identity`);
            continue;
          }

          const scoreIdentity = scoreIdentities.get(identity.key);
          if (!scoreIdentity) {
            errors.push(`disposition ${index}: high/critical alert does not exist in score artifact`);
            continue;
          }

          if (identity.severity !== scoreIdentity.severity) {
            errors.push(
              `disposition ${index}: severity ${identity.severity} does not match score artifact severity ${scoreIdentity.severity}`,
            );
            continue;
          }

          dispositionIdentities.set(identity.key, identity);

          const evidence = scoreEvidenceByKey.get(identity.key);
          const expectedReachability = evidence?.reachability;
          if (expectedReachability && identity.reachability !== expectedReachability) {
            errors.push(`disposition ${index}: reachability does not match score artifact evidence`);
          }
          if (Array.isArray(evidence?.paths) && evidence.paths.length > 0 && !evidence.paths.includes(identity.path)) {
            errors.push(`disposition ${index}: path is not present in score artifact evidence`);
          }
        }

        for (const [key, scoreIdentity] of scoreIdentities) {
          if (!dispositionIdentities.has(key)) {
            errors.push(`score alert ${scoreIdentity.type} ${scoreIdentity.package}@${scoreIdentity.version}: missing disposition`);
          }
        }

        if (scoreAlerts.length === 0 && report.alerts.some((a) => requireDispositionSeverities.has(normalizeSeverity(a.severity)))) {
          errors.push("disposition contains policy-severity alert absent from score artifact");
        }
      } catch {
        errors.push(`complete report export artifact is not readable: ${report.export.artifact}`);
      }
    }
  }
  if (report.status === "complete" && report.alerts.some((a) => !a.disposition && requireDispositionSeverities.has(normalizeSeverity(a.severity)))) {
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
  if (errors.length > 0)
    throw new Error(`Invalid Socket disposition report:\n- ${errors.join("\n- ")}`);
  process.stdout.write(
    `Verified Socket disposition report: ${report.alerts.length} alerts, status ${report.status}.\n`,
  );
}

runScript(main, import.meta.url);