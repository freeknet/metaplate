#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  DEFAULT_RENDER_CONCURRENCY,
  formatVerifyPath,
  parseVerifyInvocation,
  parseVerifyPageInvocation,
  parseVerifyUrlInvocation,
  DEFAULT_PREVIEW_PORT,
  PREVIEW_USAGE,
  RENDER_USAGE,
  VERIFY_PAGE_USAGE,
  VERIFY_URL_USAGE,
  VERIFY_USAGE,
} from "./args.js";
import { runPreview } from "./preview.js";
import { ReportedError, runRender } from "./render.js";
import type { SocialTarget } from "../verify/compatibility-profiles.js";
import type { ImageSize } from "../core/social-image.js";
import { verifySocialImage } from "../verify/social-verification.js";
import { imageContentType, verifyImage, type ImageDimensions } from "../image.js";
import type { RemotePageCrawlerReport } from "../verify/page-crawlers.js";
import { hasError, redactUrl } from "../core/internal.js";
import { jpegUniformColor } from "../image/jpeg-content.js";
import { pngUniformColor } from "../image/png-content.js";
import { verifyRemotePage, type RemotePageImageReport, type RemotePageVerification } from "../verify/page-verification.js";
import { RemoteImageError, verifyRemoteImage } from "../verify/remote.js";
import { METAPLATE_VERSION } from "../core/version.js";

const CLI_HELP = `${VERIFY_USAGE}
${VERIFY_URL_USAGE}
${VERIFY_PAGE_USAGE}
${RENDER_USAGE}
${PREVIEW_USAGE}

Commands:
  verify        Verify image dimensions, format, and optional social metadata
  verify-url    Fetch an http(s) image under a hardened policy, then verify it
  verify-page   Fetch an http(s) page, extract its social images, and verify each
  render        Write every page and size a render module declares as verified files
  preview       Serve a live gallery of a render module's images that reloads on change

Options:
  -h, --help       Show this help
  -v, --version    Show the installed version
  --json           Emit one stable JSON report
  --target NAME    Check a compatibility profile (repeatable)
  --url URL        Metadata image URL for target checks (verify only)
  --alt TEXT       Metadata alt text for target checks
  --max-file-size N  Reject images larger than N bytes
  --require-content  Fail a PNG or JPEG whose every pixel is one color (verify and verify-url)

verify-url options:
  --max-bytes N      Abort a download larger than N bytes (default 16 MiB)
  --max-redirects N  Follow at most N redirects, each re-checked (default 3)
  --timeout MS       Total time budget, including redirects (default 10000)
  --allow-port PORT  Allow a port besides 80/443 (repeatable)
  --allow-private    Allow loopback/private/link-local addresses (local development only)

verify-page options (plus the verify-url fetch options, which apply to every request):
  --max-html-bytes N  Abort a page larger than N bytes (default 4 MiB)
  --max-images N      Fetch at most N distinct image URLs per page (default 8)
  --crawler TOKEN     Also evaluate robots.txt for this crawler token (repeatable);
                      the crawlers of each --target are evaluated automatically

render options:
  --out DIR          Directory the site is published from (default public)
  --manifest FILE    Manifest path (default DIR/metaplate-manifest.json)
  --concurrency N    Render at most N images at once (default ${DEFAULT_RENDER_CONCURRENCY})

preview options (plus --target and --max-file-size, checked for every image):
  --host HOST        Address to listen on (default 127.0.0.1; anything else warns)
  --port N           Port to listen on (default ${DEFAULT_PREVIEW_PORT}; 0 picks a free one)
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

/**
 * `--require-content`: a card that decodes to one color is blank whatever its
 * format and size checks say. PNG and JPEG are decoded; another format fails
 * rather than passing unchecked.
 */
function assertContent(bytes: Uint8Array, format: string): void {
  if (format !== "png" && format !== "jpeg") {
    throw new Error(
      `--require-content decodes PNG and JPEG only; this image is ${format}. ` +
        "A plate's guards: { blank: \"error\" } runs the same check when it renders.",
    );
  }
  const color = format === "png" ? pngUniformColor(bytes) : jpegUniformColor(bytes);
  if (color) {
    const [red, green, blue, alpha] = color;
    throw new Error(
      `image is blank: every pixel is rgba(${red}, ${green}, ${blue}, ${Math.round((alpha / 255) * 100) / 100})`,
    );
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
        if (invocation.requireContent) assertContent(bytes, dimensions.format);
        return { bytes, dimensions, ...(invocation.url !== undefined ? { metadataUrl: invocation.url } : {}) };
      },
    };
  });
  return runChecks(checks, invocation, "files", "files");
}

function verifyUrls(args: string[]) {
  const invocation = parseVerifyUrlInvocation(args);
  const checks = invocation.targets.map((target): Check => {
    // Never echo embedded credentials back into logs or JSON reports.
    const name = redactUrl(target.url);
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
        if (invocation.requireContent) assertContent(remote.bytes, remote.image.format);
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

const SYMBOL: Readonly<Record<string, string>> = { error: "✗", warning: "!", unknown: "?" };

type Lines = { out: string[]; err: string[] };

function imageLabel(image: RemotePageImageReport): string {
  return image.source === "twitter:image" ? image.source : `${image.source}[${image.index}]`;
}

function imageLine(image: RemotePageImageReport): string {
  const where = `${imageLabel(image)} ${image.url ?? JSON.stringify(image.declared.url)}`;
  const compatible = Object.values(image.targets).every((report) => report.compatible);
  if (image.image && image.valid && compatible) {
    const { width, height, format, bytes } = image.image;
    const redirected = image.finalUrl !== undefined && image.finalUrl !== image.url ? `, final URL ${image.finalUrl}` : "";
    return `  ✓ ${where} ${width}x${height} ${format} (${bytes} bytes${redirected})`;
  }
  // Valid but never fetched: the per-page image limit left it unchecked.
  return `  ${image.valid && compatible ? "?" : "✗"} ${where}`;
}

/** Routes each finding: errors to stderr, warnings and unknowns to stdout. */
function reportIssues(lines: Lines, page: string, issues: readonly { severity: string; message: string }[], prefix: string) {
  for (const found of issues) {
    const message = `${prefix}${found.message}`;
    if (found.severity === "error") lines.err.push(`✗ ${page} ${message}`);
    else lines.out.push(`  ${SYMBOL[found.severity] ?? "!"} ${message}`);
  }
}

/** One summary line per evaluated crawler; the findings themselves are printed as issues. */
function crawlerLine(crawler: RemotePageCrawlerReport): string {
  const who = crawler.platform ? `${crawler.token} (${crawler.platform})` : crawler.token;
  const count = crawler.checks.length;
  const urls = `${count} URL${count === 1 ? "" : "s"}`;
  if (crawler.allowed === null) return `  ? robots.txt: could not evaluate ${who} for every one of ${urls}`;
  if (crawler.allowed) return `  ✓ robots.txt allows ${who} on ${urls}`;
  const denied = crawler.checks.filter((check) => check.allowed === false).length;
  const symbol = crawler.robots === "honors" || crawler.robots === "requested" ? "✗" : "!";
  const note = crawler.robots === "ignores" ? ", which documents that it ignores robots.txt" : "";
  return `  ${symbol} robots.txt disallows ${who} on ${denied} of ${urls}${note}`;
}

function describePage(page: string, report: RemotePageVerification): Lines & { failed: boolean } {
  const compatible = Object.values(report.targets).every((target) => target.compatible);
  const failed = !report.valid || !compatible;
  const redirected = report.finalUrl !== report.url ? `, final URL ${report.finalUrl}` : "";
  const count = report.images.length;
  const lines: Lines = {
    out: [`${failed ? "✗" : "✓"} ${page} (${count} image reference${count === 1 ? "" : "s"}${redirected})`],
    err: [],
  };
  for (const crawler of report.robots?.crawlers ?? []) lines.out.push(crawlerLine(crawler));
  reportIssues(lines, page, report.globalIssues, "");
  for (const [target, targetReport] of Object.entries(report.targets)) {
    reportIssues(lines, page, targetReport.issues, `${target}: `);
  }
  for (const image of report.images) {
    lines.out.push(imageLine(image));
    const label = `${imageLabel(image)}: `;
    reportIssues(lines, page, image.globalIssues, label);
    for (const [target, targetReport] of Object.entries(image.targets)) {
      reportIssues(lines, page, targetReport.issues, `${label}${target}: `);
    }
  }
  return { ...lines, failed };
}

async function verifyPages(args: string[]) {
  const invocation = parseVerifyPageInvocation(args);
  const reports: unknown[] = [];
  const errors: string[] = [];
  let failed = 0;

  for (const raw of invocation.urls) {
    const page = redactUrl(raw);
    try {
      const report = await verifyRemotePage(raw, {
        ...invocation.fetch,
        targets: invocation.socialTargets,
        ...(invocation.crawlers ? { crawlers: invocation.crawlers } : {}),
        ...(invocation.maxFileSize !== undefined ? { maxFileSize: invocation.maxFileSize } : {}),
      });
      reports.push(report);
      const lines = describePage(page, report);
      if (lines.failed) failed += 1;
      if (!invocation.json) for (const line of lines.out) process.stdout.write(`${line}\n`);
      errors.push(...lines.err);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof RemoteImageError ? { code: error.code } : {};
      failed += 1;
      errors.push(`✗ ${page} verification failed: ${message}`);
      reports.push({ url: page, valid: false, globalIssues: [{ severity: "error", ...code, message }], targets: {}, images: [] });
    }
  }

  if (invocation.json) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, pages: reports }, null, 2)}\n`);
  } else if (failed > 0) {
    for (const line of errors) process.stderr.write(`${line}\n`);
    process.stderr.write(`${failed} of ${invocation.urls.length} pages failed verification\n`);
  }
  if (failed > 0) process.exitCode = 1;
}

const COMMANDS = new Map<string, { run: (args: string[]) => Promise<void>; usage: string }>([
  ["verify-url", { run: verifyUrls, usage: VERIFY_URL_USAGE }],
  ["verify-page", { run: verifyPages, usage: VERIFY_PAGE_USAGE }],
  ["render", { run: runRender, usage: RENDER_USAGE }],
  ["preview", { run: runPreview, usage: PREVIEW_USAGE }],
]);

async function main(args: string[]) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(CLI_HELP);
    return;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    process.stdout.write(`${METAPLATE_VERSION}\n`);
    return;
  }
  const command = COMMANDS.get(args[0] ?? "");
  // `<command> --help` prints that command's usage and succeeds.
  if ((command || args[0] === "verify") && args.slice(1).some((arg) => arg === "--help" || arg === "-h")) {
    process.stdout.write(`${command?.usage ?? VERIFY_USAGE}\n`);
    return;
  }
  await (command ? command.run(args) : verifyFiles(args));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  // Argument errors already end with the command's usage; print it only once.
  const usage = COMMANDS.get(process.argv[2] ?? "")?.usage ?? VERIFY_USAGE;
  if (!(error instanceof ReportedError) && !message.endsWith(usage)) {
    process.stderr.write(`${usage}\n`);
  }
  process.exitCode = 1;
});
