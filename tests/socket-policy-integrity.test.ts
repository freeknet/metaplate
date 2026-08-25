import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateSocketReport } from "../scripts/verify-socket-dispositions.mjs";

const report = JSON.parse(await readFile("socket-dispositions.json", "utf8"));

describe("Socket evidence integrity", () => {
  it("accepts the committed report and matching score artifact", () => {
    expect(validateSocketReport(report)).toEqual([]);
  });

  it("rejects a disposition report whose artifact hash no longer matches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "metaplate-socket-integrity-"));
    await copyFile("socket-score-report.json", join(directory, "socket-score-report.json"));
    await writeFile(join(directory, "socket-score-report.json"), `${await readFile(join(directory, "socket-score-report.json"), "utf8")}tampered`);
    const tampered = {
      ...report,
      export: {
        ...report.export,
        artifact: join(directory, "socket-score-report.json"),
      },
    };
    expect(validateSocketReport(tampered)).toContain("complete report export sha256 does not match its artifact");
  });
});
