import { AsyncLocalStorage } from "node:async_hooks";
import process from "node:process";

/**
 * Not an entry point: where a CLI run writes and how it records failure.
 * `runCli` gives each run its own streams and exit code through
 * `AsyncLocalStorage`, so concurrent runs in one process never share
 * `process.exitCode`; outside `runCli` (the `metaplate` binary) output goes to
 * the process streams.
 */

/** Anything with a `write(text)` method: a stream, or a collector in tests. */
export type CliWriter = { write(text: string): unknown };

type CliRun = { stdout: CliWriter; stderr: CliWriter; exitCode: number };

const runs = new AsyncLocalStorage<CliRun>();

export function writeStdout(text: string): void {
  (runs.getStore()?.stdout ?? process.stdout).write(text);
}

export function writeStderr(text: string): void {
  (runs.getStore()?.stderr ?? process.stderr).write(text);
}

/** Marks the current run as failed: exit code 1. */
export function markFailed(): void {
  const run = runs.getStore();
  if (run) run.exitCode = 1;
  else process.exitCode = 1;
}

/** Runs `task` with its own streams and returns the exit code it recorded. */
export async function withCliIo(
  streams: { stdout: CliWriter; stderr: CliWriter },
  task: () => Promise<void>,
): Promise<number> {
  const run: CliRun = { ...streams, exitCode: 0 };
  await runs.run(run, task);
  return run.exitCode;
}
