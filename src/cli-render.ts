import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { formatVerifyPath, parseRenderInvocation } from "./cli-args.js";
import {
  importRenderModule,
  planImages,
  renderFiles,
  renderManifest,
  resolveRenderJobs,
  type ManifestImage,
  type RenderOutcome,
} from "./render-files.js";

/** A failure whose message is complete without the usage line. */
export class ReportedError extends Error {}

function reportOutcome(outcome: RenderOutcome): void {
  if (!outcome.valid) {
    const message = outcome.issues.map((issue) => issue.message).join("; ");
    process.stderr.write(`✗ ${outcome.path} render failed: ${message}\n`);
    return;
  }
  const { width, height } = outcome.size;
  const format = outcome.format ?? outcome.contentType;
  process.stdout.write(`✓ ${outcome.path} ${width}x${height} ${format} (${outcome.bytes} bytes)\n`);
}

/**
 * `metaplate render`: loads a render module, writes every page at every size
 * into the output directory, verifies each file on disk, and writes the
 * manifest only when the whole set succeeded.
 */
export async function runRender(args: string[]): Promise<void> {
  const invocation = parseRenderInvocation(args);
  let images;
  try {
    const jobs = await resolveRenderJobs(await importRenderModule(invocation.module));
    images = planImages(jobs, invocation.outDir);
    const manifestTarget = path.resolve(invocation.manifest).toLowerCase();
    const clash = images.find((image) => image.target.toLowerCase() === manifestTarget);
    if (clash) throw new Error(`The manifest path ${invocation.manifest} is also the image ${clash.path}`);
  } catch (error) {
    throw new ReportedError(error instanceof Error ? error.message : String(error), { cause: error });
  }

  const outcomes = await renderFiles(images, {
    outDir: invocation.outDir,
    concurrency: invocation.concurrency,
    ...(invocation.json ? {} : { onOutcome: reportOutcome }),
  });
  const rendered = outcomes.filter((outcome): outcome is RenderOutcome & ManifestImage => outcome.valid);
  const failed = outcomes.length - rendered.length;

  // A manifest lists a complete, verified set or does not exist, so a deploy
  // step that trusts it can never publish half a build.
  if (failed === 0) {
    await mkdir(path.dirname(path.resolve(invocation.manifest)), { recursive: true });
    const manifest = renderManifest(rendered);
    await writeFile(invocation.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const out = formatVerifyPath(invocation.outDir);
  const manifest = formatVerifyPath(invocation.manifest);
  if (invocation.json) {
    const report = {
      schemaVersion: 1,
      out,
      manifest: failed === 0 ? manifest : null,
      images: outcomes,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (failed > 0) {
    process.stderr.write(`${failed} of ${outcomes.length} images failed; no manifest was written\n`);
  } else {
    process.stdout.write(`Rendered ${outcomes.length} images into ${out}; manifest ${manifest}\n`);
  }
  if (failed > 0) process.exitCode = 1;
}
