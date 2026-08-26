import { URL } from "node:url";
import { packageIdentityFromExample } from "./dependency-model.mjs";

/**
 * Shared Socket evidence validation used by both the importer and the release
 * verifier. Every source of structural Socket validation flows through this
 * module so importer and verifier semantics cannot drift.
 */

export const CANONICAL_SEVERITIES = Object.freeze(["critical", "high", "medium", "low"]);

export const REACHABILITY_VALUES = Object.freeze([
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

export const VALID_DEP_EVIDENCE_SOURCES = Object.freeze(["package-lock.json"]);

export const SCORE_KEYS = Object.freeze([
  "overall",
  "supplyChain",
  "maintenance",
  "quality",
  "vulnerability",
  "license",
]);

/**
 * Validate a Socket score vector. Requires an object with all six canonical
 * score keys, each a finite number from 0 to 100. Returns an error string
 * or undefined if valid.
 */
export function validateSocketScoreVector(score, label) {
  if (!score || typeof score !== "object") return `${label} score must be an object`;
  for (const key of SCORE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(score, key)) {
      return `${label} score is missing required key ${key}`;
    }
    if (!Number.isFinite(score[key]) || score[key] < 0 || score[key] > 100) {
      return `${label} score ${key} must be a number from 0 to 100`;
    }
  }
  return undefined;
}

/**
 * Normalize severity from Socket terminology to canonical values.
 * Rejects missing, non-string, or unknown severities.
 */
export function normalizeSeverity(value) {
  if (typeof value !== "string") return undefined;
  if (value === "middle") return "medium";
  if (CANONICAL_SEVERITIES.includes(value)) return value;
  return undefined;
}

/**
 * Accepted Socket package URL pathname forms (exact match, with or without
 * trailing slash). The version segment is required for release evidence.
 * The package capture is non-greedy to prevent double-version matches.
 */
const VALID_PATHNAMES = [
  /^\/npm\/package\/([^/@]+?)@(\d+\.\d+\.\d+)\/?$/,
  /^\/npm\/package\/([^/@]+?)\/alerts\/(\d+\.\d+\.\d+)\/?$/,
];

/**
 * Parse a Socket package URL strictly. Uses `new URL()` and requires the
 * entire pathname to match an accepted form. Rejects suffix garbage,
 * credentials, non-default ports, and malformed double-version URLs.
 *
 * Returns { package, version } where both are populated, or undefined on
 * any parse/validation failure.
 *
 * Accepted forms:
 *   https://socket.dev/npm/package/metaplate@0.6.0
 *   https://socket.dev/npm/package/metaplate/alerts/0.6.0
 *   https://socket.dev/npm/package/metaplate/alerts/0.6.0?tab=dependencies
 */
export function parseSocketPackageUrl(source) {
  if (typeof source !== "string") return undefined;
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    return undefined;
  }
  // Require HTTPS, socket.dev hostname, default port, no credentials
  if (parsed.protocol !== "https:" || parsed.hostname !== "socket.dev") return undefined;
  if (parsed.username || parsed.password) return undefined;
  if (parsed.port && parsed.port !== "443") return undefined;

  for (const pattern of VALID_PATHNAMES) {
    const match = pattern.exec(parsed.pathname);
    if (match) return { package: match[1], version: match[2] };
  }
  return undefined;
}

/**
 * Validate the source URL against the expected package/version.
 * Requires the URL to encode the version (versionless URLs are rejected
 * for release evidence). The parsed package must exactly match the expected
 * package (no legacy @version suffix encoding).
 * Returns undefined on success, or an error message string on failure.
 */
export function validateSocketSource(source, expectedPackage, expectedVersion) {
  const parsed = parseSocketPackageUrl(source);
  if (!parsed) return `source URL is not a valid Socket package URL: ${source}`;
  if (parsed.package !== expectedPackage) {
    return `source URL identifies package ${parsed.package}, expected ${expectedPackage}`;
  }
  if (!parsed.version) {
    return `source URL does not encode a version; expected ${expectedVersion}`;
  }
  if (parsed.version !== expectedVersion) {
    return `source URL identifies version ${parsed.version}, expected ${expectedVersion}`;
  }
  return undefined;
}

/**
 * Canonical alert identity parser. Returns { type, package, version } or
 * an error string.
 *
 * Validates each explicit field independently against the example-derived
 * values. Partial conflicts are rejected. Both name and type are treated
 * as aliases for the same canonical field and must agree when both present.
 */
export function normalizeAlertIdentity(alert) {
  const name = alert.name;
  const type = alert.type;
  const canonicalType = type ?? name;
  if (typeof canonicalType !== "string" || !canonicalType) return { error: "alert type/name is required" };
  if (name !== undefined && type !== undefined && name !== type) {
    return { error: `alert name ${JSON.stringify(name)} conflicts with type ${JSON.stringify(type)}` };
  }

  const exampleId = parseExampleIdentity(alert.example);

  // Validate each explicit field independently against example
  if (alert.package !== undefined) {
    if (typeof alert.package !== "string" || !alert.package) {
      return { error: "alert package must be a non-empty string" };
    }
    if (exampleId.package && exampleId.package !== alert.package) {
      return { error: `example package ${exampleId.package} conflicts with explicit package ${alert.package}` };
    }
  }
  if (alert.version !== undefined) {
    if (typeof alert.version !== "string" || !alert.version) {
      return { error: "alert version must be a non-empty string" };
    }
    if (exampleId.version && exampleId.version !== alert.version) {
      return { error: `example version ${exampleId.version} conflicts with explicit version ${alert.version}` };
    }
  }

  const pkg = alert.package ?? exampleId.package;
  const ver = alert.version ?? exampleId.version;

  return { type: canonicalType, package: pkg, version: ver };
}

/**
 * Validate the full alert schema for a score artifact alert.
 * Returns an error string or undefined if valid.
 */
export function validateScoreAlert(alert, index) {
  if (!alert || typeof alert !== "object") return `alert ${index}: must be an object`;
  const identity = normalizeAlertIdentity(alert);
  if (identity.error) return `alert ${index}: ${identity.error}`;
  const sev = normalizeSeverity(alert.severity);
  if (!sev) return `alert ${index}: invalid or missing severity ${JSON.stringify(alert.severity)}`;
  return undefined;
}

/**
 * Validate the dependencyEvidence shape for a resolved (matched) alert.
 */
export function validateResolvedEvidence(alert, index) {
  const ev = alert.dependencyEvidence;
  if (!ev || typeof ev !== "object") return `alert ${index}: dependencyEvidence is required`;
  if (!VALID_DEP_EVIDENCE_SOURCES.includes(ev.source)) return `alert ${index}: dependencyEvidence.source must be package-lock.json`;
  if (!Array.isArray(ev.paths)) return `alert ${index}: dependencyEvidence.paths must be an array`;
  if (typeof ev.reachability !== "string" || !REACHABILITY_VALUES.includes(ev.reachability)) {
    return `alert ${index}: dependencyEvidence.reachability is not valid`;
  }
  if (ev.unresolved === true) return `alert ${index}: resolved alert must not be unresolved`;
  return undefined;
}

/**
 * Validate the dependencyEvidence shape for an unresolved (unmatched) alert.
 * Requires the same source as resolved evidence.
 */
export function validateUnresolvedEvidence(alert, index) {
  const ev = alert.dependencyEvidence;
  if (!ev || typeof ev !== "object") return `alert ${index}: dependencyEvidence is required`;
  if (!VALID_DEP_EVIDENCE_SOURCES.includes(ev.source)) return `alert ${index}: dependencyEvidence.source must be package-lock.json`;
  if (ev.unresolved !== true) return `alert ${index}: unmatched alert must be unresolved`;
  if (ev.reachability !== "unknown") return `alert ${index}: unresolved alert reachability must be unknown`;
  if (!Array.isArray(ev.paths) || ev.paths.length !== 0) return `alert ${index}: unresolved alert must have empty paths`;
  if (typeof ev.reason !== "string" || ev.reason.length === 0) return `alert ${index}: unresolved alert must have a reason`;
  return undefined;
}

// ---- internals ----
// parseExampleIdentity is shared via dependency-model.mjs packageIdentityFromExample
const parseExampleIdentity = packageIdentityFromExample;
