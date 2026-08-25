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

type CliIssue = Readonly<{
  severity?: string;
  code?: string;
  message?: string;
  target?: string;
}>;

type JsonFileReport = {
  file: string;
  valid: boolean;
  image?: {
    format: string;
    width: number;
    height: number;
    bytes: number;
  };
  globalIssues: readonly CliIssue[];
  targets: Record<string, { compatible: boolean; issues: readonly CliIssue[] }>;
};

function hasError(issues: readonly CliIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

function messages(issues: readonly CliIssue[]): string {
  return issues.map(({ message }) => message ?? "verification failed").join("; ");
}

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
  const failedFiles = new Set<string>();
  const jsonFiles: JsonFileReport[] = [];

  for (const target of invocation.targets) {
    const fileName = formatVerifyPath(target.file);
    try {
      const bytes = await readFile(target.file);
      const dimensions = verifyImage(bytes, target.size, target.format);
      const targetReports: Record<string, { compatible: boolean; issues: readonly CliIssue[] }> = {};
      let globalIssues: CliIssue[] = [];

      if (invocation.socialTargets.length > 0 || invocation.maxFileSize !== undefined) {
        const descriptor = {
          ...(invocation.url !== undefined ? { url: invocation.url } : {}),
          ...(invocation.alt !== undefined ? { alt: invocation.alt } : {}),
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
        const reportIssues = report.issues as readonly CliIssue[];
        globalIssues = reportIssues.filter((issue) => issue.target === undefined);
        for (const socialTarget of invocation.socialTargets) {
          const targetIssues = reportIssues.filter((issue) => issue.target === socialTarget);
          targetReports[socialTarget] = {
            compatible: !hasError(targetIssues),
            issues: targetIssues,
          };
        }
      }

      const valid = !hasError(globalIssues);
      const targetFailures = Object.entries(targetReports).filter(([, report]) => !report.compatible);
      if (!valid) {
        failedFiles.add(fileName);
        failures.push(`✗ ${fileName} verification failed: ${messages(globalIssues)}`);
      }
      for (const [socialTarget, report] of targetFailures) {
        failedFiles.add(fileName);
        failures.push(`✗ ${fileName} ${socialTarget} compatibility failed: ${messages(report.issues)}`);
      }

      jsonFiles.push({
        file: fileName,
        valid,
        image: {
          format: dimensions.format,
          width: dimensions.width,
          height: dimensions.height,
          bytes: bytes.byteLength,
        },
        globalIssues,
        targets: targetReports,
      });
      if (valid && targetFailures.length === 0 && !invocation.json) {
        process.stdout.write(`✓ ${fileName} ${target.size.width}x${target.size.height}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedFiles.add(fileName);
      failures.push(`✗ ${fileName} verification failed: ${message}`);
      jsonFiles.push({
        file: fileName,
        valid: false,
        globalIssues: [{ severity: "error", message }],
        targets: {},
      });
    }
  }

  if (invocation.json) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, files: jsonFiles }, null, 2)}\n`);
  } else if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.stderr.write(`${failedFiles.size} of ${invocation.targets.length} files failed verification\n`);
  }

  if (failures.length > 0) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.stderr.write(`${VERIFY_USAGE}\n`);
  process.exitCode = 1;
});
