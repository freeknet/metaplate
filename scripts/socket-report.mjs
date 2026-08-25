import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

const output = process.argv[2] ?? "socket-score-report.json";
const input = process.argv[3] ?? process.env.SOCKET_REPORT_INPUT;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function normalize(report, inputSha256) {
  if (!report || typeof report !== "object") throw new Error("Socket report must be a JSON object");
  const data = report.data ?? report;
  const source = report.source ?? (
    typeof data.purl === "string"
      ? `https://socket.dev/npm/package/${data.purl.replace(/^pkg:npm\//, "")}`
      : data.self?.purl
  );
  if (typeof source !== "string" || !source.startsWith("https://socket.dev/")) {
    throw new Error("Socket report requires an official https://socket.dev/ source");
  }
  const version = report.version ?? data.version ?? data.self?.purl?.match(/@(\d+\.\d+\.\d+)$/)?.[1];
  if (version !== "0.6.0") throw new Error("This baseline importer only accepts metaplate@0.6.0 reports");
  const alerts = [
    ...(data.self?.alerts ?? []),
    ...(data.transitively?.alerts ?? []),
  ];
  return {
    schemaVersion: 1,
    package: "metaplate",
    version,
    source,
    capturedAt: report.capturedAt ?? new Date().toISOString(),
    captureKind: "official-export",
    shallow: data.self?.score ?? report.shallow ?? null,
    deep: data.transitively?.score ?? report.deep ?? null,
    alerts,
    capabilities: data.transitively?.capabilities ?? data.self?.capabilities ?? report.capabilities ?? null,
    metrics: {
      dependencyCount: data.transitively?.dependencyCount ?? null,
      lowest: data.transitively?.lowest ?? null,
    },
    provenance: {
      importedFrom: "official Socket export",
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
