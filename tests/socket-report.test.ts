import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { validateSocketReport } from "../scripts/verify-socket-dispositions.mjs";

async function runImporter(input: unknown, encoding: "utf8" | "utf16le" = "utf8") {
  const directory = await mkdtemp(join(tmpdir(), "metaplate-socket-"));
  const inputPath = join(directory, "input.json");
  const outputPath = join(directory, "output.json");
  const content = JSON.stringify(input);
  await writeFile(inputPath, encoding === "utf16le" ? Buffer.from(`\uFEFF${content}`, "utf16le") : content);
  const child = await import("node:child_process");
  return new Promise<{ code: number | null; stdout: string; stderr: string; output?: string; inputPath: string; outputPath: string }>((resolve) => {
    const childProcess = child.spawn(globalThis.process.execPath, ["scripts/socket-report.mjs", outputPath, inputPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    childProcess.stdout.on("data", (chunk) => { stdout += chunk; });
    childProcess.stderr.on("data", (chunk) => { stderr += chunk; });
    childProcess.on("close", async (code) => {
      let output: string | undefined;
      try { output = await readFile(outputPath, "utf8"); } catch { /* expected on failure */ }
      resolve({ inputPath, outputPath, ...(output === undefined ? {} : { output }), code, stdout, stderr });
    });
  });
}

describe("Socket report importer", () => {
  it("normalizes an official 0.6.0 report without altering scores", async () => {
    const result = await runImporter({
      source: "https://socket.dev/npm/package/metaplate/alerts/0.6.0",
      version: "0.6.0",
      shallow: { overall: 96, supplyChain: 95, maintenance: 94, quality: 93, vulnerability: 100, license: 99 },
      deep: { overall: 82, supplyChain: 81, maintenance: 80, quality: 79, vulnerability: 100, license: 78 },
      alerts: [{ package: "example", severity: "low" }],
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output!).shallow.score).toEqual({ overall: 96, supplyChain: 95, maintenance: 94, quality: 93, vulnerability: 100, license: 99 });
    expect(JSON.parse(result.output!).captureKind).toBe("socket-cli-import");
  });

  it("accepts UTF-16LE official exports", async () => {
    const result = await runImporter({
      data: { purl: "pkg:npm/metaplate@0.6.0", self: { purl: "npm/metaplate@0.6.0", score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 } }, transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } } },
    }, "utf16le");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output!).shallow.score).toEqual({ overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 });
  });

  it("preserves scoped shallow/deep alerts and passes directly into disposition verification", async () => {
    const result = await runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: {
          purl: "npm/metaplate@0.6.0",
          score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 },
          alerts: [{ name: "recentlyPublished", severity: "middle" }],
        },
        transitively: {
          score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 },
          alerts: [{ name: "socketUpgradeAvailable", severity: "high", example: "npm/string.prototype.codepointat@0.2.1" }],
        },
      },
    });
    expect(result.code).toBe(0);
    const normalized = JSON.parse(result.output!);
    expect(normalized.shallow.alerts[0].scope).toBe("shallow");
    expect(normalized.deep.alerts[0].scope).toBe("deep");

    const digest = createHash("sha256").update(await readFile(result.outputPath)).digest("hex");
    const disposition = {
      schemaVersion: 2,
      package: "metaplate",
      version: "0.6.0",
      source: "https://socket.dev/npm/package/metaplate/alerts/0.6.0",
      status: "complete",
      export: { artifact: result.outputPath, generatedAt: "2026-08-25", sha256: digest },
      releasePolicy: {
        blockSeverities: ["critical"],
        requireDispositionSeverities: ["high", "critical"],
        allowedDispositionTypes: ["upgrade", "replace", "remove", "isolate", "accepted-with-evidence"],
        acceptedExceptionRequires: ["owner", "reason", "expiry", "verification"],
      },
      alerts: [{
        type: "socketUpgradeAvailable",
        severity: "high",
        package: "string.prototype.codepointat",
        version: "0.2.1",
        path: "metaplate > satori > @shuding/opentype.js > string.prototype.codepointat",
        reachability: "runtime-peer",
        disposition: "upgrade",
        evidence: "Socket CLI export",
        verification: "package verification",
      }],
    };
    expect(normalized.deep.alerts[0].dependencyEvidence.paths).toContain("metaplate > satori > @shuding/opentype.js > string.prototype.codepointat");
    expect(validateSocketReport(disposition)).toEqual([]);
  });

  it("accepts the official Socket CLI data envelope", async () => {
    const result = await runImporter({
      data: { purl: "pkg:npm/metaplate@0.6.0", self: { purl: "npm/metaplate@0.6.0", score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 } }, transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } } },
    });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.output!);
    expect(report.source).toBe("https://socket.dev/npm/package/metaplate@0.6.0");
    expect(report.deep.score).toEqual({ overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 });
  });

  it("rejects an unresolved high alert instead of producing unverifiable evidence", async () => {
    await expect(runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: { purl: "npm/metaplate@0.6.0", score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 } },
        transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 }, alerts: [{ name: "newHigh", severity: "high", example: "npm/not-in-lock@1.0.0" }] },
      },
    })).resolves.toMatchObject({ code: 1 });
  });

  it("rejects malformed score objects as well as untrusted provenance", async () => {
    await expect(runImporter({
      source: "https://socket.dev/npm/package/metaplate/alerts/0.6.0",
      version: "0.6.0",
      shallow: { overall: 96 },
      deep: { overall: 82 },
    })).resolves.toMatchObject({ code: 1 });
  });

  it("rejects reports without official provenance, the right package, or the requested baseline", async () => {
    await expect(runImporter({ version: "0.6.0" })).resolves.toMatchObject({ code: 1 });
    await expect(runImporter({ source: "https://example.com/report", version: "0.6.0" })).resolves.toMatchObject({ code: 1 });
    await expect(runImporter({ source: "https://socket.dev/npm/package/other-package/alerts/0.6.0", version: "0.6.0" })).resolves.toMatchObject({ code: 1 });
    await expect(runImporter({ source: "https://socket.dev/report", version: "0.7.0" })).resolves.toMatchObject({ code: 1 });
  });
});
