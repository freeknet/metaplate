#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  formatVerifyPath,
  parseVerifyInvocation,
  parseVerifyUrlInvocation,
  VERIFY_URL_USAGE,
  VERIFY_USAGE,
} from "./cli-args.js";
import type { SocialTarget } from "./compatibility-profiles.js";
import type { ImageSize } from "./core.js";
import { verifySocialImage } from "./social-verification.js";
import { imageContentType, verifyImage, type ImageDimensions } from "./image.js";
import { RemoteImageError, verifyRemoteImage } from "./remote.js";
import { METAPLATE_VERSION } from "./version.js";

const CLI_HELP = `${VERIFY_USAGE}
${VERIFY_URL_USAGE}

Commands:
  verify        Verify image dimensions, format, and optional social metadata
  verify-url    Fetch an http(s) image under a hardened policy, then verify it

Options:
  -h, --help       Show this help
  -v, --version    Show the installed version
  --json           Emit one stable JSON report
  --target NAME    Check a compatibility profile (repeatable)
  --url URL        Metadata image URL for target checks (verify only)
  --alt TEXT       Metadata alt text for target checks
  --max-file-size N  Reject images larger than N bytes

verify-url options:
  --max-bytes N      Abort a download larger than N bytes (default 16 MiB)
  --max-redirects N  Follow at most N redirects, each re-checked (default 3)
  --timeout MS       Total time budget, including redirects (default 10000)
  --allow-port PORT  Allow a port besides 80/443 (repeatable)
  --allow-private    Allow loopback/private/link-local addresses (local development only)
`;

type CliIssue = Readonly<{
  severity?: string;
  code?: string;
  message?: string;
  target?: string;
}>;

type TargetReports = Record<string, { compatible: boolean; issues: readonly CliIssue[] }>;

type JsonReport = Record<string, unknown> & {
  valid: boolean;
  image?: {
    format: string;
    width: number;
    height: number;
    bytes: number;
  };
  globalIssues: readonly CliIssue[];
  targets: TargetReports;
};

type SocialOptions = {
  json: boolean;
  socialTargets: readonly SocialTarget[];
  alt?: string;
  maxFileSize?: number;
};

/** What one target's loader returns once its bytes passed `verifyImage`. */
type Loaded = {
  bytes: Uint8Array;
  dimensions: ImageDimensions;
  /** URL evaluated by target checks, when one is known. */
  metadataUrl?: string;
  /** Extra JSON report fields, such as the final URL after redirects. */
  details?: Record<string, unknown>;
  /** Suffix for the human success line. */
  note?: string;
};

type Check = {
  /** Display name used in human output. */
  name: string;
  /** Identity fields that open the JSON report entry. */
  identity: Record<string, string>;
  size: ImageSize;
  load: () => Promise<Loaded>;
};

function hasError(issues: readonly CliIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

function messages(issues: readonly CliIssue[]): string {
  return issues.map(({ message }) => message ?? "verification failed").join("; ");
}

function socialReports(check: Check, loaded: Loaded, options: SocialOptions) {
  const targets: TargetReports = {};
  if (options.socialTargets.length === 0 && options.maxFileSize === undefined) {
    return { globalIssues: [] as CliIssue[], targets };
  }
  const descriptor = {
    ...(loaded.metadataUrl !== undefined ? { url: loaded.metadataUrl } : {}),
    ...(options.alt !== undefined ? { alt: options.alt } : {}),
    width: check.size.width,
    height: check.size.height,
    type: imageContentType(loaded.dimensions.format),
  };
  const report = verifySocialImage(loaded.bytes, descriptor, {
    targets: [...options.socialTargets],
    ...(options.maxFileSize !== undefined ? { maxFileSize: options.maxFileSize } : {}),
  });
  const reportIssues = report.issues as readonly CliIssue[];
  for (const socialTarget of options.socialTargets) {
    const targetIssues = reportIssues.filter((issue) => issue.target === socialTarget);
    targets[socialTarget] = { compatible: !hasError(targetIssues), issues: targetIssues };
  }
  return { globalIssues: reportIssues.filter((issue) => issue.target === undefined), targets };
}

/** Runs every check, reports each outcome, and sets the exit code once. */
async function runChecks(checks: readonly Check[], options: SocialOptions, listKey: string, noun: string) {
  const failures: string[] = [];
  const failed = new Set<string>();
  const reports: JsonReport[] = [];

  for (const check of checks) {
    try {
      const loaded = await check.load();
      const { globalIssues, targets } = socialReports(check, loaded, options);
      const valid = !hasError(globalIssues);
      const targetFailures = Object.entries(targets).filter(([, report]) => !report.compatible);
      if (!valid) {
        failed.add(check.name);
        failures.push(`✗ ${check.name} verification failed: ${messages(globalIssues)}`);
      }
      for (const [socialTarget, report] of targetFailures) {
        failed.add(check.name);
        failures.push(`✗ ${check.name} ${socialTarget} compatibility failed: ${messages(report.issues)}`);
      }

      reports.push({
        ...check.identity,
        ...loaded.details,
        valid,
        image: {
          format: loaded.dimensions.format,
          width: loaded.dimensions.width,
          height: loaded.dimensions.height,
          bytes: loaded.bytes.byteLength,
        },
        globalIssues,
        targets,
      });
      if (valid && targetFailures.length === 0 && !options.json) {
        process.stdout.write(`✓ ${check.name} ${check.size.width}x${check.size.height}${loaded.note ?? ""}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof RemoteImageError ? { code: error.code } : {};
      failed.add(check.name);
      failures.push(`✗ ${check.name} verification failed: ${message}`);
      reports.push({
        ...check.identity,
        valid: false,
        globalIssues: [{ severity: "error", ...code, message }],
        targets: {},
      });
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, [listKey]: reports }, null, 2)}\n`);
  } else if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.stderr.write(`${failed.size} of ${checks.length} ${noun} failed verification\n`);
  }

  if (failures.length > 0) process.exitCode = 1;
}

/** Never echo embedded credentials back into logs or JSON reports. */
function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username === "" && url.password === "") return raw;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return raw;
  }
}

function verifyFiles(args: string[]) {
  const invocation = parseVerifyInvocation(args);
  const checks = invocation.targets.map((target): Check => {
    const name = formatVerifyPath(target.file);
    return {
      name,
      identity: { file: name },
      size: target.size,
      load: async () => {
        const bytes = await readFile(target.file);
        const dimensions = verifyImage(bytes, target.size, target.format);
        return { bytes, dimensions, ...(invocation.url !== undefined ? { metadataUrl: invocation.url } : {}) };
      },
    };
  });
  return runChecks(checks, invocation, "files", "files");
}

function verifyUrls(args: string[]) {
  const invocation = parseVerifyUrlInvocation(args);
  const checks = invocation.targets.map((target): Check => {
    const name = displayUrl(target.url);
    return {
      name,
      identity: { url: name },
      size: target.size,
      load: async () => {
        const remote = await verifyRemoteImage(
          target.url,
          { ...target.size, ...(target.format ? { format: target.format } : {}) },
          invocation.fetch,
        );
        const redirected = remote.finalUrl !== remote.url ? `, final URL ${remote.finalUrl}` : "";
        return {
          bytes: remote.bytes,
          dimensions: remote.image,
          // Target checks evaluate the URL as published, not where it landed.
          ...(invocation.socialTargets.length > 0 ? { metadataUrl: remote.url } : {}),
          details: {
            finalUrl: remote.finalUrl,
            redirects: remote.redirects,
            contentType: remote.contentType ?? null,
            bytes: remote.byteLength,
          },
          note: ` (${remote.byteLength} bytes${redirected})`,
        };
      },
    };
  });
  return runChecks(checks, invocation, "urls", "URLs");
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
  await (args[0] === "verify-url" ? verifyUrls(args) : verifyFiles(args));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.stderr.write(`${process.argv[2] === "verify-url" ? VERIFY_URL_USAGE : VERIFY_USAGE}\n`);
  process.exitCode = 1;
});
