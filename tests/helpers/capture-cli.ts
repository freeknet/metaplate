import { runCli } from "../../src/cli.js";

/** Runs a `metaplate` command in-process, collecting its output and exit code. */
export async function captureCli(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    stdout: { write: (text: string) => { stdout += text; } },
    stderr: { write: (text: string) => { stderr += text; } },
  });
  return { code, stdout, stderr };
}
