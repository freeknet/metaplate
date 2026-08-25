import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function runImporter(input: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "metaplate-socket-"));
  const inputPath = join(directory, "input.json");
  const outputPath = join(directory, "output.json");
  await writeFile(inputPath, JSON.stringify(input));
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

  it("rejects reports without official provenance or the requested baseline", async () => {
    await expect(runImporter({ version: "0.6.0" })).resolves.toMatchObject({ code: 1 });
    await expect(runImporter({ source: "https://example.com/report", version: "0.6.0" })).resolves.toMatchObject({ code: 1 });
    await expect(runImporter({ source: "https://socket.dev/report", version: "0.7.0" })).resolves.toMatchObject({ code: 1 });
  });
});
