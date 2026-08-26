import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateSocketReport } from "../scripts/verify-socket-dispositions.mjs";

type JsonObject = Record<string, unknown>;

const dispositionReport = JSON.parse(await readFile("socket-dispositions.json", "utf8"));
const scoreReport = JSON.parse(await readFile("socket-score-report.json", "utf8"));

async function withScore(score: unknown, mutate: (report: JsonObject) => JsonObject = (report) => report) {
  const directory = await mkdtemp(join(tmpdir(), "metaplate-socket-integrity-"));
  const scorePath = join(directory, "socket-score-report.json");
  const clone = JSON.parse(JSON.stringify(score)) as JsonObject;
  const content = JSON.stringify(mutate(clone));
  await writeFile(scorePath, content);
  const digest = (await import("node:crypto")).createHash("sha256").update(content).digest("hex");
  const digestReport = { ...dispositionReport, export: { ...dispositionReport.export, artifact: scorePath, sha256: digest } };
  return { report: digestReport, scorePath, content };
}

function findResolvedAlert(score: JsonObject): Record<string, unknown> | undefined {
  const deep = score.deep as { alerts: Array<Record<string, unknown>> };
  return deep.alerts.find((a) => {
    const ev = a.dependencyEvidence as Record<string, unknown> | undefined;
    return ev && !ev.unresolved && Array.isArray(ev.paths) && (ev.paths as unknown[]).length > 0;
  });
}

describe("Socket evidence integrity", () => {
  it("accepts the committed report and matching score artifact", () => {
    expect(validateSocketReport(dispositionReport)).toEqual([]);
  });

  it("rejects missing, fake, duplicate, and mismatched high-alert dispositions", async () => {
    const high = dispositionReport.alerts[0];
    const cases = [
      { report: { ...dispositionReport, alerts: [] }, text: "missing disposition" },
      { report: { ...dispositionReport, alerts: [{ ...high, package: "fake" }] }, text: "does not exist in score artifact" },
      { report: { ...dispositionReport, alerts: [{ ...high, version: "9.9.9" }] }, text: "does not exist in score artifact" },
      { report: { ...dispositionReport, alerts: [{ ...high, type: "fakeAlert" }] }, text: "does not exist in score artifact" },
      { report: { ...dispositionReport, alerts: [high, high] }, text: "duplicate high/critical alert identity" },
    ];
    for (const { report, text } of cases) {
      const errors = validateSocketReport(report);
      expect(errors.some((error) => error.includes(text))).toBe(true);
    }

    const newHigh = await withScore(scoreReport, (score) => {
      const deep = score.deep as JsonObject;
      (deep.alerts as unknown[]).push({ name: "newHigh", severity: "high", example: "npm/example@1.0.0", dependencyPath: "metaplate > example" });
      return score;
    });
    expect(validateSocketReport(newHigh.report).some((error) => error.includes("missing disposition"))).toBe(true);
  });

  it("requires disposition reachability and path to match score evidence", async () => {
    const high = dispositionReport.alerts[0];
    expect(validateSocketReport({ ...dispositionReport, alerts: [{ ...high, reachability: "development-only" }] }).some((error) => error.includes("reachability"))).toBe(true);
    expect(validateSocketReport({ ...dispositionReport, alerts: [{ ...high, reachability: "runtime-peer-optional" }] }).some((error) => error.includes("reachability"))).toBe(true);
    expect(validateSocketReport({ ...dispositionReport, alerts: [{ ...high, path: "metaplate > wrong" }] }).some((error) => error.includes("does not exist") || error.includes("path"))).toBe(true);
  });

  it("rejects stale reachability and unsupported paths", async () => {
    const high = dispositionReport.alerts[0];
    const stale = await withScore(scoreReport, (score) => {
      const deep = score.deep as { alerts: Array<Record<string, unknown>> };
      const alert = deep.alerts.find((entry) => entry.name === high.type);
      if (!alert) throw new Error("expected high alert");
      const evidence = alert.dependencyEvidence as { reachability?: string };
      evidence.reachability = "development-only";
      alert.reachability = "development-only";
      return score;
    });
    expect(validateSocketReport(stale.report).some((error) => error.includes("dependency evidence"))).toBe(true);
  });

  it("rejects a disposition report whose artifact hash no longer matches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "metaplate-socket-integrity-"));
    const scorePath = join(directory, "socket-score-report.json");
    await copyFile("socket-score-report.json", scorePath);
    await writeFile(scorePath, `${await readFile(scorePath, "utf8")}tampered`);
    const tampered = { ...dispositionReport, export: { ...dispositionReport.export, artifact: scorePath } };
    expect(validateSocketReport(tampered).some((error) => error.includes("sha256") || error.includes("not readable"))).toBe(true);
  });

  // --- Source URL hardening ---

  it("rejects score artifact with invalid source URL", async () => {
    const tampered = await withScore(scoreReport, (score) => {
      (score as JsonObject).source = "https://socket.dev/report";
      return score;
    });
    expect(validateSocketReport(tampered.report).some((error) => error.includes("source"))).toBe(true);
  });

  it("rejects score artifact with source for wrong package", async () => {
    const tampered = await withScore(scoreReport, (score) => {
      (score as JsonObject).source = "https://socket.dev/npm/package/other-package@0.6.0";
      return score;
    });
    expect(validateSocketReport(tampered.report).some((error) => error.includes("source") || error.includes("package"))).toBe(true);
  });

  it("rejects score artifact with URL suffix garbage", async () => {
    const tampered = await withScore(scoreReport, (score) => {
      (score as JsonObject).source = "https://socket.dev/npm/package/metaplate@0.6.0/garbage";
      return score;
    });
    expect(validateSocketReport(tampered.report).some((error) => error.includes("source"))).toBe(true);
  });

  it("rejects score artifact with URL without version", async () => {
    const tampered = await withScore(scoreReport, (score) => {
      (score as JsonObject).source = "https://socket.dev/npm/package/metaplate";
      return score;
    });
    expect(validateSocketReport(tampered.report).some((error) => error.includes("source"))).toBe(true);
  });

  it("rejects score artifact with URL with credentials", async () => {
    const tampered = await withScore(scoreReport, (score) => {
      (score as JsonObject).source = "https://user:pass@socket.dev/npm/package/metaplate@0.6.0";
      return score;
    });
    expect(validateSocketReport(tampered.report).some((error) => error.includes("source"))).toBe(true);
  });

  it("rejects arbitrary socket.dev pathname even with correct PURL", async () => {
    const tampered = { ...dispositionReport, source: "https://socket.dev/report" };
    expect(validateSocketReport(tampered).some((error) => error.includes("source"))).toBe(true);
  });

  it("rejects disposition report with wrong source hostname", async () => {
    const tampered = { ...dispositionReport, source: "https://evil.dev/npm/package/metaplate@0.6.0" };
    expect(validateSocketReport(tampered).some((error) => error.includes("source"))).toBe(true);
  });

  // --- Identity and schema validation ---

  it("rejects score artifact with conflicting identity in alert", async () => {
    const tampered = await withScore(scoreReport, (score) => {
      const deep = score.deep as { alerts: Array<Record<string, unknown>> };
      const first = deep.alerts.find((a) => a.severity === "high" || a.severity === "critical");
      if (first) {
        first.package = "completely-different-package";
        first.version = "99.99.99";
      }
      return score;
    });
    expect(validateSocketReport(tampered.report).some((error) => error.includes("identity") || error.includes("severity") || error.includes("missing") || error.includes("conflicts") || error.includes("does not exist"))).toBe(true);
  });

  it("rejects score artifact with partial identity conflict", async () => {
    const tampered = await withScore(scoreReport, (score) => {
      const deep = score.deep as { alerts: Array<Record<string, unknown>> };
      const first = deep.alerts.find((a) => a.severity === "high" || a.severity === "critical");
      if (first) {
        first.package = "different-package";
        delete first.version;
      }
      return score;
    });
    expect(validateSocketReport(tampered.report).some((error) => error.includes("conflicts") || error.includes("identity") || error.includes("does not exist"))).toBe(true);
  });

  it("rejects score artifact with invalid severity", async () => {
    const tampered = await withScore(scoreReport, (score) => {
      const deep = score.deep as { alerts: Array<Record<string, unknown>> };
      const first = deep.alerts[0];
      if (first) {
        first.severity = "urgent";
      }
      return score;
    });
    expect(validateSocketReport(tampered.report).some((error) => error.includes("severity"))).toBe(true);
  });

  it("rejects score artifact with missing alert name/type", async () => {
    const tampered = await withScore(scoreReport, (score) => {
      const deep = score.deep as { alerts: Array<Record<string, unknown>> };
      const first = deep.alerts[0];
      if (first) {
        delete first.name;
        delete first.type;
      }
      return score;
    });
    expect(validateSocketReport(tampered.report).some((error) => error.includes("type") || error.includes("identity"))).toBe(true);
  });

  it("rejects score artifact with name/type conflict", async () => {
    const tampered = await withScore(scoreReport, (score) => {
      const deep = score.deep as { alerts: Array<Record<string, unknown>> };
      const first = deep.alerts[0];
      if (first) {
        first.name = "alertA";
        first.type = "alertB";
      }
      return score;
    });
    expect(validateSocketReport(tampered.report).some((error) => error.includes("conflicts") || error.includes("identity") || error.includes("type"))).toBe(true);
  });

  it("rejects unresolved alert that claims resolved evidence", async () => {
    const tampered = await withScore(scoreReport, (score) => {
      const deep = score.deep as { alerts: Array<Record<string, unknown>> };
      const unresolved = deep.alerts.find((a) => {
        const ev = a.dependencyEvidence as Record<string, unknown> | undefined;
        return ev?.unresolved === true;
      });
      if (unresolved) {
        const evidence = unresolved.dependencyEvidence as Record<string, unknown>;
        delete evidence.unresolved;
        evidence.reachability = "runtime-peer";
      }
      return score;
    });
    expect(validateSocketReport(tampered.report).some((error) => error.includes("unresolved"))).toBe(true);
  });

  it("rejects score alert with unreachable deduped reachability", async () => {
    const tampered = await withScore(scoreReport, (score) => {
      const resolved = findResolvedAlert(score);
      if (resolved) resolved.reachability = "development-only";
      return score;
    });
    expect(validateSocketReport(tampered.report).some((error) => error.includes("reachability") || error.includes("dependency evidence"))).toBe(true);
  });

  it("rejects score alert with unreachable deduped dependencyPath", async () => {
    const tampered = await withScore(scoreReport, (score) => {
      const resolved = findResolvedAlert(score);
      if (resolved) resolved.dependencyPath = "metaplate > non-existent > path";
      return score;
    });
    expect(validateSocketReport(tampered.report).some((error) => error.includes("dependencyPath") || error.includes("dependency evidence") || error.includes("path"))).toBe(true);
  });
});
