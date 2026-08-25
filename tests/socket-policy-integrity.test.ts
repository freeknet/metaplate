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
  const content = JSON.stringify(mutate(score as JsonObject));
  await writeFile(scorePath, content);
  const digest = (await import("node:crypto")).createHash("sha256").update(content).digest("hex");
  const digestReport = { ...dispositionReport, export: { ...dispositionReport.export, artifact: scorePath, sha256: digest } };
  return { report: digestReport, scorePath, content };
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
});
