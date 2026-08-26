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
  CANONICAL_SEVERITIES,
  REACHABILITY_VALUES,
  normalizeSeverity,
  validateSocketSource,
  normalizeAlertIdentity,
  validateScoreAlert,
  validateResolvedEvidence,
  validateUnresolvedEvidence,
} from "./socket-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const severities = new Set(CANONICAL_SEVERITIES);
const statuses = new Set(["complete"]);
const reachabilities = new Set(REACHABILITY_VALUES);

function isExpired(value, now = new Date()) {
  const expiry = new Date(value);
  return !Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime();
}

/**
 * Canonical alert identity for policy matching. Uses the shared normalizer
 * and requires a dependency path for high/critical alerts.
 */
function policyAlertIdentity(alert, index, source = "score") {
  const identity = normalizeAlertIdentity(alert);
  if (identity.error) return { error: `${source} alert ${index}: ${identity.error}` };

  // For policy identity, we also need a path. Prefer the one from dependencyEvidence.
  const evidence = alert.dependencyEvidence ?? {};
  const path = alert.dependencyPath ?? alert.path ?? alert.lockfilePath;
  const effectiveReachability = evidence.reachability ?? alert.reachability;

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
    ["high", "critical"].includes(normalizeSeverity(alert?.severity)),
  );
}

/**
 * Validate every score artifact alert's schema and dependency evidence.
 * Uses the canonical identity normalizer everywhere.
 * Requires dependencyEvidence for every alert with a package identity.
 * Validates deduped derived fields match canonical evidence.
 */
function validateScoreAlertSchemas(score, inventory, errors) {
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

    // Use canonical identity for inventory lookup
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
        // Validate deduped derived fields match canonical evidence
        const evidence = alert.dependencyEvidence;
        const expectedPaths = [...new Set(matches.flatMap((e) => e.dependencyPaths ?? []))].sort();
        const expectedReachability = strongestReachability(matches.map((e) => e.classification));
        if (JSON.stringify(evidence.paths ?? []) !== JSON.stringify(expectedPaths)) {
          errors.push(`score artifact: ${prefix}: dependencyEvidence.paths does not match current inventory`);
        }
        if (evidence.reachability !== expectedReachability) {
          errors.push(`score artifact: ${prefix}: dependencyEvidence.reachability does not match current inventory`);
        }
        // Validate deduped top-level derived fields if present
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
      // Alert has a package identity but no dependencyEvidence and no lockfile match
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

  // Strict source validation using shared helper
  if (typeof report.source === "string") {
    const sourceError = validateSocketSource(
      report.source,
      "metaplate",
      report.version,
    );
    if (sourceError) errors.push(sourceError);
  } else {
    errors.push("source must be a Socket HTTPS URL");
  }

  if (!statuses.has(report.status))
    errors.push(`unknown report status ${report.status}`);
  if (
    !policy ||
    !Array.isArray(policy.blockSeverities) ||
    !Array.isArray(policy.requireDispositionSeverities) ||
    !Array.isArray(policy.allowedDispositionTypes) ||
    !Array.isArray(policy.acceptedExceptionRequires)
  ) {
    errors.push("releasePolicy is incomplete");
    return errors;
  }

  const blockSeverities = new Set(
    policy.blockSeverities.map(normalizeSeverity),
  );
  const requireDispositionSeverities = new Set(
    policy.requireDispositionSeverities.map(normalizeSeverity),
  );
  const allowedDispositions = new Set(policy.allowedDispositionTypes);
  const acceptedRequires = new Set(policy.acceptedExceptionRequires);
  for (const severity of [...blockSeverities, ...requireDispositionSeverities]) {
    if (!severities.has(severity))
      errors.push(`unknown policy severity ${severity}`);
  }
  if (allowedDispositions.size === 0)
    errors.push("allowedDispositionTypes must not be empty");
  if (acceptedRequires.size === 0)
    errors.push("acceptedExceptionRequires must not be empty");
  if (!Array.isArray(report.alerts)) errors.push("alerts must be an array");
  if (errors.length > 0) return errors;

  for (const [index, alert] of report.alerts.entries()) {
    const prefix = `alert ${index}`;
    if (
      !alert ||
      !alert.type ||
      !alert.package ||
      !alert.version ||
      !alert.path
    ) {
      errors.push(`${prefix}: missing identity fields`);
      continue;
    }
    const severity = normalizeSeverity(alert.severity);
    if (!severities.has(severity))
      errors.push(`${prefix}: unknown severity ${alert.severity}`);
    if (!reachabilities.has(alert.reachability))
      errors.push(`${prefix}: unknown reachability ${alert.reachability}`);
    if (!alert.evidence || !alert.verification)
      errors.push(`${prefix}: evidence and verification are required`);
    const required = requireDispositionSeverities.has(severity);
    if (required && !alert.disposition)
      errors.push(`${prefix}: disposition required for ${severity}`);
    if (alert.disposition && !allowedDispositions.has(alert.disposition)) {
      errors.push(
        `${prefix}: disposition is not allowed by releasePolicy`,
      );
    }
    if (blockSeverities.has(severity)) {
      errors.push(
        `${prefix}: ${severity} findings block release under releasePolicy`,
      );
    }
    if (alert.disposition === "accepted-with-evidence") {
      for (const field of acceptedRequires) {
        if (!alert[field])
          errors.push(`${prefix}: accepted exception requires ${field}`);
      }
      if (alert.expiry && isExpired(alert.expiry, now))
        errors.push(`${prefix}: accepted exception is expired`);
    }
  }

  if (report.status === "complete") {
    if (
      !report.export ||
      !report.export.artifact ||
      !report.export.generatedAt ||
      !report.export.sha256
    ) {
      errors.push(
        "complete reports require export artifact, generatedAt, and sha256 provenance",
      );
    } else {
      try {
        const { score, digest } = loadScoreArtifact(report);
        if (digest !== report.export.sha256)
          errors.push(
            "complete report export sha256 does not match its artifact",
          );
        if (score.schemaVersion !== 2)
          errors.push("complete report score artifact schemaVersion must be 2");
        if (score.package !== report.package)
          errors.push(
            "complete report score artifact package does not match disposition package",
          );
        if (score.version !== report.version)
          errors.push(
            "complete report score artifact version does not match disposition version",
          );

        // Strict source validation on score artifact
        if (typeof score.source === "string") {
          const scoreSourceError = validateSocketSource(
            score.source,
            score.package,
            score.version,
          );
          if (scoreSourceError)
            errors.push(
              `complete report score artifact: ${scoreSourceError}`,
            );
        } else {
          errors.push(
            "complete report score artifact source must be a Socket HTTPS URL",
          );
        }

        if (score.captureKind === "socket-cli-import") {
          if (
            !/^[a-f0-9]{64}$/i.test(score.provenance?.inputSha256 ?? "")
          ) {
            errors.push(
              "socket-cli-import score artifact requires a valid 64-character inputSha256",
            );
          }
        } else if (score.captureKind === "historical-normalized-snapshot") {
          if (
            score.provenance?.rawInputSha256 !== null ||
            score.provenance?.rawInputRetained !== false
          ) {
            errors.push(
              "historical-normalized-snapshot must explicitly state that raw input is unavailable",
            );
          }
        } else {
          errors.push(
            `unknown score artifact captureKind ${score.captureKind}`,
          );
        }

        // Validate historical score alert schemas against current inventory
        const inventory = currentInventory();
        validateScoreAlertSchemas(score, inventory, errors);

        // Cross-check every exact package/version using canonical identity
        const allScoreAlerts = [
          ...(score.shallow?.alerts ?? []),
          ...(score.deep?.alerts ?? []),
        ];
        for (const [index, scoreAlert] of allScoreAlerts.entries()) {
          const identity = normalizeAlertIdentity(scoreAlert);
          if (identity.error || !identity.package || !identity.version) continue;
          const matches = inventory.filter(
            (entry) =>
              entry.name === identity.package &&
              entry.version === identity.version,
          );
          if (matches.length === 0) {
            if (
              scoreAlert.dependencyEvidence?.unresolved !== true ||
              scoreAlert.dependencyEvidence?.reachability !== "unknown" ||
              (scoreAlert.dependencyEvidence?.paths ?? []).length !== 0
            ) {
              errors.push(
                `score alert ${index}: unmatched package/version must be explicitly unresolved`,
              );
            }
            continue;
          }
          const paths = [
            ...new Set(
              matches.flatMap((entry) => entry.dependencyPaths ?? []),
            ),
          ].sort();
          const expectedReachability = strongestReachability(
            matches.map((entry) => entry.classification),
          );
          const evidence = scoreAlert.dependencyEvidence;
          if (
            !evidence ||
            JSON.stringify(evidence.paths ?? []) !==
              JSON.stringify(paths) ||
            evidence.reachability !== expectedReachability
          ) {
            errors.push(
              `score alert ${index}: dependency evidence does not match current inventory`,
            );
          }
        }

        if (
          !Array.isArray(score.shallow?.alerts) ||
          !Array.isArray(score.deep?.alerts)
        ) {
          errors.push(
            "complete report score artifact must contain shallow and deep alert arrays",
          );
        }

        const scoreAlerts = policyAlerts(score);
        const scoreIdentities = new Map();
        const scoreEvidenceByKey = new Map();
        for (const [index, scoreAlert] of scoreAlerts.entries()) {
          const identity = policyAlertIdentity(scoreAlert, index);
          if (identity.error) {
            errors.push(identity.error);
          } else if (scoreIdentities.has(identity.key)) {
            errors.push(
              `score alert ${index}: duplicate high/critical alert identity`,
            );
          } else {
            scoreIdentities.set(identity.key, identity);
            scoreEvidenceByKey.set(
              identity.key,
              scoreAlert.dependencyEvidence ?? null,
            );
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
            errors.push(
              `disposition ${index}: duplicate high/critical alert identity`,
            );
          } else {
            dispositionIdentities.set(identity.key, identity);
          }
          const scoreIdentity = scoreIdentities.get(identity.key);
          if (!scoreIdentity) {
            errors.push(
              `disposition ${index}: high/critical alert does not exist in score artifact`,
            );
          } else {
            const evidence = scoreEvidenceByKey.get(identity.key);
            const expectedReachability =
              evidence?.reachability ?? scoreIdentity.reachability;
            if (
              expectedReachability &&
              identity.reachability !== expectedReachability
            ) {
              errors.push(
                `disposition ${index}: reachability does not match score artifact evidence`,
              );
            }
            if (
              Array.isArray(evidence?.paths) &&
              evidence.paths.length > 0 &&
              !evidence.paths.includes(identity.path)
            ) {
              errors.push(
                `disposition ${index}: path is not present in score artifact evidence`,
              );
            }
          }
        }

        for (const [key, scoreIdentity] of scoreIdentities) {
          if (!dispositionIdentities.has(key)) {
            errors.push(
              `score alert ${scoreIdentity.type} ${scoreIdentity.package}@${scoreIdentity.version}: missing disposition`,
            );
          }
        }

        if (
          scoreAlerts.length === 0 &&
          report.alerts.some((alert) =>
            requireDispositionSeverities.has(
              normalizeSeverity(alert.severity),
            ),
          )
        ) {
          errors.push(
            "disposition contains policy-severity alert absent from score artifact",
          );
        }
      } catch {
        errors.push(
          `complete report export artifact is not readable: ${report.export.artifact}`,
        );
      }
    }
  }
  if (
    report.status === "complete" &&
    report.alerts.some(
      (alert) =>
        !alert.disposition &&
        requireDispositionSeverities.has(normalizeSeverity(alert.severity)),
    )
  ) {
    errors.push(
      "complete reports require dispositions for all policy-severity alerts",
    );
  }
  return errors;
}

export function loadSocketReport(
  file = join(root, "socket-dispositions.json"),
) {
  return readJson(file);
}

function main() {
  const report = loadSocketReport(process.argv[2]);
  const errors = validateSocketReport(report);
  if (errors.length > 0)
    throw new Error(
      `Invalid Socket disposition report:\n- ${errors.join("\n- ")}`,
    );
  process.stdout.write(
    `Verified Socket disposition report: ${report.alerts.length} alerts, status ${report.status}.\n`,
  );
}

runScript(main, import.meta.url);
