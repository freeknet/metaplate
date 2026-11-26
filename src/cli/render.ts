import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { markFailed, writeStderr, writeStdout } from "./io.js";
import { formatVerifyPath, parseRenderInvocation } from "./args.js";
import {
  importRenderModule,
  peerVersions,
  planHtmlPages,
  planImages,
  preflightHtmlPages,
  readPreviousManifest,
  renderFiles,
  renderManifest,
  resolveRenderJobs,
  writeFileAtomic,
  writeHtmlPages,
  type HtmlOutcome,
  type PlannedHtmlPage,
  type RenderOutcome,
} from "../render/files.js";

/** A failure whose message is complete without the usage line. */
export class ReportedError extends Error {}

function reportOutcome(outcome: RenderOutcome): void {
  if (!outcome.valid) {
    const message = outcome.issues.map((issue) => issue.message).join("; ");
    writeStderr(`✗ ${outcome.path} render failed: ${message}\n`);
    return;
  }
  const { width, height } = outcome.size;
  const format = outcome.format ?? outcome.contentType;
  const reused = outcome.reused ? ", unchanged" : "";
  writeStdout(`✓ ${outcome.path} ${width}x${height} ${format} (${outcome.bytes} bytes${reused})\n`);
}

function reportHtmlOutcome(outcome: HtmlOutcome): void {
  if (!outcome.valid) {
    const message = outcome.issues.map((issue) => issue.message).join("; ");
    writeStderr(`✗ ${outcome.path} social tags not written: ${message}\n`);
    return;
  }
  writeStdout(`✓ ${outcome.path} social tags ${outcome.changed ? "written" : "unchanged"}\n`);
}

function warn(message: string): void {
  writeStderr(`${message}\n`);
}

/**
 * `metaplate render`: loads a render module, writes every page at every size
 * into the output directory, verifies each file on disk, and writes the
 * manifest only when the whole set succeeded. With `--incremental`, a page
 * whose input hash matches the previous manifest, and whose file still
 * matches that manifest's hash, is reused instead of rendered.
 */
export async function runRender(args: string[]): Promise<void> {
  const invocation = parseRenderInvocation(args);
  const root = process.cwd();
  let images;
  let pages: PlannedHtmlPage[];
  let previous;
  try {
    const jobs = await resolveRenderJobs(await importRenderModule(invocation.module));
    images = planImages(jobs, invocation.outDir);
    const manifestTarget = path.resolve(invocation.manifest).toLowerCase();
    const clash = images.find((image) => image.target.toLowerCase() === manifestTarget);
    if (clash) throw new Error(`The manifest path ${invocation.manifest} is also the image ${clash.path}`);
    pages = planHtmlPages(jobs, invocation.outDir, root);
    const outputs = new Map(images.map((image) => [image.target.toLowerCase(), `the image ${image.path}`]));
    outputs.set(manifestTarget, "the manifest");
    for (const page of pages) {
      const other = outputs.get(page.target.toLowerCase());
      if (other) throw new Error(`The HTML page ${page.path} is also ${other}`);
    }
    // Every page is checked before anything is written, so a malformed page
    // fails the run as a refused image path does: with nothing touched.
    await preflightHtmlPages(pages, root);
    if (invocation.incremental) previous = await readPreviousManifest(invocation.manifest, warn);
    // A manifest lists a complete, verified set or does not exist, so a
    // deploy step that trusts it can never publish half a build. Once this
    // run may write files, the previous run's manifest no longer describes
    // them, so it goes before the first render; a successful run writes the
    // new one.
    await rm(invocation.manifest, { force: true });
  } catch (error) {
    throw new ReportedError(error instanceof Error ? error.message : String(error), { cause: error });
  }

  const outcomes = await renderFiles(images, {
    outDir: invocation.outDir,
    concurrency: invocation.concurrency,
    peers: await peerVersions(invocation.module),
    checks: {
      targets: invocation.socialTargets,
      ...(invocation.maxFileSize === undefined ? {} : { maxFileSize: invocation.maxFileSize }),
    },
    ...(previous ? { previous } : {}),
    ...(invocation.json ? {} : { onOutcome: reportOutcome }),
  });
  const rendered = outcomes.filter((outcome): outcome is Extract<RenderOutcome, { valid: true }> => outcome.valid);
  const failedImages = outcomes.length - rendered.length;
  const reused = rendered.filter((outcome) => outcome.reused).length;
  // Each page's HTML is written only once all of its images have succeeded.
  const htmlOutcomes = await writeHtmlPages(pages, outcomes, root, invocation.json ? undefined : reportHtmlOutcome);
  const failedPages = htmlOutcomes.filter((outcome) => !outcome.valid).length;
  const changedPages = htmlOutcomes.filter((outcome) => outcome.valid && outcome.changed).length;
  const failed = failedImages + failedPages;

  if (failed === 0) {
    await writeFileAtomic(invocation.manifest, `${JSON.stringify(renderManifest(rendered), null, 2)}\n`);
  }

  const out = formatVerifyPath(invocation.outDir);
  const manifest = formatVerifyPath(invocation.manifest);
  if (invocation.json) {
    const report = {
      schemaVersion: 1,
      out,
      manifest: failed === 0 ? manifest : null,
      images: outcomes,
      ...(pages.length === 0 ? {} : { html: htmlOutcomes }),
    };
    writeStdout(`${JSON.stringify(report, null, 2)}\n`);
  } else if (failed > 0) {
    if (failedImages > 0) writeStderr(`${failedImages} of ${outcomes.length} images failed; no manifest was written\n`);
    if (failedPages > 0) {
      writeStderr(`${failedPages} of ${pages.length} HTML pages were not written; no manifest was written\n`);
    }
  } else if (reused > 0) {
    writeStdout(
      `Rendered ${outcomes.length - reused} and reused ${reused} unchanged of ${outcomes.length} images ` +
        `into ${out}; manifest ${manifest}\n`,
    );
  } else {
    writeStdout(`Rendered ${outcomes.length} images into ${out}; manifest ${manifest}\n`);
  }
  if (!invocation.json && failed === 0 && pages.length > 0) {
    writeStdout(`Wrote social tags into ${changedPages} of ${pages.length} HTML pages (${pages.length - changedPages} unchanged)\n`);
  }
  if (failed > 0) markFailed();
}
