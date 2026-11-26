import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ImageSize } from "../core/social-image.js";
import { verifyImage, type ImageFormat } from "../image.js";
import type { SocialTarget } from "../verify/compatibility-profiles.js";
import { verifyPlateImage } from "../verify/social-verification.js";
import { assertVersionToken } from "../metadata/image-version.js";
import { copyIdentity, taggedSerialize } from "../core/stable-hash.js";
import { METAPLATE_VERSION } from "../core/version.js";
import type { SocialMetaInput } from "../metadata/meta-tags.js";
import type { SocialMetaOptions } from "../metadata/page-tags.js";
import {
  PAGE_META_KEYS,
  assertSafeHtmlTarget,
  buildHtmlPage,
  htmlTarget,
  readHtmlPage,
  type HtmlPageSource,
} from "./html-page.js";

/**
 * Not an entry point: the engine behind `metaplate render`. Its public types
 * are re-exported from `metaplate/node` so a render module can be typed; the
 * runtime ships only inside the CLI bundle.
 */

/** What `metaplate render` reads from one rendered size of a plate. */
export type RenderFileArtifact = {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** `undefined` for an `output` encoder of a format Metaplate cannot recognize. */
  readonly format?: ImageFormat | undefined;
  readonly size: ImageSize;
  /** Metadata describing exactly these bytes; its first image URL is the published one. */
  readonly metadata: { readonly openGraph: { readonly images: readonly { readonly url: string }[] } };
};

/**
 * The plate surface `metaplate render` uses. Plates from `createNodeOg` and
 * `createEdgeOg`, and any of their `variant(name)` views, satisfy it.
 */
export type RenderablePlate<Copy> = {
  readonly variantName: string | undefined;
  readonly variants: readonly string[];
  variant(name: string): RenderablePlate<Copy>;
  sitePath(route: string): string;
  /** `options.version` is passed only when the page names one. */
  artifact(route: string, copy: Copy, options?: { version?: string }): Promise<RenderFileArtifact>;
  /**
   * What this size renders, independent of copy. Plates from `createNodeOg`
   * and `createEdgeOg` have it; without it an image gets no `inputHash` and
   * `--incremental` always renders it.
   */
  fingerprint?(): Promise<string>;
  /**
   * The image descriptor, whose URL (versioned exactly as `artifact`'s
   * metadata is) a reused file is recorded under.
   */
  image?(route: string, copy: Copy, options?: { version?: string }): { readonly url: string };
  /**
   * The page metadata, versioned exactly as `artifact`'s is. Plates from
   * `createNodeOg` and `createEdgeOg` have it; a page naming `html` needs it.
   */
  metadata?(route: string, copy: Copy, options?: { version?: string }): SocialMetaInput;
  /**
   * The Satori SVG for this size. `metaplate render` never calls it;
   * `metaplate preview` uses it, when present, to draw layout debug boxes.
   */
  renderSvg?(copy: Copy, options?: { debug?: boolean }): Promise<string>;
};

/** One page to render: its route and the copy the plate renders for it. */
export type RenderPage<Copy> = {
  /** The page's route, as passed to `plate.metadata`; defaults to `/`. */
  route?: string;
  copy: Copy;
  /**
   * An explicit cache-busting token for this page's image URLs, overriding
   * the plate's `version: "copy"`. It changes the manifest `url`, never the
   * file `path`.
   */
  version?: string;
  /**
   * A static HTML file to write this page's social `<meta>` tags into,
   * relative to the directory the command runs in. The tags go between
   * `<!-- metaplate:social -->` and `<!-- /metaplate:social -->`, or just
   * before `</head>` the first time, and are written only after every image
   * of the page has rendered.
   */
  html?: string;
  /**
   * Page-level tags for `html`: `og:title`, `og:description`, `og:url`, and
   * the rest of `SocialMetaOptions`. `url` is emitted exactly as given and is
   * the base relative image URLs resolve against.
   */
  page?: SocialMetaOptions;
};

/**
 * One plate and the pages it renders. A default plate renders its default
 * size and every declared variant per page; a `plate.variant(name)` view
 * renders only that size.
 */
export type RenderJob<Copy> = {
  plate: RenderablePlate<Copy>;
  pages: readonly RenderPage<Copy>[];
};

// `any` lets one module mix plates with different copy types; each job is
// still checked against its own plate where it is written.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyJob = RenderJob<any>;

/** What a render module's default export may be. */
export type RenderModule =
  | AnyJob
  | readonly AnyJob[]
  | (() => AnyJob | readonly AnyJob[] | Promise<AnyJob | readonly AnyJob[]>);

/** One planned image: a page rendered at one size of one plate. */
export type PlannedImage = {
  /** POSIX path relative to the output directory. */
  path: string;
  /** Absolute filesystem path the bytes are written to. */
  target: string;
  route: string;
  variant: string | null;
  plate: RenderablePlate<unknown>;
  copy: unknown;
  /** The page's explicit version token, when it names one. */
  version?: string;
};

export type ManifestImage = {
  path: string;
  /**
   * The image URL the plate's metadata publishes, including `basePath`,
   * `origin`, and any `?v=` version token.
   */
  url: string;
  route: string;
  variant: string | null;
  size: ImageSize;
  format: ImageFormat | null;
  contentType: string;
  bytes: number;
  sha256: string;
  /** False only for an encoder format the verifier cannot recognize. */
  verified: boolean;
  /**
   * SHA-256 of everything known to determine the bytes, which
   * `--incremental` compares; `null` when the plate has no `fingerprint()`
   * or the copy cannot be serialized.
   */
  inputHash: string | null;
};

export type RenderIssue = { severity: "error"; message: string };

export type RenderOutcome =
  | (ManifestImage & { valid: true; issues: RenderIssue[]; reused: boolean })
  | { path: string; route: string; variant: string | null; valid: false; issues: RenderIssue[] };

function fail(message: string): never {
  throw new Error(`Invalid render module: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const PLATE_METHODS = ["artifact", "sitePath", "variant"] as const;

function checkPlate(value: unknown, label: string): RenderablePlate<unknown> {
  if (!isObject(value)) fail(`${label}.plate must be a plate from createNodeOg or createEdgeOg`);
  for (const method of PLATE_METHODS) {
    if (typeof value[method] !== "function") {
      fail(
        `${label}.plate has no ${method}() method; metaplate render needs a plate from ` +
          "createNodeOg (metaplate/node) or createEdgeOg (metaplate/edge)",
      );
    }
  }
  if (!Array.isArray(value.variants) || !value.variants.every((name) => typeof name === "string")) {
    fail(`${label}.plate.variants must be an array of variant names`);
  }
  return value as unknown as RenderablePlate<unknown>;
}

function checkPages(value: unknown, label: string): RenderPage<unknown>[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${label}.pages must be a non-empty array`);
  return value.map((page: unknown, index) => {
    const pageLabel = `${label}.pages[${index}]`;
    if (!isObject(page) || !("copy" in page)) fail(`${pageLabel} must be an object with a copy property`);
    if (page.route !== undefined && typeof page.route !== "string") {
      fail(`${pageLabel}.route must be a string`);
    }
    if (page.version !== undefined) {
      try {
        assertVersionToken(page.version);
      } catch (error) {
        fail(`${pageLabel}.version: ${(error as Error).message}`);
      }
    }
    if (page.html !== undefined && (typeof page.html !== "string" || page.html === "")) {
      fail(`${pageLabel}.html must be a non-empty path to an HTML file`);
    }
    if (page.page !== undefined) {
      if (page.html === undefined) fail(`${pageLabel}.page has no effect without ${pageLabel}.html`);
      if (!isObject(page.page) || Array.isArray(page.page)) fail(`${pageLabel}.page must be an object`);
      const unknown = Object.keys(page.page).filter((key) => !(PAGE_META_KEYS as readonly string[]).includes(key));
      if (unknown.length > 0) {
        fail(`${pageLabel}.page has unknown field ${unknown.join(", ")}; expected ${PAGE_META_KEYS.join(", ")}`);
      }
    }
    return {
      ...(page.route === undefined ? {} : { route: page.route }),
      copy: page.copy,
      ...(page.version === undefined ? {} : { version: page.version }),
      ...(page.html === undefined ? {} : { html: page.html as string }),
      ...(page.page === undefined ? {} : { page: page.page as SocialMetaOptions }),
    };
  });
}

/**
 * Validates a render module's default export (after calling it, when it is a
 * function) and returns its jobs in declaration order.
 */
export async function resolveRenderJobs(exported: unknown): Promise<RenderJob<unknown>[]> {
  const value = typeof exported === "function" ? await (exported as () => unknown)() : exported;
  if (value === undefined) {
    fail("expected a default export: a render job, an array of jobs, or a function returning either");
  }
  const jobs: unknown[] = Array.isArray(value) ? value : [value];
  if (jobs.length === 0) fail("the default export lists no render jobs");
  return jobs.map((job, index) => {
    const label = Array.isArray(value) ? `job[${index}]` : "job";
    if (!isObject(job)) fail(`${label} must be an object with plate and pages`);
    return { plate: checkPlate(job.plate, label), pages: checkPages(job.pages, label) };
  });
}

/** Characters that are not portable in file names on Windows, macOS, and Linux. */
const UNPORTABLE = /[<>:"|?*\\/]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

/** Decodes and checks one segment of a site path for use as a file name. */
function fileSegment(segment: string, sitePath: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new Error(`Image path ${sitePath} has a malformed percent-escape`);
  }
  if (decoded === "" || decoded === "." || decoded === "..") {
    throw new Error(`Image path ${sitePath} has an empty or dot segment`);
  }
  if (UNPORTABLE.test(decoded) || CONTROL.test(decoded)) {
    throw new Error(
      `Image path ${sitePath} has a segment that is not a portable file name: ${JSON.stringify(decoded)}`,
    );
  }
  if (RESERVED.test(decoded) || /[. ]$/.test(decoded)) {
    throw new Error(`Image path ${sitePath} has a segment Windows cannot store: ${JSON.stringify(decoded)}`);
  }
  return decoded;
}

/**
 * Maps a plate's site path onto the output directory. Static hosts decode
 * percent-escapes when they map a URL onto a file, so each segment is
 * decoded; a decoded segment that could leave its directory, or that one of
 * the three major filesystems cannot hold, is refused rather than altered.
 */
export function outputTarget(outDir: string, sitePath: string): { path: string; target: string } {
  const segments = sitePath.split("/").map((segment) => fileSegment(segment, sitePath));
  const root = path.resolve(outDir);
  const target = path.resolve(root, ...segments);
  if (!isInside(root, target) || target === root) {
    throw new Error(`Image path ${sitePath} resolves outside the output directory`);
  }
  return { path: segments.join("/"), target };
}

/**
 * Expands jobs into one planned image per page and size, in declaration
 * order, and refuses two images that would land on one file, including on a
 * case-insensitive filesystem.
 */
export function planImages(jobs: readonly RenderJob<unknown>[], outDir: string): PlannedImage[] {
  const planned: PlannedImage[] = [];
  const seen = new Map<string, string>();
  for (const job of jobs) {
    const views = jobViews(job.plate);
    for (const page of job.pages) {
      const route = page.route ?? "/";
      for (const view of views) {
        const variant = view.variantName ?? null;
        // An empty route would otherwise print as nothing at all.
        const label = `${route === "" ? '""' : route}${variant === null ? "" : ` (${variant})`}`;
        const { path: relative, target } = outputTarget(outDir, view.sitePath(route));
        const key = relative.toLowerCase();
        const previous = seen.get(key);
        if (previous !== undefined) {
          throw new Error(`Invalid render module: ${label} and ${previous} both write ${relative}`);
        }
        seen.set(key, label);
        planned.push({
          path: relative,
          target,
          route,
          variant,
          plate: view,
          copy: page.copy,
          ...(page.version === undefined ? {} : { version: page.version }),
        });
      }
    }
  }
  return planned;
}

/** The sizes a job renders: a default plate's default size and every variant, or one variant view. */
function jobViews(plate: RenderablePlate<unknown>): RenderablePlate<unknown>[] {
  return plate.variantName === undefined
    ? [plate, ...plate.variants.map((name) => plate.variant(name))]
    : [plate];
}

/** One page whose social tags `metaplate render` writes into a static HTML file. */
export type PlannedHtmlPage = HtmlPageSource & {
  /** Paths, relative to the output directory, of the images this page renders. */
  images: string[];
};

/**
 * Plans every page that names an `html` file: resolves the file against
 * `root` (the directory the command runs in), takes the page's metadata from
 * its job's plate with the page's version token, and refuses two pages that
 * name one file, including on a case-insensitive filesystem.
 */
export function planHtmlPages(jobs: readonly RenderJob<unknown>[], outDir: string, root: string): PlannedHtmlPage[] {
  const planned: PlannedHtmlPage[] = [];
  const seen = new Map<string, string>();
  jobs.forEach((job, jobIndex) => {
    job.pages.forEach((page, pageIndex) => {
      if (page.html === undefined) return;
      const label = `${jobs.length === 1 ? "job" : `job[${jobIndex}]`}.pages[${pageIndex}]`;
      const route = page.route ?? "/";
      const plate = job.plate;
      if (typeof plate.metadata !== "function") {
        fail(`${label}.html needs a plate with a metadata() method, such as one from createNodeOg or createEdgeOg`);
      }
      let target: { path: string; target: string };
      try {
        target = htmlTarget(root, page.html);
      } catch (error) {
        fail(`${label}.${(error as Error).message}`);
      }
      const key = target.path.toLowerCase();
      const previous = seen.get(key);
      if (previous !== undefined) fail(`${label} and ${previous} both write ${target.path}`);
      seen.set(key, label);
      const metadata = page.version === undefined
        ? plate.metadata(route, page.copy)
        : plate.metadata(route, page.copy, { version: page.version });
      planned.push({
        ...target,
        route,
        metadata,
        page: page.page ?? {},
        images: jobViews(plate).map((view) => outputTarget(outDir, view.sitePath(route)).path),
      });
    });
  });
  return planned;
}

/**
 * Checks every planned page before anything renders: the file exists inside
 * `root`, is UTF-8, has well-formed markers or a `</head>`, its page fields are
 * valid, and a crawler would read the block. A page that fails stops the run
 * before a single write, as a refused image path does.
 */
export async function preflightHtmlPages(pages: readonly PlannedHtmlPage[], root: string): Promise<void> {
  for (const page of pages) {
    try {
      await assertSafeHtmlTarget(root, page.target);
      buildHtmlPage(page, (await readHtmlPage(page.target)).text);
    } catch (error) {
      throw new Error(`${page.path}: ${(error as Error).message}`, { cause: error });
    }
  }
}

/** What happened to one page's HTML file. */
export type HtmlOutcome =
  | { path: string; route: string; valid: true; changed: boolean; issues: RenderIssue[] }
  | { path: string; route: string; valid: false; issues: RenderIssue[] };

/**
 * Writes each page's tags once its images have all rendered and verified. A
 * page with a failed image is left exactly as it was. The page is read and
 * rebuilt at write time, and one whose bytes would not change is not written.
 * Otherwise the new text is staged beside it, read back and compared, and
 * renamed over it.
 */
export async function writeHtmlPages(
  pages: readonly PlannedHtmlPage[],
  outcomes: readonly RenderOutcome[],
  root: string,
  onOutcome?: (outcome: HtmlOutcome) => void,
): Promise<HtmlOutcome[]> {
  const byPath = new Map(outcomes.map((outcome) => [outcome.path, outcome]));
  const results: HtmlOutcome[] = [];
  for (const page of pages) {
    let outcome: HtmlOutcome;
    try {
      const images = page.images.map((image) => byPath.get(image));
      if (images.some((image) => image === undefined || !image.valid)) {
        throw new Error("left unchanged because an image of this page failed");
      }
      const published = new Set((page.metadata.openGraph?.images ?? []).map((image) => image.url));
      for (const image of images as Extract<RenderOutcome, { valid: true }>[]) {
        if (!published.has(image.url)) {
          throw new Error(`the page metadata does not list the rendered image URL ${image.url}`);
        }
      }
      await assertSafeHtmlTarget(root, page.target);
      const current = await readHtmlPage(page.target);
      const next = buildHtmlPage(page, current.text);
      const changed = next !== current.text;
      if (changed) {
        const bytes = Buffer.from(next, "utf8");
        await writeFileAtomic(page.target, bytes, async (staged) => {
          if (!(await readFile(staged)).equals(bytes)) throw new Error("the file on disk does not match the new page");
        });
      }
      outcome = { path: page.path, route: page.route, valid: true, changed, issues: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { path: page.path, route: page.route, valid: false, issues: [{ severity: "error", message }] };
    }
    onOutcome?.(outcome);
    results.push(outcome);
  }
  return results;
}

/** Runs `task` over `items` with at most `limit` in flight, keeping input order. */
export async function mapConcurrent<Item, Result>(
  items: readonly Item[],
  limit: number,
  task: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Holds an image's target to the output directory: its directory chain must
 * not leave it through a symbolic link, and an existing link at the target is
 * never written through or read.
 */
async function assertSafeTarget(image: PlannedImage, realRoot: string, action: string): Promise<void> {
  const directory = path.dirname(image.target);
  await mkdir(directory, { recursive: true });
  if (!isInside(realRoot, await realpath(directory))) {
    throw new Error(`Refusing to ${action} ${image.path}: its directory resolves outside the output directory`);
  }
  const existing = await lstat(image.target).catch(() => undefined);
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to ${action} ${image.path}: it is a symbolic link`);
  }
}

/** The peer packages whose releases change rendered bytes. */
export const RENDER_PEERS = ["satori", "@resvg/resvg-js", "@resvg/resvg-wasm"] as const;

export type PeerVersions = Readonly<Record<(typeof RENDER_PEERS)[number], string | null>>;

/** Finds `name`'s package.json from its resolved entry when the package does not export it. */
async function versionNear(resolved: string, name: string): Promise<string | null> {
  let directory = path.dirname(resolved);
  for (;;) {
    const manifest = await readFile(path.join(directory, "package.json"), "utf8").then(
      (text) => JSON.parse(text) as { name?: unknown; version?: unknown },
      () => undefined,
    );
    if (manifest?.name === name) return typeof manifest.version === "string" ? manifest.version : null;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * The installed peer versions, resolved from the render module's location as
 * its own `metaplate/node` import resolves them; `null` for one that is not
 * installed there.
 */
export async function peerVersions(moduleFile: string): Promise<PeerVersions> {
  const require = createRequire(path.resolve(moduleFile));
  const versions = await Promise.all(RENDER_PEERS.map(async (name) => {
    try {
      const manifest = JSON.parse(await readFile(require.resolve(`${name}/package.json`), "utf8")) as { version?: unknown };
      return typeof manifest.version === "string" ? manifest.version : null;
    } catch {
      try {
        return await versionNear(require.resolve(name), name);
      } catch {
        return null;
      }
    }
  }));
  return Object.fromEntries(RENDER_PEERS.map((name, index) => [name, versions[index]!])) as PeerVersions;
}

/**
 * Hashes everything known to determine an image's bytes: the CLI's Metaplate
 * version, the peer versions, the route, size, and output path, the plate's
 * own fingerprint (its version, `revision`, size, fonts, and component
 * source), and the copy as `copyIdentity` serializes it. `null` when the plate has no
 * fingerprint or the copy cannot be serialized.
 */
export async function inputHash(image: PlannedImage, peers: PeerVersions): Promise<string | null> {
  if (typeof image.plate.fingerprint !== "function") return null;
  let source: string;
  try {
    source = taggedSerialize({
      input: "metaplate-render-input/2",
      metaplate: METAPLATE_VERSION,
      peers,
      path: image.path,
      route: image.route,
      variant: image.variant,
      plate: await image.plate.fingerprint(),
      // The copy keeps its key order and rejects functions; see `copyIdentity`.
      copy: copyIdentity(image.copy),
    });
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  return createHash("sha256").update(source).digest("hex");
}

/**
 * Reuses the file a previous run wrote when its input hash is unchanged and
 * the file still hashes to what that run recorded and still passes
 * `verifyImage`. Returns `undefined` whenever it cannot prove that, so the
 * image renders instead.
 */
async function reuseImage(
  image: PlannedImage,
  previous: ManifestImage | undefined,
  hash: string | null,
  realRoot: string,
  checks: RenderTargetChecks | undefined,
): Promise<ManifestImage | undefined> {
  if (hash === null || previous?.inputHash !== hash || typeof image.plate.image !== "function") return undefined;
  await assertSafeTarget(image, realRoot, "reuse");
  const existing = await readFile(image.target).catch(() => undefined);
  if (!existing || existing.byteLength !== previous.bytes || sha256(existing) !== previous.sha256) return undefined;
  if (previous.format !== null) {
    try {
      verifyImage(existing, previous.size, previous.format);
    } catch {
      return undefined;
    }
  }
  const descriptor = image.version === undefined
    ? image.plate.image(image.route, image.copy)
    : image.plate.image(image.route, image.copy, { version: image.version });
  // Targets are not part of the input hash, so a reused file is checked again.
  assertTargets(existing, descriptor, previous.size, previous.contentType, checks);
  return { ...copyManifestImage(previous), url: descriptor.url };
}

/** The platform checks `metaplate render --target` and `--max-file-size` apply to each file. */
export type RenderTargetChecks = {
  targets: readonly SocialTarget[];
  maxFileSize?: number;
};

/**
 * Fails a file that breaks a platform's published rules, such as WhatsApp's
 * file size limit, with the same checks as `metaplate preview --target`; see
 * `verifyPlateImage` for which URLs are checked.
 */
function assertTargets(
  bytes: Uint8Array,
  descriptor: { readonly url?: unknown; readonly alt?: unknown },
  size: ImageSize,
  contentType: string,
  checks: RenderTargetChecks | undefined,
): void {
  if (checks === undefined || (checks.targets.length === 0 && checks.maxFileSize === undefined)) return;
  const report = verifyPlateImage(
    bytes,
    { url: descriptor.url, alt: descriptor.alt, width: size.width, height: size.height, type: contentType },
    checks,
  );
  const errors = report.issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors
      .map((issue) => (issue.target ? `${issue.target} compatibility failed: ${issue.message}` : issue.message))
      .join("; "));
  }
}

/** File extensions a static host maps to each image content type. */
const EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "image/avif": ["avif"],
  "image/svg+xml": ["svg"],
};

/**
 * Static hosts pick the Content-Type from the file extension, so a file
 * without one, or with another format's, is served as the wrong type and
 * fails crawlers and `verify-url` even though its bytes are valid.
 */
function assertExtension(path: string, contentType: string): void {
  const expected = EXTENSIONS[contentType.split(";", 1)[0]!.trim().toLowerCase()];
  if (expected === undefined) return;
  const name = path.split("/").pop()!;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
  if (extension === undefined) {
    throw new Error(
      `${path} has no file extension, so a static host would not serve it as ${contentType}. ` +
        `Give the plate an imagePath ending in .${expected[0]}, such as "og-image.${expected[0]}".`,
    );
  }
  if (!expected.includes(extension)) {
    throw new Error(
      `${path} ends in .${extension}, but the plate encodes ${contentType}, so a static host would ` +
        `serve it as the wrong type. End its imagePath in .${expected[0]}.`,
    );
  }
}

/**
 * Writes one image and proves the file on disk. Every check that needs only
 * the bytes runs first, so a card that fails one never touches the previous
 * file. The bytes are then staged beside the target, read back, hashed, and
 * checked with `verifyImage` again, and renamed over the target only when
 * they pass. The target must pass `assertSafeTarget`. Each image is replaced
 * atomically; a run of many images is not a transaction, which is why the
 * manifest is written only when every image succeeds.
 */
async function writeImage(
  image: PlannedImage,
  realRoot: string,
  hash: string | null,
  checks: RenderTargetChecks | undefined,
): Promise<ManifestImage> {
  const artifact = image.version === undefined
    ? await image.plate.artifact(image.route, image.copy)
    : await image.plate.artifact(image.route, image.copy, { version: image.version });
  assertExtension(image.path, artifact.contentType);
  const format = artifact.format ?? null;
  if (format !== null) verifyImage(artifact.bytes, artifact.size, format);
  const first = artifact.metadata.openGraph.images[0];
  const url = first?.url;
  if (url === undefined) throw new Error(`${image.path}: the artifact metadata names no image URL`);
  assertTargets(artifact.bytes, first!, artifact.size, artifact.contentType, checks);

  await assertSafeTarget(image, realRoot, "write");
  const digest = sha256(artifact.bytes);
  let byteLength = 0;
  await writeFileAtomic(image.target, artifact.bytes, async (staged) => {
    const written = await readFile(staged);
    if (sha256(written) !== digest) throw new Error(`${image.path} on disk does not match the rendered bytes`);
    if (format !== null) verifyImage(written, artifact.size, format);
    byteLength = written.byteLength;
  });
  return {
    path: image.path,
    url,
    route: image.route,
    variant: image.variant,
    size: { width: artifact.size.width, height: artifact.size.height },
    format,
    contentType: artifact.contentType,
    bytes: byteLength,
    sha256: digest,
    verified: format !== null,
    inputHash: hash,
  };
}

export type RenderFilesOptions = {
  outDir: string;
  concurrency: number;
  /** Called as each image settles, in completion order. */
  onOutcome?: (outcome: RenderOutcome) => void;
  /** Entries of the previous manifest by path; given, unchanged images are reused. */
  previous?: ReadonlyMap<string, ManifestImage>;
  /** Installed peer versions for `inputHash`; default all `null`. */
  peers?: PeerVersions;
  /** Platform checks each file must pass, as `metaplate verify --target` applies them. */
  checks?: RenderTargetChecks;
};

const NO_PEERS: PeerVersions = Object.freeze({ satori: null, "@resvg/resvg-js": null, "@resvg/resvg-wasm": null });

/** Renders, writes, and verifies every planned image; one failure never stops the rest. */
export async function renderFiles(
  images: readonly PlannedImage[],
  options: RenderFilesOptions,
): Promise<RenderOutcome[]> {
  await mkdir(options.outDir, { recursive: true });
  const realRoot = await realpath(options.outDir);
  return mapConcurrent(images, options.concurrency, async (image) => {
    let outcome: RenderOutcome;
    try {
      const hash = await inputHash(image, options.peers ?? NO_PEERS);
      const reused = options.previous
        ? await reuseImage(image, options.previous.get(image.path), hash, realRoot, options.checks)
        : undefined;
      outcome = reused
        ? { ...reused, valid: true, issues: [], reused: true }
        : { ...(await writeImage(image, realRoot, hash, options.checks)), valid: true, issues: [], reused: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = {
        path: image.path,
        route: image.route,
        variant: image.variant,
        valid: false,
        issues: [{ severity: "error", message }],
      };
    }
    options.onOutcome?.(outcome);
    return outcome;
  });
}

/** One manifest entry's own fields, in the manifest's order. */
function copyManifestImage(image: ManifestImage): ManifestImage {
  return {
    path: image.path,
    url: image.url,
    route: image.route,
    variant: image.variant,
    size: { width: image.size.width, height: image.size.height },
    format: image.format,
    contentType: image.contentType,
    bytes: image.bytes,
    sha256: image.sha256,
    verified: image.verified,
    inputHash: image.inputHash,
  };
}

/**
 * The manifest written beside the images; `schemaVersion` changes only on a
 * breaking change, so `inputHash` (added within version 1) is one readers
 * may not know.
 */
export function renderManifest(images: readonly ManifestImage[]) {
  return {
    schemaVersion: 1 as const,
    images: images.map(copyManifestImage),
  };
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const FORMATS: readonly unknown[] = ["png", "jpeg", "webp", "gif", null];

function isDimension(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && HEX_SHA256.test(value);
}

/** Narrows one entry of a previous manifest; anything malformed is not reused. */
function previousEntry(value: unknown): ManifestImage | undefined {
  if (!isObject(value) || !isObject(value.size)) return undefined;
  const { path: file, url, route, variant, size, format, contentType, bytes, verified } = value;
  const valid =
    typeof file === "string" && typeof url === "string" && typeof route === "string" &&
    (variant === null || typeof variant === "string") &&
    isDimension(size.width) && isDimension(size.height) && FORMATS.includes(format) &&
    typeof contentType === "string" && isDimension(bytes) && typeof verified === "boolean" &&
    isSha256(value.sha256) && isSha256(value.inputHash);
  if (!valid) return undefined;
  return copyManifestImage(value as unknown as ManifestImage);
}

/**
 * Reads the previous run's manifest for `--incremental`. A missing file is an
 * empty map; an unreadable or foreign one is reported through `warn` and also
 * treated as empty, so the run renders everything rather than failing.
 */
export async function readPreviousManifest(
  file: string,
  warn: (message: string) => void,
): Promise<Map<string, ManifestImage>> {
  const entries = new Map<string, ManifestImage>();
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (!(isObject(error) && error.code === "ENOENT")) {
      warn(`Cannot read the previous manifest ${file}; rendering every image`);
    }
    return entries;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    manifest = undefined;
  }
  if (!isObject(manifest) || manifest.schemaVersion !== 1 || !Array.isArray(manifest.images)) {
    warn(`The previous manifest ${file} is not a schemaVersion 1 render manifest; rendering every image`);
    return entries;
  }
  for (const value of manifest.images) {
    const entry = previousEntry(value);
    if (entry) entries.set(entry.path, entry);
  }
  return entries;
}

/**
 * Writes `text` to `file` atomically: into a new temporary file in the same
 * directory, then renamed over the target, so a reader never sees a partial
 * file and a crash leaves either no file or a complete one.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  verify?: (temporary: string) => Promise<void>,
): Promise<void> {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: "wx" });
    // A failed check leaves the previous file exactly as it was.
    await verify?.(temporary);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const TYPESCRIPT = /\.(?:ts|mts|cts)$/i;
const JSX = /\.(?:tsx|jsx)$/i;

/**
 * A module this process has no loader for, such as JSX with no JSX-capable
 * loader registered. Editing the module cannot fix it; restarting under a
 * loader can, so `metaplate preview` gives that advice instead of "save".
 */
export class ModuleLoaderError extends Error {}

/** Rewrites the loader's extension and syntax errors into what to do next. */
function loadError(file: string, error: unknown): unknown {
  const code = isObject(error) ? error.code : undefined;
  if (code === "ERR_UNKNOWN_FILE_EXTENSION" && JSX.test(file)) {
    return new ModuleLoaderError(
      `Cannot load ${file}: Node does not transform JSX. Compile it to .js first, ` +
        "author the plate with plain { type, props } objects in a .ts or .mjs module, " +
        "or run the command through runCli from metaplate/cli under tsx, which works on every platform " +
        "(see docs/render-cli.md#loading-typescript-and-jsx). On a POSIX shell, " +
        "NODE_OPTIONS=\"--import tsx\" also registers a JSX-capable loader.",
      { cause: error },
    );
  }
  if (code === "ERR_UNKNOWN_FILE_EXTENSION" && TYPESCRIPT.test(file)) {
    return new ModuleLoaderError(
      `Cannot load ${file}: Node is not stripping TypeScript types in this process. ` +
        "Type stripping is on by default from Node 22.18 and 23.6, needs " +
        "NODE_OPTIONS=--experimental-strip-types on Node 22.6 to 22.17, does not exist " +
        "before 22.6, and is off under --no-strip-types. Otherwise compile the module to .js first.",
      { cause: error },
    );
  }
  if (code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
    const detail = error instanceof Error ? ` (${error.message})` : "";
    return new Error(
      `Cannot load ${file}: Node strips only erasable TypeScript syntax, so enum, runtime ` +
        `namespaces, parameter properties, and import aliases need a compile step${detail}.`,
      { cause: error },
    );
  }
  return error;
}

/**
 * Imports a render module through a `file:` URL, which Node's ESM loader
 * needs for an absolute path (a Windows drive path is not a valid specifier),
 * and returns its default export. A `query` (such as `?v=2`) loads a fresh
 * instance: Node caches ES modules by URL, so a new query is a new module.
 */
export async function importRenderModule(file: string, query = ""): Promise<unknown> {
  let namespace: Record<string, unknown>;
  try {
    namespace = (await import(`${pathToFileURL(path.resolve(file)).href}${query}`)) as Record<string, unknown>;
  } catch (error) {
    throw loadError(file, error);
  }
  return namespace.default;
}
