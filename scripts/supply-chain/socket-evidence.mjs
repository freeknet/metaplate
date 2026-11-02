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
 * Strict ISO-8601 subset used by release evidence: date-only (YYYY-MM-DD) or a
 * full timestamp with seconds and an explicit Z / ±hh:mm zone designator.
 * Validation is both lexical and semantic so impossible calendar/time values
 * are rejected rather than merely matching the shape.
 */
const ISO_8601_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2})))?$/;

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isIso8601Timestamp(value) {
  if (typeof value !== "string") return false;
  const match = ISO_8601_TIMESTAMP.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;

  const hourText = match[4];
  if (hourText === undefined) return true;

  const hour = Number(hourText);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;

  const zone = match[8];
  if (zone !== "Z") {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour < 0 || offsetHour > 23) return false;
    if (offsetMinute < 0 || offsetMinute > 59) return false;
  }

  return true;
}

export function isFullIso8601Timestamp(value) {
  return isIso8601Timestamp(value) && value.includes("T");
}

/**
 * The pinned executable release policy. This is the single source of truth
 * for what the verifier enforces. The releasePolicy in socket-dispositions.json
 * must match this exactly — it cannot weaken or extend the policy.
 */
export const SOCKET_RELEASE_POLICY = Object.freeze({
  blockSeverities: Object.freeze(["critical"]),
  requireDispositionSeverities: Object.freeze(["high", "critical"]),
  allowedDispositionTypes: Object.freeze([
    "upgrade",
    "replace",
    "remove",
    "isolate",
    "accepted-with-evidence",
  ]),
  acceptedExceptionRequires: Object.freeze([
    "owner",
    "reason",
    "expiry",
    "verification",
  ]),
});

/**
 * Validate that two string arrays are exactly equal as sets (same elements,
 * no extras, no missing, no duplicates).
 */
function validateExactStringSet(actual, expected, fieldName) {
  if (!Array.isArray(actual)) return `${fieldName} must be an array`;
  if (actual.some((value) => typeof value !== "string" || !value.trim())) {
    return `${fieldName} must contain only non-empty strings`;
  }

  const sorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (sorted.length !== expectedSorted.length) {
    return `${fieldName} has ${sorted.length} entries, expected ${expectedSorted.length}`;
  }
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== expectedSorted[i]) {
      return `${fieldName} entry ${sorted[i]} is not in the expected set`;
    }
  }
  const unique = new Set(actual);
  if (unique.size !== actual.length) {
    return `${fieldName} contains duplicate entries`;
  }
  return undefined;
}

/**
 * Validate that a disposition report's releasePolicy matches the pinned
 * executable policy exactly. Returns an array of error strings and never
 * throws for malformed JSON field types.
 */
export function validateReleasePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return ["releasePolicy is missing"];
  }
  const errors = [];
  let err;
  err = validateExactStringSet(
    policy.blockSeverities,
    SOCKET_RELEASE_POLICY.blockSeverities,
    "blockSeverities",
  );
  if (err) errors.push(err);
  err = validateExactStringSet(
    policy.requireDispositionSeverities,
    SOCKET_RELEASE_POLICY.requireDispositionSeverities,
    "requireDispositionSeverities",
  );
  if (err) errors.push(err);
  err = validateExactStringSet(
    policy.allowedDispositionTypes,
    SOCKET_RELEASE_POLICY.allowedDispositionTypes,
    "allowedDispositionTypes",
  );
  if (err) errors.push(err);
  err = validateExactStringSet(
    policy.acceptedExceptionRequires,
    SOCKET_RELEASE_POLICY.acceptedExceptionRequires,
    "acceptedExceptionRequires",
  );
  if (err) errors.push(err);
  return errors;
}

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
 * For raw CLI input: "middle" -> "medium" is valid.
 * For normalized artifacts, use validateCanonicalSeverity instead.
 */
export function normalizeSeverity(value) {
  if (typeof value !== "string") return undefined;
  if (value === "middle") return "medium";
  if (CANONICAL_SEVERITIES.includes(value)) return value;
  return undefined;
}

/**
 * Validate that severity is one of the canonical normalized values.
 * Does NOT accept "middle" — use this for schemaVersion 2 artifacts.
 */
export function validateCanonicalSeverity(value) {
  if (typeof value !== "string") return `severity must be a string`;
  if (!CANONICAL_SEVERITIES.includes(value)) {
    return `severity "${value}" is not a canonical value; expected one of: ${CANONICAL_SEVERITIES.join(", ")}`;
  }
  return undefined;
}

/**
 * Validate the auxiliary deep-dependency fields: dependencyCount, capabilities, lowest.
 * Used by both the importer and the verifier.
 * Returns an array of error strings (empty if valid).
 */
export function validateDeepAuxiliary(deep, label) {
  const errors = [];
  if (!deep || typeof deep !== "object") return [`${label} deep must be an object`];

  if (deep.dependencyCount !== undefined && deep.dependencyCount !== null) {
    if (typeof deep.dependencyCount !== "number" || !Number.isInteger(deep.dependencyCount) || deep.dependencyCount < 0) {
      errors.push(`${label}.dependencyCount must be a non-negative integer when present`);
    }
  }

  if (deep.capabilities !== undefined && deep.capabilities !== null) {
    if (!Array.isArray(deep.capabilities)) {
      errors.push(`${label}.capabilities must be an array when present`);
    } else {
      for (let i = 0; i < deep.capabilities.length; i++) {
        if (typeof deep.capabilities[i] !== "string" || !deep.capabilities[i].trim()) {
          errors.push(`${label}.capabilities[${i}] must be a non-empty string`);
        }
      }
      if (new Set(deep.capabilities).size !== deep.capabilities.length) {
        errors.push(`${label}.capabilities must not contain duplicate entries`);
      }
    }
  }

  // Socket may supply only the score dimensions for which it has a lowest
  // package. Any supplied entries must use canonical score keys and package
  // identities, but the object is intentionally allowed to be partial.
  if (deep.lowest !== undefined && deep.lowest !== null) {
    if (typeof deep.lowest !== "object" || Array.isArray(deep.lowest)) {
      errors.push(`${label}.lowest must be a plain object when present`);
    } else {
      for (const [key, value] of Object.entries(deep.lowest)) {
        if (!SCORE_KEYS.includes(key)) {
          errors.push(`${label}.lowest contains unexpected key ${key}`);
          continue;
        }
        if (typeof value !== "string" || !value.trim()) {
          errors.push(`${label}.lowest.${key} must be a non-empty string`);
          continue;
        }
        const identity = packageIdentityFromExample(value);
        if (!identity.package || !identity.version) {
          errors.push(`${label}.lowest.${key} must be a Socket package identity`);
        }
      }
    }
  }

  return errors;
}

/**
 * Validate that a capturedAt value is a valid ISO-8601 date or timestamp.
 */
export function validateCapturedAt(value, fieldName = "capturedAt") {
  if (value === undefined || value === null) return undefined;
  if (!isIso8601Timestamp(value)) {
    return `${fieldName} must be a valid ISO-8601 timestamp when present`;
  }
  return undefined;
}

/**
 * normalizedAt is importer-generated and therefore must always be a full,
 * offset-aware timestamp rather than a date-only value.
 */
export function validateNormalizedAt(value, fieldName = "normalizedAt") {
  if (!isFullIso8601Timestamp(value)) {
    return `${fieldName} must be a full ISO-8601 timestamp`;
  }
  return undefined;
}

/**
 * Validate packageSizeBytes if present.
 */
export function validatePackageSizeBytes(value, fieldName = "packageSizeBytes") {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return `${fieldName} must be a non-negative integer when present`;
  }
  return undefined;
}

/**
 * Validate the basic schema of a disposition alert entry.
 * Requires all identity and metadata fields to be present non-empty strings.
 * Only allows high/critical severity in disposition reports.
 */
export function validateDispositionAlert(alert, index) {
  const prefix = `alert ${index}`;
  if (!alert || typeof alert !== "object") return `${prefix}: must be an object`;

  const requiredStrings = ["type", "package", "version", "path", "reachability", "evidence", "verification"];
  for (const field of requiredStrings) {
    if (typeof alert[field] !== "string" || !alert[field].trim()) {
      return `${prefix}: ${field} must be a non-empty string`;
    }
  }

  const sevErr = validateCanonicalSeverity(alert.severity);
  if (sevErr) return `${prefix}: ${sevErr}`;

  const allowed = SOCKET_RELEASE_POLICY.allowedDispositionTypes;
  if (alert.disposition && !allowed.includes(alert.disposition)) {
    return `${prefix}: disposition "${alert.disposition}" is not a recognized value`;
  }

  if (!REACHABILITY_VALUES.includes(alert.reachability)) {
    return `${prefix}: reachability "${alert.reachability}" is not a recognized value`;
  }

  if (!SOCKET_RELEASE_POLICY.requireDispositionSeverities.includes(alert.severity)) {
    return `${prefix}: disposition reports should only contain high/critical alerts, got "${alert.severity}"`;
  }

  return undefined;
}

// Accepted Socket package URL pathname forms
const VALID_PATHNAMES = [
  /^\/npm\/package\/([^/@]+?)@(\d+\.\d+\.\d+)\/?$/,
  /^\/npm\/package\/([^/@]+?)\/alerts\/(\d+\.\d+\.\d+)\/?$/,
];

/**
 * Parse a Socket package URL strictly.
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
  if (parsed.username || parsed.password) return undefined;
  if (parsed.port && parsed.port !== "443") return undefined;

  for (const pattern of VALID_PATHNAMES) {
    const match = pattern.exec(parsed.pathname);
    if (match) return { package: match[1], version: match[2] };
  }
  return undefined;
}

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

export function normalizeAlertIdentity(alert) {
  const name = alert.name;
  const type = alert.type;
  const canonicalType = type ?? name;
  if (typeof canonicalType !== "string" || !canonicalType) return { error: "alert type/name is required" };
  if (name !== undefined && type !== undefined && name !== type) {
    return { error: `alert name ${JSON.stringify(name)} conflicts with type ${JSON.stringify(type)}` };
  }

  const exampleId = parseExampleIdentity(alert.example);

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
 * Validate the full alert schema for a schemaVersion 2 score artifact alert.
 * Legacy duplicate fields deliberately removed from the canonical normalized
 * representation are rejected even when their values happen to agree.
 */
export function validateScoreAlert(alert, index) {
  if (!alert || typeof alert !== "object") return `alert ${index}: must be an object`;
  for (const field of ["type", "scope", "reachability", "lockfilePath"]) {
    if (Object.hasOwn(alert, field)) {
      return `alert ${index}: legacy field ${field} is not allowed in schemaVersion 2 score alerts`;
    }
  }
  const identity = normalizeAlertIdentity(alert);
  if (identity.error) return `alert ${index}: ${identity.error}`;
  const sevErr = validateCanonicalSeverity(alert.severity);
  if (sevErr) return `alert ${index}: ${sevErr}`;
  return undefined;
}

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

export function validateUnresolvedEvidence(alert, index) {
  const ev = alert.dependencyEvidence;
  if (!ev || typeof ev !== "object") return `alert ${index}: dependencyEvidence is required`;
  if (!VALID_DEP_EVIDENCE_SOURCES.includes(ev.source)) return `alert ${index}: dependencyEvidence.source must be package-lock.json`;
  if (ev.unresolved !== true) return `alert ${index}: unmatched alert must be unresolved`;
  if (ev.reachability !== "unknown") return `alert ${index}: unresolved alert reachability must be unknown`;
  if (!Array.isArray(ev.paths) || ev.paths.length !== 0) return `alert ${index}: unresolved alert must have empty paths`;
  if (typeof ev.reason !== "string" || !ev.reason.trim()) return `alert ${index}: unresolved alert must have a reason`;
  return undefined;
}

// ---- internals ----
const parseExampleIdentity = packageIdentityFromExample;