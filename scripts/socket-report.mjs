import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

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

function assertAlerts(alerts, label) {
  if (!Array.isArray(alerts)) throw new Error(`${label} alerts must be an array`);
  return alerts.map((alert) => {
    if (!alert || typeof alert !== "object" || typeof (alert.name ?? alert.type) !== "string") {
      throw new Error(`${label} alerts must contain alert names`);
    }
    return { ...alert, scope: label };
  });
}

function normalize(report, inputSha256) {
  if (!report || typeof report !== "object") throw new Error("Socket report must be a JSON object");
  const data = report.data ?? report;
  const source = report.source ?? (
    typeof data.purl === "string"
      ? `https://socket.dev/npm/package/${data.purl.replace(/^pkg:npm\//, "")}`
      : data.self?.purl
        ? `https://socket.dev/npm/package/${data.self.purl.replace(/^npm\//, "")}`
        : undefined
  );
  if (typeof source !== "string" || !source.startsWith("https://socket.dev/")) {
    throw new Error("Socket report requires an official https://socket.dev/ source");
  }
  const packageMatch = source.match(/metaplate@(\d+\.\d+\.\d+)/);
  const version = report.version ?? data.version ?? data.self?.purl?.match(/@(\d+\.\d+\.\d+)$/)?.[1] ?? packageMatch?.[1];
  if (version !== "0.6.0") throw new Error("This baseline importer only accepts metaplate@0.6.0 reports");
  if (data.purl && data.purl !== `pkg:npm/metaplate@${version}`) throw new Error("Socket report package must be metaplate");
  const sourcePackage = source.match(/\/npm\/package\/([^/?#]+)/)?.[1];
  if (!data.purl && sourcePackage !== "metaplate" && sourcePackage !== `metaplate@${version}`) {
    throw new Error("Socket report package must be metaplate");
  }

  const shallowScore = assertScore(data.self?.score ?? report.shallow?.score ?? report.shallow, "shallow");
  const deepScore = assertScore(data.transitively?.score ?? report.deep?.score ?? report.deep, "deep");
  const shallowAlerts = assertAlerts(data.self?.alerts ?? report.shallow?.alerts ?? [], "shallow");
  const deepAlerts = assertAlerts(data.transitively?.alerts ?? report.deep?.alerts ?? [], "deep");
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
