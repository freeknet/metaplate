#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import { formatVerifyPath, parseVerifyTargets } from "./cli-args.js";
import { verifyImage } from "./image.js";

async function main(args: string[]) {
  const targets = parseVerifyTargets(args);
  const failures: string[] = [];

  // Process every target independently so one bad file cannot hide the rest
  // from a single verification run.
  for (const { file, size, format } of targets) {
    try {
      const bytes = await readFile(file);
      verifyImage(bytes, size, format);
      process.stdout.write(`✓ ${formatVerifyPath(file)} ${size.width}x${size.height}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`✗ ${formatVerifyPath(file)} ${message}`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`${failure}\n`);
    }
    process.stderr.write(
      `${failures.length} of ${targets.length} files failed verification\n`,
    );
    process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});