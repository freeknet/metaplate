import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateSocketReport } from "../scripts/verify-socket-dispositions.mjs";

type JsonObject = Record<string, any>;

const dispositionReport = JSON.parse(
  await readFile("socket-dispositions.json", "utf8"),
) as JsonObject;
const scoreReport = JSON.parse(
  await readFile("socket-score-report.json", "utf8"),
) as JsonObject;

async function reportForScore(
  mutateScore: (score: JsonObject) => void,
  mutateDisposition?: (report: JsonObject) => void,
) {
  const score = JSON.parse(JSON.stringify(scoreReport)) as JsonObject;
  mutateScore(score);

  const directory = await mkdtemp(join(tmpdir(), "metaplate-socket-severity-"));
  const scorePath = join(directory, "socket-score-report.json");
  const content = `${JSON.stringify(score, null, 2)}\n`;
  await writeFile(scorePath, content);
  const sha256 = createHash("sha256").update(content).digest("hex");

  const report = JSON.parse(JSON.stringify(dispositionReport)) as JsonObject;
  report.export = {
    ...report.export,
    artifact: scorePath,
    sha256,
  };
  mutateDisposition?.(report);
  return report;
}

function currentHighAlert(score: JsonObject) {
  const alert = score.deep.alerts.find(
    (entry: JsonObject) => entry.severity === "high",
  );
  if (!alert) throw new Error("expected current high Socket alert");
  return alert;
}

describe("Socket score/disposition severity binding", () => {
  it("blocks a critical score finding even when its disposition is downgraded to high", async () => {
    const report = await reportForScore((score) => {
      currentHighAlert(score).severity = "critical";
    });

    const errors = validateSocketReport(
      report,
      new Date("2026-08-25T12:00:00Z"),
    );

    expect(
      errors.some(
        (error) =>
          error.includes("score artifact") &&
          error.includes("critical") &&
          error.includes("blocks release"),
      ),
    ).toBe(true);
    expect(
      errors.some(
        (error) =>
          error.includes("severity high") &&
          error.includes("score artifact severity critical"),
      ),
    ).toBe(true);
    expect(errors.some((error) => error.includes("missing disposition"))).toBe(
      true,
    );
  });

  it("blocks a critical score finding even with a matching critical disposition", async () => {
    const report = await reportForScore(
      (score) => {
        currentHighAlert(score).severity = "critical";
      },
      (dispositions) => {
        dispositions.alerts[0].severity = "critical";
      },
    );

    const errors = validateSocketReport(
      report,
      new Date("2026-08-25T12:00:00Z"),
    );

    expect(
      errors.some(
        (error) =>
          error.includes("score artifact") &&
          error.includes("critical") &&
          error.includes("blocks release"),
      ),
    ).toBe(true);
  });

  it("rejects a critical disposition for a high score finding", async () => {
    const report = await reportForScore(
      () => {},
      (dispositions) => {
        dispositions.alerts[0].severity = "critical";
      },
    );

    const errors = validateSocketReport(
      report,
      new Date("2026-08-25T12:00:00Z"),
    );

    expect(
      errors.some(
        (error) =>
          error.includes("severity critical") &&
          error.includes("score artifact severity high"),
      ),
    ).toBe(true);
  });
});
