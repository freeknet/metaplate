import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as nodeModule from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { SocialTarget } from "./compatibility-profiles.js";
import { verifyImage } from "./image.js";
import {
  galleryHtml,
  PREVIEW_SCRIPT,
  PREVIEW_STYLES,
  type PreviewFinding,
  type PreviewImage,
  type PreviewRendered,
} from "./preview-page.js";
import {
  mapConcurrent,
  planImages,
  resolveRenderJobs,
  type PlannedImage,
  type RenderFileArtifact,
} from "./render-files.js";
import { verifySocialImage } from "./social-verification.js";

/**
 * Not an entry point: the engine behind `metaplate preview`. It loads a
 * render module through the same contract and planner as `metaplate render`,
 * renders on request instead of writing files, and reloads when the module
 * or a local file it imports changes.
 */

/** The query parameter that gives each load of the module, and its local imports, a fresh URL. */
export const PREVIEW_QUERY = "metaplate-preview";

/**
 * Where a module imported by a preview load should resolve. Node caches ES
 * modules by URL, so tagging the entry with `?metaplate-preview=N` loads a
 * fresh entry but its own imports would still resolve to their cached,
 * untagged URLs. Propagating the tag to local `file:` imports reloads them
 * too; packages under `node_modules` keep their cached instance. Returns
 * `undefined` to leave a resolution alone.
 */
export function tagLocalImport(url: string, parentURL: string | undefined): string | undefined {
  if (parentURL === undefined || !url.startsWith("file:") || !parentURL.startsWith("file:")) return undefined;
  const generation = new URL(parentURL).searchParams.get(PREVIEW_QUERY);
  if (generation === null) return undefined;
  const target = new URL(url);
  if (target.pathname.includes("/node_modules/") || target.searchParams.has(PREVIEW_QUERY)) return undefined;
  target.searchParams.set(PREVIEW_QUERY, generation);
  return target.href;
}

type ResolveResult = { url: string };
type ResolveContext = { parentURL?: string | undefined; conditions?: readonly string[] };
type SyncHooks = {
  resolve: (
    specifier: string,
    context: ResolveContext,
    nextResolve: (specifier: string, context?: ResolveContext) => ResolveResult,
  ) => ResolveResult;
};
type RegisterHooks = (hooks: SyncHooks) => { deregister(): void };

/**
 * Installs an in-thread `module.registerHooks` resolve hook (Node 22.15 and
 * 23.5 or newer) that tags a preview load's local imports and reports each
 * one's path. Returns `undefined` where the API is missing, in which case
 * only the entry file reloads.
 */
export function trackLocalImports(onFile: (file: string) => void): (() => void) | undefined {
  const register = (nodeModule as unknown as { registerHooks?: RegisterHooks }).registerHooks;
  if (typeof register !== "function") return undefined;
  const hooks = register({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      // CommonJS caches by file name, not URL, so a tag cannot reload it.
      if (context.conditions?.includes("require")) return result;
      const tagged = tagLocalImport(result.url, context.parentURL);
      if (tagged === undefined) return result;
      onFile(fileURLToPath(tagged));
      return { ...result, url: tagged };
    },
  });
  return () => hooks.deregister();
}

/** Groups files by directory: a directory watch survives the rename an atomic save makes. */
export function watchTargets(files: Iterable<string>): Map<string, Set<string>> {
  const directories = new Map<string, Set<string>>();
  for (const file of files) {
    const resolved = path.resolve(file);
    const directory = path.dirname(resolved);
    const names = directories.get(directory) ?? new Set<string>();
    names.add(path.basename(resolved));
    directories.set(directory, names);
  }
  return directories;
}

/** Watches each file through its directory and calls `onChange` for any event on one of them. */
export function watchFiles(files: Iterable<string>, onChange: (file: string) => void): () => void {
  const watchers: FSWatcher[] = [];
  for (const [directory, names] of watchTargets(files)) {
    try {
      const watcher = watch(directory, (_event, filename) => {
        // Some platforms omit the file name; treat that as a possible change.
        if (filename === null) onChange(directory);
        else if (names.has(filename.toString())) onChange(path.join(directory, filename.toString()));
      });
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      // A directory that no longer exists has nothing to watch.
    }
  }
  return () => {
    for (const watcher of watchers) watcher.close();
  };
}

export type ReloadScheduler = {
  /** Requests a reload; bursts within the delay collapse into one. */
  schedule(): void;
  /** Settles once no reload is running or waiting. */
  idle(): Promise<void>;
  cancel(): void;
};

/**
 * Debounces reload requests: an editor save is often several file events,
 * and a request that arrives while a reload runs queues exactly one more, so
 * the last save always wins and loads never overlap. `reload` must not reject.
 */
export function createReloadScheduler(reload: () => Promise<void>, delayMs = 75): ReloadScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let queued = false;
  const waiters: (() => void)[] = [];

  function settle() {
    if (timer === undefined && running === undefined && !queued) {
      for (const resolve of waiters.splice(0)) resolve();
    }
  }
  function run() {
    timer = undefined;
    if (running !== undefined) {
      queued = true;
      return;
    }
    running = reload().finally(() => {
      running = undefined;
      if (queued) {
        queued = false;
        schedule();
      }
      settle();
    });
  }
  function schedule() {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(run, delayMs);
  }
  return {
    schedule,
    idle: () => new Promise<void>((resolve) => {
      waiters.push(resolve);
      settle();
    }),
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      queued = false;
      settle();
    },
  };
}

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** True for an address or name that only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return bare === "localhost" || bare === "::1" || LOOPBACK_V4.test(bare) || bare === "::ffff:127.0.0.1";
}

/**
 * Rejects a request whose `Host` header names anything but this machine while
 * the server listens on loopback, so a page on another site cannot read the
 * gallery through a DNS-rebound name.
 */
export function isAllowedHostHeader(header: string | undefined, listenHost: string): boolean {
  if (!isLoopbackHost(listenHost)) return true;
  if (header === undefined) return false;
  const name = header.startsWith("[") ? header.slice(0, header.indexOf("]") + 1) : header.replace(/:\d*$/, "");
  return isLoopbackHost(name);
}

export type PreviewServerOptions = {
  /** The module as the user named it, for display. */
  module: string;
  /** The module file; watched, along with every local file a load reports. */
  entry: string;
  /** Imports the module for one generation and reports each local file it loaded. */
  load: (generation: number, track: (file: string) => void) => Promise<unknown>;
  host: string;
  port: number;
  /** Whether `load` reports imported files; shown in the page when it cannot. */
  tracksImports?: boolean;
  socialTargets?: readonly SocialTarget[];
  maxFileSize?: number;
  /** Replaces `fs.watch`, for tests. */
  watch?: (files: Iterable<string>, onChange: (file: string) => void) => () => void;
  log?: (line: string) => void;
};

export type PreviewServer = {
  url: string;
  host: string;
  port: number;
  /** The load generation now served; starts at 1. */
  generation(): number;
  /** Reloads the module now, as a file change does, and resolves once it has. */
  reload(): Promise<void>;
  close(): Promise<void>;
};

type Snapshot = {
  generation: number;
  version: string;
  loadedAt: Date;
  error: string | undefined;
  images: PlannedImage[];
  renders: Map<number, Promise<{ result: PreviewImage["result"]; bytes?: Uint8Array }>>;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findingsFor(
  artifact: RenderFileArtifact,
  alt: string | undefined,
  options: Pick<PreviewServerOptions, "socialTargets" | "maxFileSize">,
): PreviewFinding[] {
  const targets = options.socialTargets ?? [];
  if (targets.length === 0 && options.maxFileSize === undefined) return [];
  const report = verifySocialImage(artifact.bytes, {
    url: artifact.metadata.openGraph.images[0]!.url,
    ...(alt === undefined ? {} : { alt }),
    width: artifact.size.width,
    height: artifact.size.height,
    type: artifact.contentType,
  }, {
    targets: [...targets],
    ...(options.maxFileSize === undefined ? {} : { maxFileSize: options.maxFileSize }),
  });
  const shared = report.issues.filter((found) => found.target === undefined);
  const findings: PreviewFinding[] = shared.length === 0 ? [] : [{
    target: "metadata",
    compatible: !shared.some((found) => found.severity === "error"),
    issues: shared,
  }];
  for (const target of targets) {
    const issues = report.issues.filter((found) => found.target === target);
    findings.push({ target, compatible: !issues.some((found) => found.severity === "error"), issues });
  }
  return findings;
}

async function renderPlanned(
  image: PlannedImage,
  options: Pick<PreviewServerOptions, "socialTargets" | "maxFileSize">,
): Promise<{ result: PreviewImage["result"]; bytes?: Uint8Array }> {
  try {
    const artifact = await image.plate.artifact(image.route, image.copy);
    const format = artifact.format ?? null;
    // The same check `metaplate render` makes on the written file.
    if (format !== null) verifyImage(artifact.bytes, artifact.size, format);
    const first = artifact.metadata.openGraph.images[0];
    if (first === undefined) throw new Error("the artifact metadata names no image URL");
    const { alt: declared } = first as { alt?: unknown };
    const alt = typeof declared === "string" ? declared : undefined;
    const result: PreviewRendered = {
      ok: true,
      url: first.url,
      alt,
      size: { width: artifact.size.width, height: artifact.size.height },
      format,
      contentType: artifact.contentType,
      bytes: artifact.bytes.byteLength,
      debuggable: typeof image.plate.renderSvg === "function",
      // An unrecognizable encoder format cannot be measured, so it is not profiled.
      findings: format === null ? [] : findingsFor(artifact, alt, options),
    };
    return { result, bytes: artifact.bytes };
  } catch (error) {
    return { result: { ok: false, message: message(error) } };
  }
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

/**
 * Same-origin script, style, image, and event-stream requests only: no
 * inline script or style, no framing, no forms, no plugins. Card geometry is
 * carried in SVG attributes so no inline style is needed.
 */
export const GALLERY_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Applied to every image, so an image opened on its own tab cannot run anything. */
const IMAGE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox";

function send(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string | Uint8Array,
) {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  response.writeHead(status, { ...SECURITY_HEADERS, ...headers, "Content-Length": String(bytes.byteLength) });
  response.end(request.method === "HEAD" ? undefined : bytes);
}

function sendText(request: IncomingMessage, response: ServerResponse, status: number, text: string) {
  send(request, response, status, { "Content-Type": "text/plain; charset=utf-8" }, `${text}\n`);
}

function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/** Starts the preview server once the module's first load has settled. */
export async function startPreviewServer(options: PreviewServerOptions): Promise<PreviewServer> {
  const log = options.log ?? (() => undefined);
  const watchFn = options.watch ?? watchFiles;
  const boot = randomUUID();
  const clients = new Set<ServerResponse>();
  let stopWatching: () => void = () => undefined;
  let snapshot: Snapshot;
  let generation = 0;

  async function load(): Promise<void> {
    generation += 1;
    const files = new Set([path.resolve(options.entry)]);
    const next: Snapshot = {
      generation,
      version: `${boot}:${generation}`,
      loadedAt: new Date(),
      error: undefined,
      images: [],
      renders: new Map(),
    };
    try {
      const jobs = await resolveRenderJobs(await options.load(generation, (file) => files.add(path.resolve(file))));
      // Paths are planned as `metaplate render` plans them, so a route it would
      // refuse fails here too; nothing is written.
      next.images = planImages(jobs, process.cwd());
      log(`↻ ${options.module}: ${next.images.length} image${next.images.length === 1 ? "" : "s"} (generation ${generation})`);
    } catch (error) {
      next.error = message(error);
      log(`✗ ${options.module}: ${next.error}`);
    }
    snapshot = next;
    stopWatching();
    stopWatching = watchFn(files, () => scheduler.schedule());
    for (const client of clients) client.write(`event: version\ndata: ${next.version}\n\n`);
  }

  const scheduler = createReloadScheduler(load);
  await load();

  function rendered(current: Snapshot, index: number) {
    let pending = current.renders.get(index);
    if (pending === undefined) {
      pending = renderPlanned(current.images[index]!, options);
      current.renders.set(index, pending);
    }
    return pending;
  }

  async function gallery(request: IncomingMessage, response: ServerResponse) {
    const current = snapshot;
    const results = await mapConcurrent(current.images, 4, (_, index) => rendered(current, index));
    const html = galleryHtml({
      module: options.module,
      version: current.version,
      generation: current.generation,
      loadedAt: current.loadedAt,
      error: current.error,
      images: current.images.map((image, index): PreviewImage => ({
        index,
        path: image.path,
        route: image.route,
        variant: image.variant,
        result: results[index]!.result,
      })),
      targets: options.socialTargets ?? [],
      tracksImports: options.tracksImports ?? true,
    });
    send(request, response, 200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": GALLERY_CSP }, html);
  }

  function events(request: IncomingMessage, response: ServerResponse) {
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
    });
    // The current version first, so a page rendered before a reload catches up.
    response.write(`retry: 1000\nevent: version\ndata: ${snapshot.version}\n\n`);
    clients.add(response);
    request.on("close", () => clients.delete(response));
  }

  async function image(request: IncomingMessage, response: ServerResponse, index: number, debug: boolean) {
    const current = snapshot;
    const planned = current.images[index];
    if (planned === undefined) return sendText(request, response, 404, "No such image in the current module");
    if (debug) {
      if (typeof planned.plate.renderSvg !== "function") {
        return sendText(request, response, 404, "This plate has no renderSvg(), which the debug view needs");
      }
      try {
        const svg = await planned.plate.renderSvg(planned.copy, { debug: true });
        return send(request, response, 200, { "Content-Type": "image/svg+xml; charset=utf-8", "Content-Security-Policy": IMAGE_CSP }, svg);
      } catch (error) {
        return sendText(request, response, 500, message(error));
      }
    }
    const { result, bytes } = await rendered(current, index);
    if (!result.ok || bytes === undefined) return sendText(request, response, 500, result.ok ? "No bytes" : result.message);
    send(request, response, 200, { "Content-Type": result.contentType, "Content-Security-Policy": IMAGE_CSP }, bytes);
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (!isAllowedHostHeader(request.headers.host, options.host)) {
      return sendText(request, response, 403, "The preview only answers requests addressed to this machine");
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      return sendText(request, response, 405, "Method not allowed");
    }
    const { pathname } = new URL(request.url ?? "/", "http://preview.invalid");
    if (pathname === "/") return gallery(request, response);
    if (pathname === "/events") return events(request, response);
    if (pathname === "/assets/preview.js") {
      return send(request, response, 200, { "Content-Type": "text/javascript; charset=utf-8" }, PREVIEW_SCRIPT);
    }
    if (pathname === "/assets/preview.css") {
      return send(request, response, 200, { "Content-Type": "text/css; charset=utf-8" }, PREVIEW_STYLES);
    }
    const match = /^\/(image|debug)\/(\d{1,9})(\.svg)?$/.exec(pathname);
    if (match && (match[1] === "debug") === (match[3] !== undefined)) {
      return image(request, response, Number(match[2]), match[1] === "debug");
    }
    sendText(request, response, 404, "Not found");
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      // A failure after the headers went out can only end the response.
      if (response.headersSent) response.end();
      else sendText(request, response, 500, message(error));
    });
  });
  const keepAlive = setInterval(() => {
    for (const client of clients) client.write(": keep-alive\n\n");
  }, 30_000);
  keepAlive.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    stopWatching();
    clearInterval(keepAlive);
    const code = (error as { code?: unknown }).code;
    if (code === "EADDRINUSE") {
      throw new Error(
        `Port ${options.port} on ${options.host} is already in use; pass --port with a free port, or --port 0 to let the system choose one`,
        { cause: error },
      );
    }
    throw error;
  }
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${urlHost(options.host)}:${port}/`,
    host: options.host,
    port,
    generation: () => snapshot.generation,
    async reload() {
      scheduler.schedule();
      await scheduler.idle();
    },
    async close() {
      scheduler.cancel();
      await scheduler.idle();
      stopWatching();
      clearInterval(keepAlive);
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
