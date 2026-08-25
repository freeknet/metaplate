import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function runImporter(input: unknown, encoding: "utf8" | "utf16le" = "utf8") {
  const directory = await mkdtemp(join(tmpdir(), "metaplate-socket-"));
  const inputPath = join(directory, "input.json");
  const outputPath = join(directory, "output.json");
  const content = JSON.stringify(input);
  await writeFile(inputPath, encoding === "utf16le" ? Buffer.from(`\uFEFF${content}`, "utf16le") : content);
  const child = await import("node:child_process");
  return new Promise<{ code: number | null; stdout: string; stderr: string; output?: string }>((resolve) => {
    const childProcess = child.spawn(globalThis.process.execPath, ["scripts/socket-report.mjs", outputPath, inputPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    childProcess.stdout.on("data", (chunk) => { stdout += chunk; });
    childProcess.stderr.on("data", (chunk) => { stderr += chunk; });
    childProcess.on("close", async (code) => {
      let output: string | undefined;
      try { output = await readFile(outputPath, "utf8"); } catch { /* expected on failure */ }
      resolve(output === undefined ? { code, stdout, stderr } : { code, stdout, stderr, output });
    });
  });
}

describe("Socket report importer", () => {
  it("normalizes an official 0.6.0 report without altering scores", async () => {
    const result = await runImporter({
      source: "https://socket.dev/npm/package/metaplate/alerts/0.6.0",
      version: "0.6.0",
      shallow: { overall: 96 },
      deep: { overall: 82 },
      alerts: [{ package: "example", severity: "low" }],
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output!).shallow).toEqual({ overall: 96 });
    expect(JSON.parse(result.output!).captureKind).toBe("official-export");
  });

  it("accepts UTF-16LE official exports", async () => {
    const result = await runImporter({
      data: { purl: "pkg:npm/metaplate@0.6.0", self: { purl: "npm/metaplate@0.6.0", score: { overall: 76 } } },
    }, "utf16le");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output!).shallow).toEqual({ overall: 76 });
  });

  it("accepts the official Socket CLI data envelope", async () => {
    const result = await runImporter({
      data: {
        purl: "pkg:npm/metaplate@0.6.0",
        self: {
          purl: "npm/metaplate@0.6.0",
          score: { overall: 76 },
          alerts: [{ name: "recentlyPublished", severity: "middle" }],
        },
        transitively: {
          score: { overall: 38 },
          alerts: [{ name: "socketUpgradeAvailable", severity: "high" }],
        },
      },
    });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.output!);
    expect(report.source).toBe("https://socket.dev/npm/package/metaplate@0.6.0");
    expect(report.shallow).toEqual({ overall: 76 });
    expect(report.deep).toEqual({ overall: 38 });
    expect(report.alerts).toHaveLength(2);
  });

  it("rejects reports without official provenance or the requested baseline", async () => {
    await expect(runImporter({ version: "0.6.0" })).resolves.toMatchObject({ code: 1 });
    await expect(runImporter({ source: "https://example.com/report", version: "0.6.0" })).resolves.toMatchObject({ code: 1 });
    await expect(runImporter({ source: "https://socket.dev/report", version: "0.7.0" })).resolves.toMatchObject({ code: 1 });
  });
});
