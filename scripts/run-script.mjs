import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function runScript(main, importMetaUrl) {
  if (!process.argv[1] || resolve(process.argv[1]) !== fileURLToPath(importMetaUrl)) return;
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
