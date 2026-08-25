#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  formatVerifyPath,
  parseVerifyInvocation,
  VERIFY_USAGE,
} from "./cli-args.js";
import { verifySocialImage } from "./social-verification.js";
import { verifyImage } from "./image.js";
import { METAPLATE_VERSION } from "./version.js";

const CLI_HELP = `${VERIFY_USAGE}\n\nCommands:\n  verify    Verify image dimensions, format, and optional social metadata\n\nOptions:\n  -h, --help       Show this help\n  -v, --version    Show the installed version\n  --json           Emit one stable JSON report\n  --target NAME    Check a compatibility profile (repeatable)\n  --url URL        Metadata image URL for target checks\n  --alt TEXT       Metadata alt text for target checks\n  --max-file-size N  Reject images larger than N bytes\n`;

type JsonFileReport = {
  file: string;
  format?: string;
  width?: number;
  height?: number;
  bytes?: number;
  compatible: boolean;
  targets: Record<string, { compatible: boolean; issues: readonly unknown[] }>;
  issues: readonly unknown[];
};

async function main(args: string[]) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(CLI_HELP);
    return;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    process.stdout.write(`${METAPLATE_VERSION}\n`);
    return;
  }

  const invocation = parseVerifyInvocation(args);
  const failures: string[] = [];
  const jsonFiles: JsonFileReport[] = [];

  for (const target of invocation.targets) {
    const fileName = formatVerifyPath(target.file);
    try {
      const bytes = await readFile(target.file);
      const dimensions = verifyImage(bytes, target.size, target.format);
      const targetReports: Record<string, { compatible: boolean; issues: readonly unknown[] }> = {};
      const issues: unknown[] = [];
      let compatible = true;

      if (invocation.socialTargets.length > 0 || invocation.maxFileSize !== undefined) {
        const descriptor = {
          url: invocation.url ?? "https://example.invalid/og-image",
          alt: invocation.alt ?? "",
          width: target.size.width,
          height: target.size.height,
          type: dimensions.format === "svg"
            ? "image/svg+xml"
            : `image/${dimensions.format === "jpeg" ? "jpeg" : dimensions.format}`,
        };
        const report = verifySocialImage(bytes, descriptor, {
          ...(invocation.socialTargets.length > 0 ? { targets: invocation.socialTargets } : { targets: [] }),
          ...(invocation.maxFileSize !== undefined ? { maxFileSize: invocation.maxFileSize } : {}),
        });
        compatible = report.compatible;
        issues.push(...report.issues);
        for (const socialTarget of invocation.socialTargets) {
          const targetIssues = report.issues.filter((issue) =>
            "target" in issue && issue.target === socialTarget,
          );
          targetReports[socialTarget] = {
            compatible: !targetIssues.some((issue) => "severity" in issue && issue.severity === "error"),
            issues: targetIssues,
          };
        }
        if (!compatible) failures.push(`✗ ${fileName} social compatibility failed`);
      }

      jsonFiles.push({
        file: fileName,
        format: dimensions.format,
        width: dimensions.width,
        height: dimensions.height,
        bytes: bytes.byteLength,
        compatible,
        targets: targetReports,
        issues,
      });
      if (compatible && !invocation.json) {
        process.stdout.write(`✓ ${fileName} ${target.size.width}x${target.size.height}\n`);
      } else if (!invocation.json) {
        process.stderr.write(`✗ ${fileName} social compatibility failed\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`✗ ${fileName} ${message}`);
      jsonFiles.push({
        file: fileName,
        compatible: false,
        targets: {},
        issues: [{ severity: "error", message }],
      });
    }
  }

  if (invocation.json) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, files: jsonFiles }, null, 2)}\n`);
  } else if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.stderr.write(`${failures.length} of ${invocation.targets.length} files failed verification\n`);
  }

  if (failures.length > 0) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.stderr.write(`${VERIFY_USAGE}\n`);
  process.exitCode = 1;
});
