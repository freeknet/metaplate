/**
 * Not an entry point: every `metaplate` command, run by the binary
 * (`main.ts`) and by `runCli` from `metaplate/cli`.
 */

import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
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
  type BaselineOptions,
  type VerifyTarget,
} from "./args.js";
import { expandVerifyOperand, verifyOperandBase } from "./expand.js";
import { compareImages } from "../image/compare.js";
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
import { markFailed, withCliIo, writeStderr, writeStdout, type CliWriter } from "./io.js";

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

verify baseline options:
  --baseline DIR     Compare each PNG or JPEG with the file at the same relative path in DIR;
                     fail a changed card, a card with no baseline, and a baseline with no card
  --max-diff PCT     Pass a card when at most PCT% of its pixels changed (default 0)
  --threshold N      Count a pixel as changed when a channel moves more than N of 255
                     (default 0 for PNG, 16 when either side is JPEG)
  --write-diff DIR   Write baseline | current | changes side by side as DIR/<path>.png
  --update-baseline  Rewrite DIR from the current files instead of failing

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
  /** Errors found after the image itself verified, such as a baseline difference. */
  issues?: CliIssue[];
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

/** Findings that belong to no one check, such as baseline files with no current file. */
type Afterword = { failures: string[]; lines: string[]; json: Record<string, unknown> };

/** Runs every check, reports each outcome, and sets the exit code once. */
async function runChecks(
  checks: readonly Check[],
  options: SocialOptions,
  listKey: string,
  noun: string,
  after?: () => Promise<Afterword>,
) {
  const failures: string[] = [];
  const failed = new Set<string>();
  const reports: JsonReport[] = [];

  for (const check of checks) {
    try {
      const loaded = await check.load();
      const social = socialReports(check, loaded, options);
      const { targets } = social;
      const globalIssues = [...social.globalIssues, ...(loaded.issues ?? [])];
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
        writeStdout(`✓ ${check.name} ${check.size.width}x${check.size.height}${loaded.note ?? ""}\n`);
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

  const afterword = after ? await after() : { failures: [], lines: [], json: {} };
  if (options.json) {
    writeStdout(`${JSON.stringify({ schemaVersion: 1, [listKey]: reports, ...afterword.json }, null, 2)}\n`);
  } else {
    for (const line of afterword.lines) writeStdout(`${line}\n`);
    for (const failure of [...failures, ...afterword.failures]) writeStderr(`${failure}\n`);
    if (failed.size > 0) writeStderr(`${failed.size} of ${checks.length} ${noun} failed verification\n`);
  }

  if (failures.length > 0 || afterword.failures.length > 0) markFailed();
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

/** A file to verify, with its path relative to its operand's base for baseline matching. */
type FileTarget = VerifyTarget & { relative: string };

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

async function readOptional(file: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function writeCreating(file: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

const percent = (ratio: number) => `${Math.round(ratio * 10_000) / 100}%`;

/**
 * `--baseline`: compares one verified file with its baseline. A card with
 * no baseline, or one that changed more than `--max-diff`, is an error unless
 * `--update-baseline` rewrites the baseline from it.
 */
async function compareWithBaseline(bytes: Uint8Array, relative: string, options: BaselineOptions): Promise<Partial<Loaded>> {
  const file = path.join(options.dir, relative);
  const shown = formatVerifyPath(file);
  const previous = await readOptional(file);
  if (!previous) {
    if (options.update) {
      await writeCreating(file, bytes);
      return { details: { baseline: { file: shown, status: "added" } }, note: " (added to the baseline)" };
    }
    return {
      details: { baseline: { file: shown, status: "missing-baseline" } },
      issues: [{ severity: "error", code: "baseline_missing", message: `has no baseline at ${shown}; --update-baseline adds it` }],
    };
  }

  const comparison = compareImages(previous, bytes, {
    ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
    diffImage: options.writeDiff !== undefined,
  });
  const exceeded = comparison.changedRatio > options.maxDiff;
  let diff: string | undefined;
  if (comparison.diffImage && comparison.changedPixels > 0) {
    const target = path.join(options.writeDiff!, relative.replace(/\.[^./\\]+$/, "") + ".png");
    await writeCreating(target, comparison.diffImage);
    diff = formatVerifyPath(target);
  }
  let status = comparison.changedPixels === 0 ? "unchanged" : exceeded ? "changed" : "within";
  if (options.update && comparison.changedPixels > 0) {
    await writeCreating(file, bytes);
    status = "updated";
  }
  const { baseline, current, sameSize, threshold, changedPixels, changedRatio, meanDifference, maxDifference } = comparison;
  const details = {
    baseline: {
      file: shown,
      status,
      sameSize,
      threshold,
      changedPixels,
      changedRatio,
      meanDifference,
      maxDifference,
      ...(diff ? { diff } : {}),
    },
  };
  const changed = sameSize
    ? `${percent(changedRatio)} of pixels changed by more than ${threshold}/255`
    : `is ${current.width}x${current.height}, its baseline ${baseline.width}x${baseline.height}`;
  const diffNote = diff ? `; diff at ${diff}` : "";
  if (status === "updated") return { details, note: ` (baseline updated: ${changed})` };
  if (status === "unchanged") return { details, note: " (matches the baseline)" };
  if (status === "within") return { details, note: ` (${changed}, within --max-diff${diffNote})` };
  return {
    details,
    issues: [{
      severity: "error",
      code: "baseline_changed",
      message: `differs from ${shown}: ${changed} (--max-diff ${percent(options.maxDiff)})${diffNote}`,
    }],
  };
}

/** Baseline files no current file matched: errors, or removed by `--update-baseline`. */
async function unmatchedBaselines(options: BaselineOptions, matched: ReadonlySet<string>): Promise<Afterword> {
  let files: string[] = [];
  try {
    files = await expandVerifyOperand(options.dir, undefined);
  } catch {
    // No baseline directory, or one with no images: nothing is unmatched.
  }
  const unmatched = files.filter((file) => !matched.has(path.relative(options.dir, file).split(path.sep).join("/")));
  const shown = unmatched.map((file) => formatVerifyPath(file));
  if (options.update) {
    const root = path.resolve(options.dir);
    for (const file of unmatched) {
      await rm(file);
      // Remove the directories the file leaves empty, up to the baseline itself.
      for (let directory = path.dirname(path.resolve(file)); directory.startsWith(root + path.sep);) {
        if ((await readdir(directory)).length > 0) break;
        await rmdir(directory);
        directory = path.dirname(directory);
      }
    }
    return {
      failures: [],
      lines: shown.map((file) => `✓ ${file} removed from the baseline: no current file matches it`),
      json: { baseline: { removed: shown, unmatched: [] } },
    };
  }
  return {
    failures: shown.map((file) => `✗ ${file} has no current file; --update-baseline removes it`),
    lines: [],
    json: { baseline: { removed: [], unmatched: shown } },
  };
}

async function verifyFiles(args: string[]) {
  const invocation = parseVerifyInvocation(args);
  const { baseline } = invocation;
  // Directories and globs become files; a file named twice is checked once.
  const seen = new Set<string>();
  const targets: FileTarget[] = [];
  const relatives = new Map<string, string>();
  for (const target of invocation.targets) {
    const base = await verifyOperandBase(target.file);
    for (const file of await expandVerifyOperand(target.file, target.format)) {
      const key = path.resolve(file);
      if (seen.has(key)) continue;
      seen.add(key);
      const relative = path.relative(base, file).split(path.sep).join("/");
      const other = relatives.get(relative);
      if (baseline && other !== undefined) {
        throw new Error(
          `${formatVerifyPath(other)} and ${formatVerifyPath(file)} both match ${relative} in the baseline; ` +
            "name their common directory instead",
        );
      }
      relatives.set(relative, file);
      targets.push({ ...target, file, relative });
    }
  }
  const checks = targets.map((target): Check => {
    const name = formatVerifyPath(target.file);
    return {
      name,
      identity: { file: name },
      size: target.size,
      load: async () => {
        const bytes = await readFile(target.file);
        const dimensions = verifyImage(bytes, target.size, target.format);
        if (invocation.requireContent) assertContent(bytes, dimensions.format);
        const compared = baseline ? await compareWithBaseline(bytes, target.relative, baseline) : {};
        return {
          bytes,
          dimensions,
          ...(invocation.url !== undefined ? { metadataUrl: invocation.url } : {}),
          ...compared,
        };
      },
    };
  });
  const after = baseline ? () => unmatchedBaselines(baseline, new Set(relatives.keys())) : undefined;
  return runChecks(checks, invocation, "files", "files", after);
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
      if (!invocation.json) for (const line of lines.out) writeStdout(`${line}\n`);
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
    writeStdout(`${JSON.stringify({ schemaVersion: 1, pages: reports }, null, 2)}\n`);
  } else if (failed > 0) {
    for (const line of errors) writeStderr(`${line}\n`);
    writeStderr(`${failed} of ${invocation.urls.length} pages failed verification\n`);
  }
  if (failed > 0) markFailed();
}

const COMMANDS = new Map<string, { run: (args: string[]) => Promise<void>; usage: string }>([
  ["verify-url", { run: verifyUrls, usage: VERIFY_URL_USAGE }],
  ["verify-page", { run: verifyPages, usage: VERIFY_PAGE_USAGE }],
  ["render", { run: runRender, usage: RENDER_USAGE }],
  ["preview", { run: runPreview, usage: PREVIEW_USAGE }],
]);

async function main(args: string[]) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    writeStdout(CLI_HELP);
    return;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    writeStdout(`${METAPLATE_VERSION}\n`);
    return;
  }
  const command = COMMANDS.get(args[0] ?? "");
  // `<command> --help` prints that command's usage and succeeds.
  if ((command || args[0] === "verify") && args.slice(1).some((arg) => arg === "--help" || arg === "-h")) {
    writeStdout(`${command?.usage ?? VERIFY_USAGE}\n`);
    return;
  }
  await (command ? command.run(args) : verifyFiles(args));
}

/** Runs one command; an error is reported as the binary reports it. */
async function run(args: string[]): Promise<void> {
  try {
    await main(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`${message}\n`);
    // Argument errors already end with the command's usage; print it only once.
    const usage = COMMANDS.get(args[0] ?? "")?.usage ?? VERIFY_USAGE;
    if (!(error instanceof ReportedError) && !message.endsWith(usage)) {
      writeStderr(`${usage}\n`);
    }
    markFailed();
  }
}

/** Where `runCli` writes. Each defaults to the matching process stream. */
export type RunCliOptions = {
  stdout?: CliWriter;
  stderr?: CliWriter;
};

/**
 * Runs a `metaplate` command in this process, without a shell or a child
 * process, and resolves to its exit code: `0` on success, `1` on any failure.
 * `args` are the arguments after `metaplate`, such as
 * `["verify", "--size", "1200x630", "out/og"]`. Output is what the binary
 * prints, written to `stdout` and `stderr`; with `--json`, `stdout` receives
 * the one JSON report. `process.exitCode` is left alone, and concurrent calls
 * keep separate output and exit codes. `preview` serves until the process
 * receives SIGINT or SIGTERM, so its promise settles only then.
 */
export function runCli(args: readonly string[], options: RunCliOptions = {}): Promise<number> {
  return withCliIo(
    { stdout: options.stdout ?? process.stdout, stderr: options.stderr ?? process.stderr },
    () => run([...args]),
  );
}

/** The binary's entry: runs against the process streams and `process.exitCode`. */
export function runBinary(args: string[]): Promise<void> {
  return run(args);
}
