import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateSocketReport } from "../scripts/verify-socket-dispositions.mjs";

interface ScoreAlert {
  severity: string;
  [key: string]: unknown;
}

interface ScoreReport {
  deep: { alerts: ScoreAlert[] };
  [key: string]: unknown;
}

interface DispositionAlert {
  severity: string;
  [key: string]: unknown;
}

interface DispositionReport {
  export: Record<string, unknown>;
  alerts: DispositionAlert[];
  [key: string]: unknown;
}

const dispositionReport = JSON.parse(
  await readFile("socket-dispositions.json", "utf8"),
) as DispositionReport;
const scoreReport = JSON.parse(
  await readFile("socket-score-report.json", "utf8"),
) as ScoreReport;

async function reportForScore(
  mutateScore: (score: ScoreReport) => void,
  mutateDisposition?: (report: DispositionReport) => void,
) {
  const score = JSON.parse(JSON.stringify(scoreReport)) as ScoreReport;
  mutateScore(score);

  const directory = await mkdtemp(join(tmpdir(), "metaplate-socket-severity-"));
  const scorePath = join(directory, "socket-score-report.json");
  const content = `${JSON.stringify(score, null, 2)}\n`;
  await writeFile(scorePath, content);
  const sha256 = createHash("sha256").update(content).digest("hex");

  const report = JSON.parse(
    JSON.stringify(dispositionReport),
  ) as DispositionReport;
  report.export = {
    ...report.export,
    artifact: scorePath,
    sha256,
  };
  mutateDisposition?.(report);
  return report;
}

function currentHighAlert(score: ScoreReport) {
  const alert = score.deep.alerts.find((entry) => entry.severity === "high");
  if (!alert) throw new Error("expected current high Socket alert");
  return alert;
}

function currentDisposition(report: DispositionReport) {
  const disposition = report.alerts[0];
  if (!disposition) throw new Error("expected current Socket disposition");
  return disposition;
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
        currentDisposition(dispositions).severity = "critical";
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
        currentDisposition(dispositions).severity = "critical";
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
