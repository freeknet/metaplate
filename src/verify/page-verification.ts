import { SOCIAL_TARGETS, type SocialTarget } from "./compatibility-profiles.js";
import { MAX_IMAGE_DIMENSION, type SocialImageVerificationDescriptor } from "../core/social-image.js";
import {
  decodeHtmlBytes,
  scanPageSocialMetadata,
  type PageMetadataIssueCode,
  type PageSocialMetadata,
} from "./html-metadata.js";
import { imageContentType, imageDimensions, type ImageDimensions, type ImageFormat } from "../image.js";
import {
  checkCrawlers,
  requestedCrawlerTokens,
  resolveCrawlers,
  type CrawlerUrls,
  type RemotePageRobotsReport,
  type RobotsFinding,
  type RobotsIssueCode,
} from "./page-crawlers.js";
import { hasError, integerOption, isAbsoluteUrl, redactUrl } from "../core/internal.js";
import {
  assertRemoteContentType,
  fetchRemoteImageVia,
  fetchRemoteResourceVia,
  RemoteImageError,
  type RemoteDialer,
  type RemoteFetchOptions,
  type RemoteImage,
  type RemoteImageErrorCode,
} from "./remote.js";
import { verifySocialImageFacts, type SocialImageVerificationIssue } from "./social-verification.js";

/** Defaults for the page-specific limits of `verifyRemotePage`. */
export const REMOTE_PAGE_DEFAULTS = Object.freeze({
  maxHtmlBytes: 4 * 1024 * 1024,
  maxImages: 8,
  maxImageReferences: 64,
});

/**
 * Documented HTML read limits, in bytes. Meta: "Any Open Graph properties
 * need to be listed before the first 1 MB of your website or app, or it will
 * be cutoff." WhatsApp: "The <head> containing the HTML mark-ups must appear
 * within the first 300KB of the HTML." Both are read as decimal units, the
 * smaller reading, so a warning is never missed.
 */
export const CRAWLER_HTML_LIMITS = Object.freeze({
  meta: 1_000_000,
  whatsapp: 300_000,
});

const META_TARGETS: readonly SocialTarget[] = ["facebook", "instagram", "threads"];

/** The `Accept` header sent for the page itself. */
export const REMOTE_PAGE_ACCEPT = "text/html,application/xhtml+xml";

const HTML_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const KNOWN_X_CARDS = new Set(["summary", "summary_large_image", "player", "app"]);
const ALL_TARGETS = new Set<string>(SOCIAL_TARGETS);

export type RemotePageOptions = RemoteFetchOptions & {
  /**
   * Largest HTML body accepted, enforced while streaming. Default 4 MiB.
   * `maxBytes` applies to each image.
   */
  maxHtmlBytes?: number;
  /** Distinct image URLs fetched; further references are reported, not fetched. Default 8. */
  maxImages?: number;
  /**
   * Image references inspected. The first `og:image`, its
   * `og:image:secure_url`, and `twitter:image` always are; later ones beyond
   * this count are only counted. Default 64.
   */
  maxImageReferences?: number;
  /**
   * robots.txt product tokens to evaluate besides the crawlers implied by
   * `targets`, such as `["Twitterbot", "ExampleBot"]`. Rules are evaluated;
   * no request is ever sent with a crawler's user agent.
   */
  crawlers?: readonly string[];
  /** Compatibility profiles evaluated against the image each consumer would pick. */
  targets?: readonly SocialTarget[];
  /** Application byte ceiling applied to every image. */
  maxFileSize?: number;
};

export type RemotePageIssueSeverity = "error" | "warning" | "unknown";

export type RemotePageIssueCode =
  | "og-image-missing"
  | "twitter-card-missing"
  | "twitter-card-unknown"
  | "twitter-image-missing"
  | "image-limit"
  | "html-limit"
  | RobotsIssueCode
  | PageMetadataIssueCode;

export type RemotePageImageIssueCode =
  | "invalid-url"
  | "relative-url"
  | "insecure-url"
  | "alt"
  | "declared-dimensions"
  | "image"
  | "image-limit"
  | RemoteImageErrorCode
  | RobotsIssueCode
  | SocialImageVerificationIssue["code"];

export type RemotePageIssue<Code extends string = RemotePageIssueCode | RemotePageImageIssueCode> = Readonly<{
  severity: RemotePageIssueSeverity;
  code: Code;
  message: string;
  target?: SocialTarget;
}>;

export type RemotePageTargetReport<Code extends string> = Readonly<{
  compatible: boolean;
  issues: readonly RemotePageIssue<Code>[];
}>;

/** Where on the page an image reference came from. */
export type RemotePageImageSource = "og:image" | "og:image:secure_url" | "twitter:image" | "json-ld";

/** What the page declares about one referenced image, as written. */
export type RemotePageDeclaredImage = Readonly<{
  url: string;
  width?: string;
  height?: string;
  type?: string;
  alt?: string;
}>;

export type RemotePageImageReport = Readonly<{
  source: RemotePageImageSource;
  /** Position among `og:image` entries or JSON-LD images; 0 for `twitter:image`. */
  index: number;
  declared: RemotePageDeclaredImage;
  /** The absolute URL the reference resolves to, or null when it does not resolve. */
  url: string | null;
  /** Fetch facts, present once the image was fetched. */
  finalUrl?: string;
  redirects?: readonly string[];
  contentType?: string | null;
  bytes?: number;
  /** No error-severity finding outside target checks. */
  valid: boolean;
  image?: Readonly<{ format: ImageFormat; width: number; height: number; bytes: number }>;
  globalIssues: readonly RemotePageIssue<RemotePageImageIssueCode>[];
  targets: Readonly<Partial<Record<SocialTarget, RemotePageTargetReport<RemotePageImageIssueCode>>>>;
}>;

export type RemotePageVerification = Readonly<{
  /** The requested URL, normalized. */
  url: string;
  /** The URL whose response supplied the HTML, after redirects. */
  finalUrl: string;
  redirects: readonly string[];
  contentType: string | null;
  bytes: number;
  /** The document base URL relative references were resolved against. */
  baseUrl: string;
  /** No error-severity page finding, and every image `valid`. */
  valid: boolean;
  metadata: Omit<PageSocialMetadata, "issues" | "documentUrl" | "baseUrl">;
  globalIssues: readonly RemotePageIssue<RemotePageIssueCode>[];
  /** Per target: page findings, and compatible only when every image checked for it is. */
  targets: Readonly<Partial<Record<SocialTarget, RemotePageTargetReport<RemotePageIssueCode>>>>;
  images: readonly RemotePageImageReport[];
  /**
   * robots.txt evaluation, present when at least one crawler was evaluated:
   * one entry per origin fetched, and per crawler every URL it would fetch.
   */
  robots?: RemotePageRobotsReport;
}>;

type ImageIssue = RemotePageIssue<RemotePageImageIssueCode>;
type PageIssue = RemotePageIssue<RemotePageIssueCode>;

type Reference = {
  source: RemotePageImageSource;
  index: number;
  declared: RemotePageDeclaredImage;
  /** Targets this reference is the chosen image for. */
  targets: readonly SocialTarget[];
  /** Whether alt text is part of this channel (og:image and twitter:image). */
  hasAlt: boolean;
};

function issue<Code extends string>(
  severity: RemotePageIssueSeverity,
  code: Code,
  message: string,
  target?: SocialTarget,
): RemotePageIssue<Code> {
  return Object.freeze({ severity, code, message, ...(target ? { target } : {}) });
}

function defined<Value>(key: string, value: Value | undefined): Record<string, Value> {
  return value === undefined ? {} : { [key]: value };
}

function references(metadata: PageSocialMetadata, targets: readonly SocialTarget[]): Reference[] {
  const list: Reference[] = [];
  const twitterImage = metadata.twitter.image;
  // X reads twitter:image when present; every other consumer reads og:image,
  // preferring the first.
  const openGraphTargets = twitterImage === undefined ? targets : targets.filter((target) => target !== "x");
  metadata.openGraph.images.forEach((image, index) => {
    const shared = {
      ...defined("width", image.width),
      ...defined("height", image.height),
      ...defined("type", image.type),
      ...defined("alt", image.alt),
    };
    const chosen = index === 0 ? openGraphTargets : [];
    list.push({ source: "og:image", index, declared: { url: image.url, ...shared }, targets: chosen, hasAlt: true });
    if (image.secureUrl !== undefined) {
      list.push({
        source: "og:image:secure_url",
        index,
        declared: { url: image.secureUrl, ...shared },
        targets: chosen,
        hasAlt: false,
      });
    }
  });
  if (twitterImage !== undefined) {
    list.push({
      source: "twitter:image",
      index: 0,
      declared: {
        url: twitterImage,
        ...defined("width", metadata.twitter.imageWidth),
        ...defined("height", metadata.twitter.imageHeight),
        ...defined("type", metadata.twitter.imageType),
        ...defined("alt", metadata.twitter.imageAlt),
      },
      targets: targets.includes("x") ? ["x"] : [],
      hasAlt: true,
    });
  }
  metadata.jsonLd.images.forEach((image, index) => {
    list.push({
      source: "json-ld",
      index,
      declared: {
        url: image.url,
        ...defined("width", image.width === undefined ? undefined : String(image.width)),
        ...defined("height", image.height === undefined ? undefined : String(image.height)),
        ...defined("type", image.encodingFormat),
      },
      targets: [],
      hasAlt: false,
    });
  });
  return list;
}

/** Parses declared width and height; both must be positive integers to be compared. */
function declaredSize(reference: Reference, issues: ImageIssue[]): { width: number; height: number } | undefined {
  const parsed: Partial<Record<"width" | "height", number>> = {};
  for (const axis of ["width", "height"] as const) {
    const text = reference.declared[axis];
    if (text === undefined) continue;
    const value = /^\d{1,9}$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_IMAGE_DIMENSION) {
      issues.push(issue(
        "error",
        "declared-dimensions",
        `Declared ${axis} ${JSON.stringify(text)} is not a pixel count from 1 to ${MAX_IMAGE_DIMENSION}.`,
      ));
      continue;
    }
    parsed[axis] = value;
  }
  if (parsed.width !== undefined && parsed.height !== undefined) return { width: parsed.width, height: parsed.height };
  const declared = (["width", "height"] as const).filter((axis) => reference.declared[axis] !== undefined);
  if (declared.length === 1) {
    issues.push(issue(
      "warning",
      "declared-dimensions",
      `Only the ${declared[0]} is declared; declare width and height together.`,
    ));
  }
  return undefined;
}

/** Checks that need no network: URL form, scheme, and alt text. */
function referenceIssues(reference: Reference, resolved: URL, issues: ImageIssue[]): void {
  if (reference.source !== "json-ld" && !isAbsoluteUrl(reference.declared.url)) {
    issues.push(issue(
      "warning",
      "relative-url",
      `${JSON.stringify(reference.declared.url)} is relative and was resolved to ${redactUrl(resolved)}; Open Graph and X Card URLs should be absolute.`,
    ));
  }
  if (resolved.protocol === "http:") {
    issues.push(reference.source === "og:image:secure_url"
      ? issue("error", "insecure-url", `og:image:secure_url must be an https URL; received ${redactUrl(resolved)}.`)
      : issue("warning", "insecure-url", `${redactUrl(resolved)} is served over http; crawlers that require https will not load it.`));
  }
  if (reference.hasAlt && !reference.declared.alt) {
    const property = reference.source === "twitter:image" ? "twitter:image:alt" : "og:image:alt";
    issues.push(issue("warning", "alt", `No ${property}; describe the image for people who cannot see it.`));
  }
}

type Fetcher = (url: string) => Promise<RemoteImage>;

/**
 * Structural facts per fetched response. Many references may name one URL;
 * the bytes are parsed once and only the cheap descriptor and profile
 * comparisons run per reference.
 */
const measured = new WeakMap<RemoteImage, { dimensions: ImageDimensions } | { error: unknown }>();

function measure(remote: RemoteImage): ImageDimensions {
  let entry = measured.get(remote);
  if (!entry) {
    try {
      entry = { dimensions: imageDimensions(remote.bytes) };
    } catch (error) {
      entry = { error };
    }
    measured.set(remote, entry);
  }
  if ("error" in entry) throw entry.error;
  return entry.dimensions;
}

/** Verifies fetched bytes against the reference's declarations and targets. */
function inspectBytes(
  reference: Reference,
  remote: RemoteImage,
  size: { width: number; height: number } | undefined,
  options: RemotePageOptions,
  issues: ImageIssue[],
): Pick<RemotePageImageReport, "image" | "targets"> {
  const dimensions = measure(remote);
  const descriptor: SocialImageVerificationDescriptor = {
    // Target URL checks judge the value as published, not as resolved.
    ...(reference.targets.length > 0 ? { url: reference.declared.url } : {}),
    // With a target, a missing alt fails the profile's alt contract.
    ...(reference.targets.length > 0 && reference.hasAlt ? { alt: reference.declared.alt ?? "" } : {}),
    ...(size ?? {}),
    // Without a declared type the fetched bytes still settle the format
    // checks; a declared type is compared against them instead.
    type: reference.declared.type ?? imageContentType(dimensions.format),
  };
  const report = verifySocialImageFacts(dimensions, remote.byteLength, descriptor, {
    targets: reference.targets,
    ...defined("maxFileSize", options.maxFileSize),
  });
  try {
    assertRemoteContentType(remote, report.actual.format);
  } catch (error) {
    if (!(error instanceof RemoteImageError)) throw error;
    issues.push(issue("error", error.code, error.message));
  }
  const targets: Partial<Record<SocialTarget, RemotePageTargetReport<RemotePageImageIssueCode>>> = {};
  for (const found of report.issues) {
    if (found.target === undefined) issues.push(issue(found.severity, found.code, found.message));
  }
  for (const target of reference.targets) {
    const targetIssues = report.issues
      .filter((found) => found.target === target)
      .map((found) => issue(found.severity, found.code, found.message, target));
    targets[target] = Object.freeze({ compatible: !hasError(targetIssues), issues: Object.freeze(targetIssues) });
  }
  const { format, width, height, byteLength } = report.actual;
  return { image: Object.freeze({ format, width, height, bytes: byteLength }), targets: Object.freeze(targets) };
}

async function inspect(
  reference: Reference,
  baseUrl: URL,
  fetchImage: Fetcher | undefined,
  options: RemotePageOptions,
): Promise<RemotePageImageReport> {
  const issues: ImageIssue[] = [];
  const raw = reference.declared.url;
  let resolved: URL | undefined;
  try {
    resolved = raw === "" ? undefined : new URL(raw, baseUrl);
  } catch {
    resolved = undefined;
  }
  const finish = (url: string | null, extra: Partial<RemotePageImageReport> = {}): RemotePageImageReport =>
    Object.freeze({
      source: reference.source,
      index: reference.index,
      declared: Object.freeze({ ...reference.declared, url: resolved ? redactUrl(raw, resolved) : raw }),
      url,
      ...extra,
      valid: !hasError(issues),
      globalIssues: Object.freeze(issues),
      targets: extra.targets ?? Object.freeze({}),
    });

  if (!resolved) {
    issues.push(issue("error", "invalid-url", `${JSON.stringify(raw)} is not a valid URL.`));
    return finish(null);
  }
  referenceIssues(reference, resolved, issues);
  const size = declaredSize(reference, issues);
  const url = redactUrl(resolved);
  if (!fetchImage) {
    issues.push(issue("unknown", "image-limit", `Not fetched: the page references more than ${options.maxImages ?? REMOTE_PAGE_DEFAULTS.maxImages} distinct image URLs.`));
    return finish(url);
  }
  let remote: RemoteImage;
  try {
    remote = await fetchImage(resolved.href);
  } catch (error) {
    if (!(error instanceof RemoteImageError)) throw error;
    issues.push(issue("error", error.code, error.message));
    return finish(url);
  }
  const fetched = {
    finalUrl: remote.finalUrl,
    redirects: remote.redirects,
    contentType: remote.contentType ?? null,
    bytes: remote.byteLength,
  };
  try {
    return finish(url, { ...fetched, ...inspectBytes(reference, remote, size, options, issues) });
  } catch (error) {
    // Bytes that are not a recognizable, complete image.
    issues.push(issue("error", "image", error instanceof Error ? error.message : String(error)));
    return finish(url, fetched);
  }
}

/** The extracted metadata as reported: every image URL with credentials redacted. */
function reportMetadata(metadata: PageSocialMetadata, baseUrl: URL): RemotePageVerification["metadata"] {
  const clean = (value: string): string => {
    try {
      return redactUrl(value, new URL(value, baseUrl));
    } catch {
      return value;
    }
  };
  const { openGraph, twitter, jsonLd } = metadata;
  return Object.freeze({
    ...defined("baseHref", metadata.baseHref),
    openGraph: Object.freeze({
      ...openGraph,
      images: Object.freeze(openGraph.images.map((image) => Object.freeze({
        ...image,
        url: clean(image.url),
        ...(image.secureUrl !== undefined ? { secureUrl: clean(image.secureUrl) } : {}),
      }))),
    }),
    twitter: Object.freeze({ ...twitter, ...(twitter.image !== undefined ? { image: clean(twitter.image) } : {}) }),
    jsonLd: Object.freeze({
      ...jsonLd,
      images: Object.freeze(jsonLd.images.map((image) => Object.freeze({ ...image, url: clean(image.url) }))),
    }),
  });
}

type Limits = { skipped: number; maxImages: number; omitted: number; maxImageReferences: number };

function pageIssues(metadata: PageSocialMetadata, targets: readonly SocialTarget[], limits: Limits): PageIssue[] {
  const { skipped, maxImages, omitted, maxImageReferences } = limits;
  const issues: PageIssue[] = [];
  const { openGraph, twitter } = metadata;
  if (openGraph.images.length === 0) {
    issues.push(issue("error", "og-image-missing", "The page declares no og:image; Open Graph requires one on every page."));
  }
  if (twitter.card === undefined) {
    const message = "The page declares no twitter:card; X Cards need it to choose a card type.";
    issues.push(targets.includes("x")
      ? issue("error", "twitter-card-missing", message, "x")
      : issue("warning", "twitter-card-missing", message));
  } else if (!KNOWN_X_CARDS.has(twitter.card)) {
    issues.push(issue(
      "warning",
      "twitter-card-unknown",
      `twitter:card ${JSON.stringify(twitter.card)} is not summary, summary_large_image, player, or app.`,
    ));
  }
  if (
    (twitter.card !== undefined || targets.includes("x")) &&
    twitter.card !== "app" &&
    twitter.image === undefined &&
    openGraph.images.length === 0
  ) {
    issues.push(issue(
      "error",
      "twitter-image-missing",
      "The page has neither twitter:image nor an og:image for X to fall back to.",
      ...(targets.includes("x") ? ["x" as const] : []),
    ));
  }
  for (const found of metadata.issues) issues.push(issue("warning", found.code, found.message));
  if (skipped > 0) {
    issues.push(issue(
      "unknown",
      "image-limit",
      `${skipped} image reference${skipped === 1 ? " was" : "s were"} not fetched: only ${maxImages} distinct image URLs are fetched per page.`,
    ));
  }
  if (omitted > 0) {
    issues.push(issue(
      "unknown",
      "image-limit",
      `${omitted} further image reference${omitted === 1 ? " was" : "s were"} not inspected or reported: only ${maxImageReferences} references are inspected per page.`,
    ));
  }
  return issues;
}

/** Whether a reference is one a consumer reads first, which the reference cap never drops. */
function isPrimary(reference: Reference): boolean {
  return reference.index === 0 && reference.source !== "json-ld";
}

function sameOpenGraph(a: PageSocialMetadata["openGraph"], b: PageSocialMetadata["openGraph"]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Re-reads the HTML as a crawler with a read limit would see it, and warns
 * when that loses Open Graph tags (Meta) or does not reach the end of the
 * head (WhatsApp).
 */
function htmlLimitIssues(
  bytes: Uint8Array,
  contentType: string | undefined,
  documentUrl: string,
  full: PageSocialMetadata,
  targets: readonly SocialTarget[],
): PageIssue[] {
  const issues: PageIssue[] = [];
  const prefix = (limit: number) =>
    scanPageSocialMetadata(decodeHtmlBytes(bytes.subarray(0, limit), contentType), documentUrl);
  const { meta, whatsapp } = CRAWLER_HTML_LIMITS;
  if (bytes.byteLength > meta && !sameOpenGraph(prefix(meta).metadata.openGraph, full.openGraph)) {
    const message = `Open Graph tags appear after the first ${meta.toLocaleString("en-US")} bytes of the HTML; Meta's crawler reads only the first 1 MB, so it does not see them. Move them to the top of <head>.`;
    const metaTargets = META_TARGETS.filter((target) => targets.includes(target));
    if (metaTargets.length === 0) issues.push(issue("warning", "html-limit", message));
    for (const target of metaTargets) issues.push(issue("warning", "html-limit", message, target));
  }
  if (targets.includes("whatsapp") && bytes.byteLength > whatsapp && !prefix(whatsapp).headEnded) {
    issues.push(issue(
      "warning",
      "html-limit",
      `The <head> does not end within the first ${whatsapp.toLocaleString("en-US")} bytes of the HTML; WhatsApp requires the <head> with its tags to appear within the first 300KB.`,
      "whatsapp",
    ));
  }
  return issues;
}

/** Image fetch codes that mean the URL was refused by policy, so no crawler would be judged on it. */
const REFUSED_CODES = new Set<string>(["invalid-url", "scheme", "credentials", "port", "address", "image-limit"]);

/** Rebuilds a frozen image report with robots findings added. */
function withFindings(image: RemotePageImageReport, findings: readonly RobotsFinding[]): RemotePageImageReport {
  if (findings.length === 0) return image;
  const globalIssues = [...image.globalIssues];
  const targets: Partial<Record<SocialTarget, RemotePageTargetReport<RemotePageImageIssueCode>>> = { ...image.targets };
  for (const found of findings) {
    const added = issue(found.severity, found.code, found.message, found.target);
    if (found.target === undefined) {
      globalIssues.push(added);
      continue;
    }
    const issues = [...(targets[found.target]?.issues ?? []), added];
    targets[found.target] = Object.freeze({ compatible: !hasError(issues), issues: Object.freeze(issues) });
  }
  return Object.freeze({
    ...image,
    valid: !hasError(globalIssues),
    globalIssues: Object.freeze(globalIssues),
    targets: Object.freeze(targets),
  });
}

/**
 * Fetch seam used by `verifyRemotePage`. `dial` maps a checked address to the
 * one actually connected to; production callers use the identity.
 */
export async function verifyRemotePageVia(
  input: string | URL,
  options: RemotePageOptions,
  dial: RemoteDialer,
): Promise<RemotePageVerification> {
  const maxHtmlBytes = integerOption("maxHtmlBytes", options.maxHtmlBytes, 1) ?? REMOTE_PAGE_DEFAULTS.maxHtmlBytes;
  const maxImages = integerOption("maxImages", options.maxImages, 1) ?? REMOTE_PAGE_DEFAULTS.maxImages;
  const targets = [...new Set(options.targets ?? [])];
  for (const target of targets) {
    if (!ALL_TARGETS.has(target)) throw new TypeError(`Unknown social target: ${target}`);
  }
  integerOption("maxFileSize", options.maxFileSize, 0);

  const maxImageReferences =
    integerOption("maxImageReferences", options.maxImageReferences, 1) ?? REMOTE_PAGE_DEFAULTS.maxImageReferences;
  const crawlers = resolveCrawlers(targets, requestedCrawlerTokens(options.crawlers));

  const page = await fetchRemoteResourceVia(input, { ...options, maxBytes: maxHtmlBytes }, dial, REMOTE_PAGE_ACCEPT);
  const essence = page.contentType?.split(";", 1)[0]!.trim().toLowerCase();
  if (essence === undefined || !HTML_CONTENT_TYPES.has(essence)) {
    throw new RemoteImageError(
      "content-type",
      `${page.finalUrl} is served as ${page.contentType ?? "(no Content-Type)"}, not as an HTML document (text/html or application/xhtml+xml)`,
      page.finalUrl,
    );
  }
  const { metadata } = scanPageSocialMetadata(decodeHtmlBytes(page.bytes, page.contentType), page.finalUrl);
  const baseUrl = new URL(metadata.baseUrl);

  // One fetch per distinct URL, however many tags name it.
  const fetches = new Map<string, Promise<RemoteImage>>();
  const fetchImage: Fetcher = (url) => {
    let pending = fetches.get(url);
    if (!pending) {
      pending = fetchRemoteImageVia(url, options, dial);
      // The rejection is observed by every awaiting reference.
      pending.catch(() => undefined);
      fetches.set(url, pending);
    }
    return pending;
  };
  let images: RemotePageImageReport[] = [];
  const imageTargets: (readonly SocialTarget[])[] = [];
  let skipped = 0;
  let omitted = 0;
  for (const reference of references(metadata, targets)) {
    if (images.length >= maxImageReferences && !isPrimary(reference)) {
      omitted += 1;
      continue;
    }
    let key: string | undefined;
    try {
      key = new URL(reference.declared.url, baseUrl).href;
    } catch {
      key = undefined;
    }
    const withinLimit = key === undefined || fetches.has(key) || fetches.size < maxImages;
    if (!withinLimit) skipped += 1;
    images.push(await inspect(reference, baseUrl, withinLimit ? fetchImage : undefined, { ...options, maxImages }));
    imageTargets.push(reference.targets);
  }

  const globalIssues = [
    ...pageIssues(metadata, targets, { skipped, maxImages, omitted, maxImageReferences }),
    ...htmlLimitIssues(page.bytes, page.contentType, page.finalUrl, metadata, targets),
  ];

  let robots: RemotePageRobotsReport | undefined;
  if (crawlers.length > 0) {
    const urls: CrawlerUrls = { page: [page.url, ...page.redirects], images: new Map() };
    const chains = urls.images as Map<string, { chain: readonly string[]; references: string[]; targets: Set<SocialTarget> }>;
    images.forEach((image, position) => {
      if (image.url === null || image.globalIssues.some(({ code }) => REFUSED_CODES.has(code))) return;
      const entry = chains.get(image.url) ?? { chain: [image.url, ...(image.redirects ?? [])], references: [], targets: new Set() };
      entry.references.push(image.source === "twitter:image" ? image.source : `${image.source}[${image.index}]`);
      for (const target of imageTargets[position]!) entry.targets.add(target);
      chains.set(image.url, entry);
    });
    const checked = await checkCrawlers(crawlers, urls, options, dial);
    robots = checked.report;
    for (const found of checked.findings) {
      if (found.image === undefined) globalIssues.push(issue(found.severity, found.code, found.message, found.target));
    }
    images = images.map((image, position) => withFindings(
      image,
      checked.findings.filter((found) =>
        found.image !== undefined && found.image === image.url &&
        (found.target === undefined || imageTargets[position]!.includes(found.target))),
    ));
  }

  const chosen = new Map<SocialTarget, RemotePageImageReport[]>(targets.map((target) => [target, []]));
  images.forEach((image, position) => {
    for (const target of imageTargets[position]!) chosen.get(target)!.push(image);
  });
  const targetReports: Partial<Record<SocialTarget, RemotePageTargetReport<RemotePageIssueCode>>> = {};
  for (const target of targets) {
    const issues = globalIssues.filter((found) => found.target === target);
    // An image chosen for this target that failed, or failed the profile,
    // makes the page incompatible; one left unfetched by the limit does not.
    const imagesCompatible = chosen.get(target)!.every((image) => image.valid && image.targets[target]?.compatible !== false);
    targetReports[target] = Object.freeze({ compatible: !hasError(issues) && imagesCompatible, issues: Object.freeze(issues) });
  }

  const untargeted = globalIssues.filter((found) => found.target === undefined);
  return Object.freeze({
    url: page.url,
    finalUrl: page.finalUrl,
    redirects: page.redirects,
    contentType: page.contentType ?? null,
    bytes: page.byteLength,
    baseUrl: metadata.baseUrl,
    valid: !hasError(untargeted) && images.every((image) => image.valid),
    metadata: reportMetadata(metadata, baseUrl),
    globalIssues: Object.freeze(untargeted),
    targets: Object.freeze(targetReports),
    images: Object.freeze(images),
    ...(robots ? { robots } : {}),
  });
}

/**
 * Fetches an HTML page under the same hardened policy as `fetchRemoteImage`,
 * extracts its Open Graph, X Card, and Schema.org JSON-LD image metadata,
 * and verifies every referenced image: bytes, `Content-Type`, declared
 * dimensions and type, and the requested compatibility profiles. A refused or
 * failed page fetch throws `RemoteImageError`; every image finding is
 * returned in the report.
 */
export function verifyRemotePage(input: string | URL, options: RemotePageOptions = {}): Promise<RemotePageVerification> {
  return verifyRemotePageVia(input, options, (address) => address);
}
