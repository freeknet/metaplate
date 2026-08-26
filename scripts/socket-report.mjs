import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { fileURLToPath, URL } from "node:url";
import {
  classifyLockPackages,
  strongestReachability,
} from "./dependency-model.mjs";
import {
  normalizeSeverity,
  validateSocketSource,
  normalizeAlertIdentity,
  validateSocketScoreVector,
} from "./socket-evidence.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = process.argv[2] ?? "socket-score-report.json";
const input = process.argv[3] ?? process.env.SOCKET_REPORT_INPUT;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

/**
 * Assert a Socket score vector using the shared validator.
 * Returns a frozen copy of the validated score object.
 */
function assertScore(score, label) {
  const error = validateSocketScoreVector(score, label);
  if (error) throw new Error(error);
  return Object.freeze(Object.fromEntries(
    ["overall", "supplyChain", "maintenance", "quality", "vulnerability", "license"]
      .map((key) => [key, score[key]]),
  ));
}

/**
 * Validate the auxiliary deep-dependency fields: dependencyCount, capabilities, lowest.
 * Malformed supplied values cause import failure rather than silent coercion.
 */
function validateDeepAuxiliary(data, errors) {
  const deep = data.transitively;

  // dependencyCount: absent -> null, present -> non-negative integer
  if (deep.dependencyCount !== undefined && deep.dependencyCount !== null) {
    if (typeof deep.dependencyCount !== "number" || !Number.isInteger(deep.dependencyCount) || deep.dependencyCount < 0) {
      errors.push("transitively.dependencyCount must be a non-negative integer when present");
    }
  }

  // capabilities: absent -> [], present -> array of non-empty strings
  if (deep.capabilities !== undefined && deep.capabilities !== null) {
    if (!Array.isArray(deep.capabilities)) {
      errors.push("transitively.capabilities must be an array when present");
    } else {
      for (let i = 0; i < deep.capabilities.length; i++) {
        if (typeof deep.capabilities[i] !== "string" || !deep.capabilities[i]) {
          errors.push(`transitively.capabilities[${i}] must be a non-empty string`);
        }
      }
    }
  }

  // lowest: absent -> null, present -> plain object with string values
  if (deep.lowest !== undefined && deep.lowest !== null) {
    if (typeof deep.lowest !== "object" || Array.isArray(deep.lowest)) {
      errors.push("transitively.lowest must be a plain object when present");
    } else {
      for (const [key, value] of Object.entries(deep.lowest)) {
        if (typeof value !== "string" || !value) {
          errors.push(`transitively.lowest.${key} must be a non-empty string`);
        }
      }
    }
  }
}

/**
 * Normalize alerts from the official envelope. Only copies Socket-originated
 * fields; all locally-derived fields are constructed from canonical parsing
 * and dependency inventory, never preserved from raw input.
 */
function assertAlerts(alerts, scope, inventory) {
  if (!Array.isArray(alerts)) throw new Error(`${scope} alerts must be an array`);
  return alerts.map((alert, index) => {
    const identity = normalizeAlertIdentity(alert);
    if (identity.error) throw new Error(`${scope} alert ${index}: ${identity.error}`);

    const severity = normalizeSeverity(alert.severity);
    if (!severity) {
      throw new Error(`${scope} alert ${index}: invalid or missing severity ${JSON.stringify(alert.severity)}`);
    }

    const packageName = identity.package;
    const version = identity.version;
    const matches =
      packageName && version
        ? inventory.filter(
            (entry) => entry.name === packageName && entry.version === version,
          )
        : [];
    const paths = [
      ...new Set(matches.flatMap((entry) => entry.dependencyPaths ?? [])),
    ].sort();
    const reachability = strongestReachability(
      matches.map((entry) => entry.classification),
    );

    // Build output from scratch: copy only trusted Socket-originated fields,
    // then construct all locally-derived fields.
    const socketFields = {};
    for (const key of ["category", "example", "gptAnomaly"]) {
      if (alert[key] !== undefined) socketFields[key] = alert[key];
    }

    const output = {
      ...socketFields,
      name: identity.type,
      type: identity.type,
      severity,
      scope,
      ...(packageName ? { package: packageName } : {}),
      ...(version ? { version } : {}),
    };

    if (matches.length > 0) {
      output.dependencyEvidence = {
        source: "package-lock.json",
        paths,
        reachability: reachability ?? "unknown",
      };
      output.dependencyPath = paths[0];
    } else {
      output.dependencyEvidence = {
        source: "package-lock.json",
        paths: [],
        reachability: "unknown",
        unresolved: true,
        reason: packageName
          ? `${packageName}@${version} not found in the current dependency inventory`
          : "no package identity available",
      };
    }

    if (matches.length === 0 && ["high", "critical"].includes(severity)) {
      throw new Error(
        `${scope} alert ${index} could not be resolved in package-lock.json`,
      );
    }
    return output;
  });
}

/**
 * Validate capturedAt is a valid ISO-8601 timestamp string.
 */
function validateCapturedAt(value) {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    throw new Error("capturedAt must be a string when present");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`capturedAt is not a valid ISO-8601 timestamp: ${value}`);
  }
}

/**
 * Detect and validate the official Socket CLI envelope.
 * Only the official envelope is accepted for socket-cli-import.
 * Normalized (schemaVersion 2) artifacts are rejected — the importer
 * is only for converting raw CLI exports, not reprocessing imports.
 */
function extractOfficialEnvelope(report) {
  if (!report || typeof report !== "object") return undefined;

  // Reject normalized reimport: schemaVersion 2 means already imported
  if (report.schemaVersion === 2) {
    throw new Error(
      "Input is already a normalized score artifact (schemaVersion 2). " +
        "The importer accepts only raw official Socket CLI exports.",
    );
  }

  // Require report.data — no top-level self/transitively fallback
  if (!report.data || typeof report.data !== "object") return undefined;

  const data = report.data;

  // Require the official Socket CLI envelope: data.purl, data.self with score,
  // data.transitively with score
  if (typeof data.purl !== "string" || !data.purl) return undefined;
  if (!data.self || typeof data.self !== "object") return undefined;
  if (!data.self.score || typeof data.self.score !== "object") return undefined;
  if (!data.transitively || typeof data.transitively !== "object") return undefined;
  if (!data.transitively.score || typeof data.transitively.score !== "object") return undefined;

  return { shape: "official-envelope", data };
}

/**
 * Parse and cross-validate all package/version claims from the envelope.
 * Every supplied identity field must agree. No single field is authoritative
 * enough to override contradictory metadata.
 */
function validateEnvelopeIdentity(data, report) {
  const claims = [];
  const errors = [];

  // data.purl is mandatory (already validated as string by extractOfficialEnvelope)
  const purlMatch = /^pkg:npm\/([^@]+)@(\d+\.\d+\.\d+)$/.exec(data.purl);
  if (!purlMatch) {
    return { pkg: undefined, version: undefined, errors: ["data.purl must be a valid PURL of the form pkg:npm/<package>@<version>"] };
  }
  claims.push({ field: "data.purl", pkg: purlMatch[1], version: purlMatch[2] });

  // data.self.purl if present must be a string and must agree
  if (data.self?.purl !== undefined) {
    if (typeof data.self.purl !== "string") {
      throw new Error(`data.self.purl must be a string when present, got ${typeof data.self.purl}`);
    }
    const selfPurlMatch = /^(?:(?:pkg:npm|npm)\/)?([^/@]+)@(\d+\.\d+\.\d+)$/.exec(data.self.purl);
    if (selfPurlMatch) {
      claims.push({ field: "data.self.purl", pkg: selfPurlMatch[1], version: selfPurlMatch[2] });
    } else {
      errors.push("data.self.purl is malformed");
    }
  }

  // report.version if present must be a string and must agree
  if (report.version !== undefined) {
    if (typeof report.version !== "string") {
      throw new Error(`report.version must be a string when present, got ${typeof report.version}`);
    }
    claims.push({ field: "report.version", pkg: undefined, version: report.version });
  }

  // data.version if present must be a string and must agree
  if (data.version !== undefined) {
    if (typeof data.version !== "string") {
      throw new Error(`data.version must be a string when present, got ${typeof data.version}`);
    }
    claims.push({ field: "data.version", pkg: undefined, version: data.version });
  }

  // All version claims must agree
  const versions = claims.filter((c) => c.version).map((c) => c.version);
  const uniqueVersions = [...new Set(versions)];
  if (uniqueVersions.length > 1) {
    errors.push(`conflicting version claims: ${claims.filter((c) => c.version).map((c) => `${c.field}=${c.version}`).join(", ")}`);
  }

  // All package claims must agree
  const packages = claims.filter((c) => c.pkg).map((c) => c.pkg);
  const uniquePackages = [...new Set(packages)];
  if (uniquePackages.length > 1) {
    errors.push(`conflicting package claims: ${claims.filter((c) => c.pkg).map((c) => `${c.field}=${c.pkg}`).join(", ")}`);
  }

  const pkg = uniquePackages[0] ?? "metaplate";
  const version = uniqueVersions[0];

  return { pkg, version, errors };
}

function normalize(report, inputSha256) {
  if (!report || typeof report !== "object") throw new Error("Socket report must be a JSON object");

  const envelope = extractOfficialEnvelope(report);
  if (!envelope) {
    throw new Error(
      "Input is not a recognized Socket CLI export. " +
        "Expected the official Socket CLI envelope with report.data containing data.purl, data.self, and data.transitively. " +
        "Hand-authored score JSON is not accepted as a CLI import.",
    );
  }

  const { data } = envelope;

  // Reject unsupported alert containers by presence, not just non-empty arrays.
  // The only legal alert locations are data.self.alerts and data.transitively.alerts.
  for (const field of ["alerts"]) {
    if (Object.hasOwn(report, field)) {
      throw new Error(
        `report.${field} is not a supported field on a raw CLI export. ` +
          "Use the official Socket CLI envelope with data.self.alerts / data.transitively.alerts.",
      );
    }
    if (Object.hasOwn(data, field)) {
      throw new Error(
        `data.${field} is not a supported field on a raw CLI export. ` +
          "Use the official Socket CLI envelope with data.self.alerts / data.transitively.alerts.",
      );
    }
  }
  // report.shallow and report.deep are normalized-artifact fields.
  // They must not appear on raw CLI input.
  for (const field of ["shallow", "deep"]) {
    if (Object.hasOwn(report, field)) {
      throw new Error(
        `report.${field} is not a valid field on a raw CLI export. ` +
          "Use the official Socket CLI envelope with data.self / data.transitively.",
      );
    }
  }

  // Cross-validate all package/version claims
  const identity = validateEnvelopeIdentity(data, report);
  if (identity.errors.length > 0) {
    throw new Error(`Identity validation failed: ${identity.errors.join("; ")}`);
  }
  const { version } = identity;

  if (version !== "0.6.0") {
    throw new Error("This baseline importer only accepts metaplate@0.6.0 reports");
  }

  if (identity.pkg !== "metaplate") {
    throw new Error("Socket report package must be metaplate");
  }

  // Validate report.source if present, then preserve the actual validated URL
  if (report.source !== undefined) {
    if (typeof report.source !== "string") {
      throw new Error(`report.source must be a string when present, got ${typeof report.source}`);
    }
    const sourceError = validateSocketSource(report.source, identity.pkg, version);
    if (sourceError) throw new Error(sourceError);
  }
  const canonicalSource = `https://socket.dev/npm/package/metaplate@${version}`;
  const source = report.source ?? canonicalSource;

  // Validate capturedAt if present
  validateCapturedAt(report.capturedAt);

  // Validate auxiliary deep fields
  const validationErrors = [];
  validateDeepAuxiliary(data, validationErrors);
  if (validationErrors.length > 0) {
    throw new Error(`Socket envelope validation failed: ${validationErrors.join("; ")}`);
  }

  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const inventory = classifyLockPackages({ root, manifest, lockfile });

  const shallowScore = assertScore(data.self.score, "shallow");
  const deepScore = assertScore(data.transitively.score, "deep");

  // Alerts come ONLY from data.self.alerts and data.transitively.alerts
  const shallowAlerts = assertAlerts(data.self.alerts ?? [], "shallow", inventory);
  const deepAlerts = assertAlerts(data.transitively.alerts ?? [], "deep", inventory);

  return {
    schemaVersion: 2,
    package: "metaplate",
    version,
    source,
    capturedAt: report.capturedAt ?? new Date().toISOString(),
    captureKind: "socket-cli-import",
    shallow: { score: shallowScore, alerts: shallowAlerts },
    deep: {
      score: deepScore,
      dependencyCount: data.transitively.dependencyCount ?? null,
      capabilities: data.transitively.capabilities ?? [],
      lowest: data.transitively.lowest ?? null,
      alerts: deepAlerts,
    },
    provenance: {
      importedFrom: "Socket CLI export",
      inputSha256,
      dependencyEvidence: "package-lock.json via dependency-model.mjs",
    },
  };
}

if (!input) {
  fail(
    "Socket report input is required. Set SOCKET_REPORT_INPUT or pass: " +
      "node scripts/socket-report.mjs OUTPUT INPUT.json",
  );
} else {
  try {
    const inputBytes = readFileSync(resolve(input));
    const inputSha256 = createHash("sha256")
      .update(inputBytes)
      .digest("hex");
    const text =
      inputBytes[0] === 0xff && inputBytes[1] === 0xfe
        ? new TextDecoder("utf-16le").decode(inputBytes)
        : inputBytes.toString("utf8");
    const report = normalize(
      JSON.parse(text.replace(/^\uFEFF/, "")),
      inputSha256,
    );
    writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      `Imported Socket report for ${report.package}@${report.version}: ${output}\n`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
