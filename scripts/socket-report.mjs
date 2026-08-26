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
} from "./socket-evidence.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = process.argv[2] ?? "socket-score-report.json";
const input = process.argv[3] ?? process.env.SOCKET_REPORT_INPUT;
const SCORE_KEYS = [
  "overall",
  "supplyChain",
  "maintenance",
  "quality",
  "vulnerability",
  "license",
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function assertScore(score, label) {
  if (!score || typeof score !== "object") throw new Error(`${label} score must be an object`);
  for (const key of SCORE_KEYS) {
    if (!Number.isFinite(score[key]) || score[key] < 0 || score[key] > 100) {
      throw new Error(`${label} score ${key} must be a number from 0 to 100`);
    }
  }
  return Object.fromEntries(SCORE_KEYS.map((key) => [key, score[key]]));
}

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

    const enriched = {
      ...alert,
      name: identity.type,
      type: identity.type,
      severity,
      scope,
      ...(packageName ? { package: packageName } : {}),
      ...(version ? { version } : {}),
      ...(matches.length > 0
        ? {
            dependencyEvidence: {
              source: "package-lock.json",
              paths,
              reachability: reachability ?? "unknown",
            },
          }
        : {
            dependencyEvidence: {
              source: "package-lock.json",
              paths: [],
              reachability: "unknown",
              unresolved: true,
              reason: packageName
                ? `${packageName}@${version} not found in the current dependency inventory`
                : "no package identity available",
            },
          }),
    };
    if (paths.length > 0 && !enriched.dependencyPath) {
      enriched.dependencyPath = paths[0];
    }
    if (matches.length === 0 && ["high", "critical"].includes(severity)) {
      throw new Error(
        `${scope} alert ${index} could not be resolved in package-lock.json`,
      );
    }
    return enriched;
  });
}

function extractEnvelope(report) {
  const data = report.data ?? report;
  // Detect the official Socket CLI envelope shape
  if (data.self && typeof data.self === "object") {
    return { shape: "official-envelope", data };
  }
  // Detect a normalized shape (from a previous import pass)
  if (report.schemaVersion === 2 && report.shallow && report.deep) {
    return { shape: "normalized", data: report };
  }
  return { shape: "raw", data };
}

function normalize(report, inputSha256) {
  if (!report || typeof report !== "object") throw new Error("Socket report must be a JSON object");

  const { shape, data } = extractEnvelope(report);

  // Reject non-empty top-level alerts in the raw input.
  // The official Socket CLI uses data.self.alerts and data.transitively.alerts.
  // A top-level alerts array is ambiguous and must not be silently accepted.
  if (shape === "raw" && Array.isArray(data.alerts) && data.alerts.length > 0) {
    throw new Error(
      "Top-level alerts array is not a supported import schema. " +
        "Use the official Socket CLI envelope with data.self.alerts / data.transitively.alerts.",
    );
  }

  const purl = data.purl ?? data.self?.purl?.replace(/^npm\//, "pkg:npm/");
  const packageMatch =
    typeof purl === "string" &&
    /^pkg:npm\/metaplate@(\d+\.\d+\.\d+)/.exec(purl);
  const source = report.source ?? (
    typeof purl === "string"
      ? `https://socket.dev/npm/package/${purl.replace(/^pkg:npm\//, "")}`
      : undefined
  );
  const version =
    report.version ??
    data.version ??
    packageMatch?.[1] ??
    source?.match(/\/alerts\/(\d+\.\d+\.\d+)/)?.[1];

  if (version !== "0.6.0") {
    throw new Error("This baseline importer only accepts metaplate@0.6.0 reports");
  }

  // Strict source validation
  const sourceError = validateSocketSource(source, "metaplate", version);
  if (sourceError) throw new Error(sourceError);

  if (purl && purl !== `pkg:npm/metaplate@${version}`) {
    throw new Error("Socket report package must be metaplate");
  }

  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const inventory = classifyLockPackages({ root, manifest, lockfile });

  const shallowScore = assertScore(
    data.self?.score ?? report.shallow?.score ?? report.shallow,
    "shallow",
  );
  const deepScore = assertScore(
    data.transitively?.score ?? report.deep?.score ?? report.deep,
    "deep",
  );

  // Alerts come ONLY from the official envelope or normalized scope fields.
  const shallowAlerts = assertAlerts(
    data.self?.alerts ?? (shape === "normalized" ? data.shallow?.alerts ?? [] : []),
    "shallow",
    inventory,
  );
  const deepAlerts = assertAlerts(
    data.transitively?.alerts ?? (shape === "normalized" ? data.deep?.alerts ?? [] : []),
    "deep",
    inventory,
  );

  const deep = data.transitively ?? (shape === "normalized" ? data.deep : {}) ?? {};

  return {
    schemaVersion: 2,
    package: "metaplate",
    version,
    source,
    capturedAt: report.capturedAt ?? new Date().toISOString(),
    captureKind: shape === "normalized" ? "historical-normalized-snapshot" : "socket-cli-import",
    shallow: { score: shallowScore, alerts: shallowAlerts },
    deep: {
      score: deepScore,
      dependencyCount: deep.dependencyCount ?? null,
      capabilities: deep.capabilities ?? [],
      lowest: deep.lowest ?? null,
      alerts: deepAlerts,
    },
    provenance: {
      importedFrom: "Socket CLI export",
      inputSha256: shape === "normalized" ? (report.provenance?.inputSha256 ?? null) : inputSha256,
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
