import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { fileURLToPath, URL } from "node:url";
import { classifyLockPackages, packageIdentityFromExample, strongestReachability } from "./dependency-model.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = process.argv[2] ?? "socket-score-report.json";
const input = process.argv[3] ?? process.env.SOCKET_REPORT_INPUT;
const SCORE_KEYS = ["overall", "supplyChain", "maintenance", "quality", "vulnerability", "license"];

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

function assertAlerts(alerts, label, inventory) {
  if (!Array.isArray(alerts)) throw new Error(`${label} alerts must be an array`);
  return alerts.map((alert, index) => {
    if (!alert || typeof alert !== "object" || typeof (alert.name ?? alert.type) !== "string") {
      throw new Error(`${label} alerts must contain alert names`);
    }
    const identity = packageIdentityFromExample(alert.example);
    const packageName = alert.package ?? identity.package;
    const version = alert.version ?? identity.version;
    const matches = packageName && version
      ? inventory.filter((entry) => entry.name === packageName && entry.version === version)
      : [];
    const paths = [...new Set(matches.flatMap((entry) => entry.dependencyPaths ?? []))].sort();
    const reachability = strongestReachability(matches.map((entry) => entry.classification));
    const enriched = {
      ...alert,
      scope: label,
      ...(packageName ? { package: packageName } : {}),
      ...(version ? { version } : {}),
      ...(matches.length > 0 ? {
        dependencyEvidence: {
          source: "package-lock.json",
          paths,
          reachability: reachability ?? "unknown",
        },
      } : {
        dependencyEvidence: {
          source: "package-lock.json",
          paths: [],
          reachability: "unknown",
          unresolved: true,
        },
      }),
    };
    if (paths.length > 0 && !enriched.dependencyPath) enriched.dependencyPath = paths[0];
    if (matches.length === 0 && ["high", "critical"].includes(alert.severity)) {
      throw new Error(`${label} alert ${index} could not be resolved in package-lock.json`);
    }
    return enriched;
  });
}

function assertSourceConsistency(source, purl, version) {
  if (typeof source !== "string" || !source.startsWith("https://socket.dev/")) {
    throw new Error("Socket report requires an official https://socket.dev/ source");
  }
  const purlMatch = typeof purl === "string" && /^pkg:npm\/([^@]+)@([^?]+)$/.exec(purl);
  const sourceMatch = /\/npm\/package\/([^/?#]+)(?:\/alerts\/([^/?#]+))?/.exec(source);
  if (purlMatch && (purlMatch[1] !== "metaplate" || purlMatch[2] !== version)) {
    throw new Error("Socket report PURL must identify metaplate at the baseline version");
  }
  if (sourceMatch && (sourceMatch[1] !== "metaplate" && sourceMatch[1] !== `metaplate@${version}` || sourceMatch[2] && sourceMatch[2] !== version)) {
    throw new Error("Socket report source URL does not identify metaplate at the baseline version");
  }
}

function normalize(report, inputSha256) {
  if (!report || typeof report !== "object") throw new Error("Socket report must be a JSON object");
  const data = report.data ?? report;
  const purl = data.purl ?? data.self?.purl?.replace(/^npm\//, "pkg:npm/");
  const packageMatch = typeof purl === "string" && /^pkg:npm\/metaplate@(\d+\.\d+\.\d+)/.exec(purl);
  const source = report.source ?? (
    typeof purl === "string"
      ? `https://socket.dev/npm/package/${purl.replace(/^pkg:npm\//, "")}`
      : undefined
  );
  const version = report.version ?? data.version ?? packageMatch?.[1] ?? source?.match(/\/alerts\/(\d+\.\d+\.\d+)/)?.[1];
  if (version !== "0.6.0") throw new Error("This baseline importer only accepts metaplate@0.6.0 reports");
  assertSourceConsistency(source, purl, version);
  if (purl && purl !== `pkg:npm/metaplate@${version}`) throw new Error("Socket report package must be metaplate");

  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const inventory = classifyLockPackages({ root, manifest, lockfile });
  const shallowScore = assertScore(data.self?.score ?? report.shallow?.score ?? report.shallow, "shallow");
  const deepScore = assertScore(data.transitively?.score ?? report.deep?.score ?? report.deep, "deep");
  const shallowAlerts = assertAlerts(data.self?.alerts ?? report.shallow?.alerts ?? [], "shallow", inventory);
  const deepAlerts = assertAlerts(data.transitively?.alerts ?? report.deep?.alerts ?? [], "deep", inventory);
  const deep = data.transitively ?? report.deep ?? {};
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
      dependencyCount: deep.dependencyCount ?? null,
      capabilities: deep.capabilities ?? [],
      lowest: deep.lowest ?? null,
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
  fail("Socket report input is required. Set SOCKET_REPORT_INPUT or pass: node scripts/socket-report.mjs OUTPUT INPUT.json");
} else {
  try {
    const inputBytes = readFileSync(resolve(input));
    const inputSha256 = createHash("sha256").update(inputBytes).digest("hex");
    const text = inputBytes[0] === 0xff && inputBytes[1] === 0xfe
      ? new TextDecoder("utf-16le").decode(inputBytes)
      : inputBytes.toString("utf8");
    const report = normalize(JSON.parse(text.replace(/^\uFEFF/, "")), inputSha256);
    writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`Imported Socket report for ${report.package}@${report.version}: ${output}\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
