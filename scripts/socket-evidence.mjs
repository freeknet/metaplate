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
 * Parse a Socket package URL strictly. Rejects arbitrary socket.dev paths.
 * Returns { package, version? } where the pathname explicitly identifies
 * the npm package. Returns undefined on any parse/validation failure.
 *
 * Accepted forms:
 *   https://socket.dev/npm/package/metaplate@0.6.0
 *   https://socket.dev/npm/package/metaplate/alerts/0.6.0
 */
export function parseSocketPackageUrl(source) {
  if (typeof source !== "string") return undefined;
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "socket.dev") return undefined;
  const pathMatch = /^\/npm\/package\/([^/?]+)(?:\/alerts\/([^/?]+))?/.exec(parsed.pathname);
  if (!pathMatch) return undefined;
  return { package: pathMatch[1], version: pathMatch[2] ?? undefined };
}

/**
 * Validate the source URL against the expected package/version.
 * Returns undefined on success, or an error message string on failure.
 */
export function validateSocketSource(source, expectedPackage, expectedVersion) {
  const parsed = parseSocketPackageUrl(source);
  if (!parsed) return `source URL is not a valid Socket package URL: ${source}`;
  if (parsed.package !== expectedPackage && parsed.package !== `${expectedPackage}@${expectedVersion}`) {
    return `source URL identifies package ${parsed.package}, expected ${expectedPackage}`;
  }
  if (parsed.version && parsed.version !== expectedVersion) {
    return `source URL identifies version ${parsed.version}, expected ${expectedVersion}`;
  }
  return undefined;
}

/**
 * Canonical alert identity parser. Returns { type, package, version } or
 * an error string. When both explicit package/version and example-derived
 * values exist, they must agree.
 */
export function normalizeAlertIdentity(alert) {
  const type = alert.type ?? alert.name;
  if (typeof type !== "string" || !type) return { error: "alert type/name is required" };

  const exampleId = parseExampleIdentity(alert.example);
  const explicitPkg = alert.package;
  const explicitVer = alert.version;

  let pkg;
  let ver;

  if (explicitPkg && explicitVer) {
    pkg = explicitPkg;
    ver = explicitVer;
    if (exampleId.package && exampleId.package !== pkg) {
      return { error: `example package ${exampleId.package} conflicts with explicit package ${pkg}` };
    }
    if (exampleId.version && exampleId.version !== ver) {
      return { error: `example version ${exampleId.version} conflicts with explicit version ${ver}` };
    }
  } else if (exampleId.package || explicitPkg) {
    pkg = exampleId.package ?? explicitPkg;
    ver = exampleId.version ?? explicitVer;
  }

  return { type, package: pkg, version: ver };
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
 */
export function validateUnresolvedEvidence(alert, index) {
  const ev = alert.dependencyEvidence;
  if (!ev || typeof ev !== "object") return `alert ${index}: dependencyEvidence is required`;
  if (ev.unresolved !== true) return `alert ${index}: unmatched alert must be unresolved`;
  if (ev.reachability !== "unknown") return `alert ${index}: unresolved alert reachability must be unknown`;
  if (!Array.isArray(ev.paths) || ev.paths.length !== 0) return `alert ${index}: unresolved alert must have empty paths`;
  if (typeof ev.reason !== "string" || ev.reason.length === 0) return `alert ${index}: unresolved alert must have a reason`;
  return undefined;
}

// ---- internals ----
// parseExampleIdentity is shared via dependency-model.mjs packageIdentityFromExample
const parseExampleIdentity = packageIdentityFromExample;
