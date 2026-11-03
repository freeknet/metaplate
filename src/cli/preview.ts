import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { writeStderr, writeStdout } from "./io.js";
import { formatVerifyPath, parsePreviewInvocation } from "./args.js";
import { ReportedError } from "./render.js";
import {
  isLoopbackHost,
  PREVIEW_QUERY,
  startPreviewServer,
  trackLocalImports,
} from "../preview/server.js";
import { importRenderModule } from "../render/files.js";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `metaplate preview`: serves a gallery of every page and size a render
 * module declares, rendered on request, and reloads open pages when the
 * module or a local file it imports changes. Runs until interrupted.
 */
export async function runPreview(args: string[]): Promise<void> {
  const invocation = parsePreviewInvocation(args);
  const entry = path.resolve(invocation.module);
  if (!existsSync(entry)) throw new ReportedError(`Cannot find render module ${invocation.module}`);

  if (!isLoopbackHost(invocation.host)) {
    writeStderr(
      `! --host ${invocation.host} makes the preview reachable from other machines. It has no ` +
        "authentication and renders your module's pages for anyone who can connect; use it only on a trusted network.\n",
    );
  }

  // Imports are reported only while a load runs; loads never overlap.
  let track: ((file: string) => void) | undefined;
  const stopTracking = trackLocalImports((file) => track?.(file));
  const display = formatVerifyPath(invocation.module);

  let server;
  try {
    server = await startPreviewServer({
      module: display,
      entry,
      host: invocation.host,
      port: invocation.port,
      tracksImports: stopTracking !== undefined,
      socialTargets: invocation.socialTargets,
      ...(invocation.maxFileSize === undefined ? {} : { maxFileSize: invocation.maxFileSize }),
      log: (line) => writeStderr(`${line}\n`),
      async load(generation, report) {
        track = report;
        try {
          return await importRenderModule(invocation.module, `?${PREVIEW_QUERY}=${generation}`);
        } finally {
          track = undefined;
        }
      },
    });
  } catch (error) {
    stopTracking?.();
    throw new ReportedError(messageOf(error), { cause: error });
  }

  // A plate's stray promise must not take the server down with it.
  process.on("unhandledRejection", (reason) => {
    writeStderr(`✗ Unhandled rejection: ${messageOf(reason)}\n`);
  });
  if (stopTracking === undefined) {
    writeStderr(
      `! Node ${process.versions.node} has no module.registerHooks (added in 22.15 and 23.5), so only ` +
        `${display} itself reloads on change; restart after editing a file it imports.\n`,
    );
  }
  writeStdout(`metaplate preview of ${display} at ${server.url}\n`);

  const running = server;
  await new Promise<void>((resolve) => {
    const stop = () => {
      void running.close().then(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  stopTracking?.();
}
