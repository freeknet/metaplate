import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { validateSocketReport } from "../scripts/verify-socket-dispositions.mjs";

/** Helper: build a minimal official CLI envelope. */
function cliEnvelope(overrides?: { self?: Record<string, unknown>; transitively?: Record<string, unknown>; purl?: string }) {
  return {
    data: {
      purl: overrides?.purl ?? "pkg:npm/metaplate@0.6.0",
      self: {
        purl: "npm/metaplate@0.6.0",
        score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 },
        ...overrides?.self,
      },
      transitively: {
        score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 },
        ...overrides?.transitively,
      },
    },
  };
}

/** Helper: envelope with a single transitive alert for identity-conflict testing. */
function envelopeWithAlert(alert: Record<string, unknown>) {
  return cliEnvelope({ transitively: { alerts: [alert] } });
}

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
  // --- Official envelope acceptance ---

  it("normalizes an official 0.6.0 report without altering scores", async () => {
    const result = await runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: {
          purl: "npm/metaplate@0.6.0",
          score: { overall: 96, supplyChain: 95, maintenance: 94, quality: 93, vulnerability: 100, license: 99 },
        },
        transitively: {
          score: { overall: 82, supplyChain: 81, maintenance: 80, quality: 79, vulnerability: 100, license: 78 },
        },
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output!).shallow.score).toEqual({ overall: 96, supplyChain: 95, maintenance: 94, quality: 93, vulnerability: 100, license: 99 });
    expect(JSON.parse(result.output!).captureKind).toBe("socket-cli-import");
  });

  it("accepts UTF-16LE official exports", async () => {
    const result = await runImporter(cliEnvelope(), "utf16le");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output!).shallow.score).toEqual({ overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 });
  });

  it("accepts the official Socket CLI data envelope", async () => {
    const result = await runImporter(cliEnvelope());
    expect(result.code).toBe(0);
    const report = JSON.parse(result.output!);
    expect(report.source).toBe("https://socket.dev/npm/package/metaplate@0.6.0");
    expect(report.deep.score).toEqual({ overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 });
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
    // scope is not emitted in the canonical score-alert shape
    expect(normalized.shallow.alerts[0].scope).toBeUndefined();
    expect(normalized.deep.alerts[0].scope).toBeUndefined();

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

  it("normalizes middle severity to medium", async () => {
    const result = await runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: {
          purl: "npm/metaplate@0.6.0",
          score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 },
          alerts: [{ name: "someAlert", severity: "middle" }],
        },
        transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
      },
    });
    expect(result.code).toBe(0);
    const normalized = JSON.parse(result.output!);
    expect(normalized.shallow.alerts[0].severity).toBe("medium");
  });

  // --- Schema rejection: only official CLI envelope accepted ---

  it("rejects non-envelope inputs (raw score JSON, missing data.self)", async () => {
    await expect(runImporter({ version: "0.6.0" })).resolves.toMatchObject({ code: 1 });
    await expect(runImporter({ source: "https://example.com/report", version: "0.6.0" })).resolves.toMatchObject({ code: 1 });
    await expect(runImporter({ source: "https://socket.dev/npm/package/other-package/alerts/0.6.0", version: "0.6.0" })).resolves.toMatchObject({ code: 1 });
    await expect(runImporter({
      source: "https://socket.dev/npm/package/metaplate/alerts/0.6.0",
      version: "0.6.0",
      shallow: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 },
      deep: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 },
    })).resolves.toMatchObject({ code: 1 });
  });

  it("rejects normalized reimport (schemaVersion 2)", async () => {
    await expect(runImporter({
      schemaVersion: 2,
      package: "metaplate",
      version: "0.6.0",
      source: "https://socket.dev/npm/package/metaplate/alerts/0.6.0",
      shallow: { score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 }, alerts: [] },
      deep: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 }, alerts: [] },
    })).resolves.toMatchObject({ code: 1 });
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

  it("rejects malformed score objects", async () => {
    await expect(runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: { purl: "npm/metaplate@0.6.0", score: { overall: 96 } },
        transitively: { score: { overall: 82 } },
      },
    })).resolves.toMatchObject({ code: 1 });
  });

  // --- Hidden alert container rejection ---

  it("rejects report.alerts on official envelope", async () => {
    const result = await runImporter({
      ...cliEnvelope(),
      alerts: [{ name: "criticalAlert", severity: "critical", example: "npm/string.prototype.codepointat@0.2.1" }],
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("report.alerts");
  });

  it("rejects data.alerts on official envelope", async () => {
    const result = await runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: { purl: "npm/metaplate@0.6.0", score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 } },
        transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
        alerts: [{ name: "criticalAlert", severity: "critical", example: "npm/string.prototype.codepointat@0.2.1" }],
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("data.alerts");
  });

  it("rejects report.shallow and report.deep on official envelope", async () => {
    const r1 = await runImporter({
      ...cliEnvelope(),
      shallow: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 },
    });
    expect(r1.code).toBe(1);
    expect(r1.stderr).toContain("report.shallow");

    const r2 = await runImporter({
      ...cliEnvelope(),
      deep: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 },
    });
    expect(r2.code).toBe(1);
    expect(r2.stderr).toContain("report.deep");
  });

  // --- URL hardening ---

  it("rejects invalid source URL paths", async () => {
    await expect(runImporter({ source: "https://socket.dev/report", version: "0.6.0" })).resolves.toMatchObject({ code: 1 });
    await expect(runImporter({ source: "https://socket.dev/foo", version: "0.6.0" })).resolves.toMatchObject({ code: 1 });
    await expect(runImporter({ source: "http://socket.dev/npm/package/metaplate@0.6.0", version: "0.6.0" })).resolves.toMatchObject({ code: 1 });
    await expect(runImporter({ source: "https://evil.dev/npm/package/metaplate@0.6.0", version: "0.6.0" })).resolves.toMatchObject({ code: 1 });
  });

  it("rejects URL suffix garbage on valid envelope", async () => {
    const result = await runImporter({
      ...cliEnvelope(),
      source: "https://socket.dev/npm/package/metaplate@0.6.0/garbage",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("source URL");
  });

  it("rejects URL without version on valid envelope", async () => {
    const result = await runImporter({
      ...cliEnvelope(),
      source: "https://socket.dev/npm/package/metaplate",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("source URL");
  });

  it("rejects URL with credentials", async () => {
    const result = await runImporter({
      ...cliEnvelope(),
      source: "https://user:pass@socket.dev/npm/package/metaplate@0.6.0",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("source URL");
  });

  // --- Alert severity validation ---

  it("rejects alerts with missing or unknown severity", async () => {
    await expect(runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: { purl: "npm/metaplate@0.6.0", score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 }, alerts: [{ name: "someAlert" }] },
        transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
      },
    })).resolves.toMatchObject({ code: 1 });
    await expect(runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: { purl: "npm/metaplate@0.6.0", score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 }, alerts: [{ name: "someAlert", severity: "urgent" }] },
        transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
      },
    })).resolves.toMatchObject({ code: 1 });
  });

  // --- Identity conflict detection ---

  it("rejects alerts with conflicting example and explicit identity", async () => {
    await expect(runImporter(envelopeWithAlert({
      name: "someAlert", severity: "low", example: "npm/real-pkg@1.0.0", package: "different-pkg", version: "2.0.0",
    }))).resolves.toMatchObject({ code: 1 });
  });

  it("rejects partial identity conflict (package only)", async () => {
    await expect(runImporter(envelopeWithAlert({
      name: "someAlert", severity: "low", example: "npm/real-pkg@1.0.0", package: "fake-package",
    }))).resolves.toMatchObject({ code: 1 });
  });

  it("rejects partial identity conflict (version only)", async () => {
    await expect(runImporter(envelopeWithAlert({
      name: "someAlert", severity: "low", example: "npm/real-pkg@1.0.0", version: "9.9.9",
    }))).resolves.toMatchObject({ code: 1 });
  });

  it("rejects name/type conflict", async () => {
    await expect(runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: { purl: "npm/metaplate@0.6.0", score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 }, alerts: [{ name: "alertA", type: "alertB", severity: "low" }] },
        transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
      },
    })).resolves.toMatchObject({ code: 1 });
  });

  it("rejects missing alert name/type", async () => {
    await expect(runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: { purl: "npm/metaplate@0.6.0", score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 }, alerts: [{ severity: "low" }] },
        transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
      },
    })).resolves.toMatchObject({ code: 1 });
  });

  it("rejects non-string and empty package/version", async () => {
    await expect(runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: { purl: "npm/metaplate@0.6.0", score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 }, alerts: [{ name: "someAlert", severity: "low", package: "", version: "" }] },
        transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
      },
    })).resolves.toMatchObject({ code: 1 });
  });

  // --- Official envelope enforcement ---

  it("rejects top-level self/transitively without report.data", async () => {
    await expect(runImporter({
      self: { score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 } },
      transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
      source: "https://socket.dev/npm/package/metaplate@0.6.0",
      version: "0.6.0",
    })).resolves.toMatchObject({ code: 1 });
  });

  it("rejects data without data.purl", async () => {
    await expect(runImporter({
      data: {
        self: { score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 } },
        transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
      },
      source: "https://socket.dev/npm/package/metaplate@0.6.0",
      version: "0.6.0",
    })).resolves.toMatchObject({ code: 1 });
  });

  // --- Malformed present identity fields ---

  /** Helper: minimal valid envelope with optional report-level overrides. */
  function minimalEnvelope(overrides?: Record<string, unknown>) {
    return {
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: { score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 } },
        transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
      },
      ...overrides,
    };
  }

  it("rejects malformed present identity fields (non-string types)", async () => {
    await expect(runImporter(minimalEnvelope({ data: { ...minimalEnvelope().data, self: { purl: 123, score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 } }, transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } } } }))).resolves.toMatchObject({ code: 1 });
    await expect(runImporter(minimalEnvelope({ version: 0.6 }))).resolves.toMatchObject({ code: 1 });
    await expect(runImporter(minimalEnvelope({ version: { fake: true } }))).resolves.toMatchObject({ code: 1 });
    await expect(runImporter(minimalEnvelope({ data: { ...minimalEnvelope().data, version: null } }))).resolves.toMatchObject({ code: 1 });
    await expect(runImporter(minimalEnvelope({ source: 42 }))).resolves.toMatchObject({ code: 1 });
  });

  // --- Package/version claim conflicts ---

  it("rejects conflicting package claims between data.purl and data.self.purl", async () => {
    await expect(runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: { purl: "npm/metaplate@0.6.1", score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 } },
        transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
      },
    })).resolves.toMatchObject({ code: 1 });

    await expect(runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: { purl: "npm/other-package@0.6.0", score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 } },
        transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
      },
    })).resolves.toMatchObject({ code: 1 });
  });

  it("rejects conflicting version claims between report.version and data.version", async () => {
    await expect(runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: { score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 } },
        transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
        version: "0.7.0",
      },
    })).resolves.toMatchObject({ code: 1 });
  });

  // --- Score vector validation (importer) ---

  /** Helper: build envelope with a specific shallow score override. */
  function envelopeWithScore(selfScore: Record<string, unknown>, deepScore?: Record<string, unknown>) {
    return cliEnvelope({
      self: { score: selfScore },
      transitively: { score: deepScore ?? { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
    });
  }

  const VALID_SHALLOW = { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 };

  it("rejects invalid score vectors (importer)", async () => {
    await expect(runImporter(envelopeWithScore({ ...VALID_SHALLOW, overall: 101 }))).resolves.toMatchObject({ code: 1 });
    await expect(runImporter(envelopeWithScore({ ...VALID_SHALLOW, overall: -1 }))).resolves.toMatchObject({ code: 1 });
    await expect(runImporter(envelopeWithScore({ ...VALID_SHALLOW, overall: "76" }))).resolves.toMatchObject({ code: 1 });
    await expect(runImporter(envelopeWithScore({ overall: 76, supplyChain: 76, quality: 99, vulnerability: 100, license: 100 }))).resolves.toMatchObject({ code: 1 });
    await expect(runImporter(envelopeWithScore({ ...VALID_SHALLOW, license: null }))).resolves.toMatchObject({ code: 1 });
    await expect(runImporter({ data: { purl: "pkg:npm/metaplate@0.6.0", self: { score: VALID_SHALLOW }, transitively: { score: null } } })).resolves.toMatchObject({ code: 1 });
  });

  // --- Double-version URL ---

  it("rejects double-version URL patterns", async () => {
    await expect(runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: { score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 } },
        transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
      },
      source: "https://socket.dev/npm/package/metaplate@0.6.0@0.6.0",
    })).resolves.toMatchObject({ code: 1 });

    await expect(runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: { score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 } },
        transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
      },
      source: "https://socket.dev/npm/package/metaplate@0.6.0@9.9.9",
    })).resolves.toMatchObject({ code: 1 });
  });

  // --- Derived-field poisoning ---

  it("does not preserve malicious derived fields from raw CLI alerts", async () => {
    const result = await runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: { purl: "npm/metaplate@0.6.0", score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 } },
        transitively: {
          score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 },
          alerts: [{
            name: "socketUpgradeAvailable",
            severity: "high",
            example: "npm/string.prototype.codepointat@0.2.1",
            reachability: "development-only",
            dependencyPath: "metaplate > fake",
            lockfilePath: "node_modules/fake",
            scope: "fake",
          }],
        },
      },
    });
    expect(result.code).toBe(0);
    const normalized = JSON.parse(result.output!);
    const alert = normalized.deep.alerts[0];
    // scope is not emitted in the canonical score-alert shape
    expect(alert.scope).toBeUndefined();
    // reachability must come from inventory, not from input
    expect(alert.dependencyEvidence.reachability).not.toBe("development-only");
    // lockfilePath must not exist
    expect(alert.lockfilePath).toBeUndefined();
    // dependencyPath must be a real path from the inventory
    expect(alert.dependencyPath).not.toBe("metaplate > fake");
  });

  // --- Alert containers by presence ---

  it("rejects report.alerts even when non-array (object)", async () => {
    const result = await runImporter({
      ...cliEnvelope(),
      alerts: { severity: "critical" },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("report.alerts");
  });

  it("rejects data.alerts even when non-array (object)", async () => {
    const result = await runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: { purl: "npm/metaplate@0.6.0", score: { overall: 76, supplyChain: 76, maintenance: 92, quality: 99, vulnerability: 100, license: 100 } },
        transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } },
        alerts: { severity: "critical" },
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("data.alerts");
  });

  // --- Auxiliary deep fields (dependencyCount, capabilities, lowest) ---

  it("rejects malformed dependencyCount values", async () => {
    const deep = { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } };
    await expect(runImporter(cliEnvelope({ transitively: { ...deep, dependencyCount: 1.5 } }))).resolves.toMatchObject({ code: 1 });
    await expect(runImporter(cliEnvelope({ transitively: { ...deep, dependencyCount: -1 } }))).resolves.toMatchObject({ code: 1 });
    await expect(runImporter(cliEnvelope({ transitively: { ...deep, dependencyCount: "5" } }))).resolves.toMatchObject({ code: 1 });
  });

  it("accepts a valid non-negative integer dependencyCount", async () => {
    const result = await runImporter(cliEnvelope({ transitively: { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 }, dependencyCount: 90 } }));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output!).deep.dependencyCount).toBe(90);
  });

  it("rejects malformed capabilities values", async () => {
    const deep = { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } };
    await expect(runImporter(cliEnvelope({ transitively: { ...deep, capabilities: "not-an-array" } }))).resolves.toMatchObject({ code: 1 });
    await expect(runImporter(cliEnvelope({ transitively: { ...deep, capabilities: ["fs", 123, {}] } }))).resolves.toMatchObject({ code: 1 });
  });

  it("rejects malformed lowest values", async () => {
    const deep = { score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 } };
    await expect(runImporter(cliEnvelope({ transitively: { ...deep, lowest: [] } }))).resolves.toMatchObject({ code: 1 });
    await expect(runImporter(cliEnvelope({ transitively: { ...deep, lowest: { unknownKey: "npm/x@1.0.0" } } }))).resolves.toMatchObject({ code: 1 });
    await expect(runImporter(cliEnvelope({ transitively: { ...deep, lowest: { maintenance: 5 } } }))).resolves.toMatchObject({ code: 1 });
  });

  it("accepts a valid lowest map with the canonical score keys", async () => {
    const result = await runImporter(cliEnvelope({
      transitively: {
        score: { overall: 38, supplyChain: 60, maintenance: 54, quality: 38, vulnerability: 100, license: 70 },
        lowest: { overall: "npm/x@1.0.0", supplyChain: "npm/y@2.0.0", maintenance: "npm/z@3.0.0" },
      },
    }));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output!).deep.lowest.maintenance).toBe("npm/z@3.0.0");
  });

  // --- capturedAt / normalizedAt ---

  it("rejects invalid capturedAt timestamps", async () => {
    await expect(runImporter(minimalEnvelope({ capturedAt: "banana" }))).resolves.toMatchObject({ code: 1 });
    await expect(runImporter(minimalEnvelope({ capturedAt: "Aug 25, 2026" }))).resolves.toMatchObject({ code: 1 });
  });

  it("retains a valid source capturedAt and always emits normalizedAt", async () => {
    const withCapture = await runImporter(minimalEnvelope({ capturedAt: "2026-08-25T18:24:42Z" }));
    expect(withCapture.code).toBe(0);
    const captured = JSON.parse(withCapture.output!);
    expect(captured.capturedAt).toBe("2026-08-25T18:24:42Z");
    expect(typeof captured.normalizedAt).toBe("string");
    expect(Number.isNaN(Date.parse(captured.normalizedAt))).toBe(false);

    const withoutCapture = await runImporter(minimalEnvelope());
    expect(withoutCapture.code).toBe(0);
    const output = JSON.parse(withoutCapture.output!);
    expect(output.capturedAt).toBeUndefined();
    expect(typeof output.normalizedAt).toBe("string");
  });

  // --- Explicit-only identity (no example) ---

  it("accepts explicit-only alert identity (no example) and enriches from inventory", async () => {
    const result = await runImporter(envelopeWithAlert({
      name: "someAlert", severity: "low", package: "string.prototype.codepointat", version: "0.2.1",
    }));
    expect(result.code).toBe(0);
    const normalized = JSON.parse(result.output!);
    expect(normalized.deep.alerts[0].package).toBe("string.prototype.codepointat");
    expect(normalized.deep.alerts[0].version).toBe("0.2.1");
    expect(normalized.deep.alerts[0].dependencyEvidence.paths.length).toBeGreaterThan(0);
    expect(normalized.deep.alerts[0].dependencyEvidence.reachability).not.toBe("unknown");
  });
});
