import type { SocialTarget } from "./compatibility-profiles.js";
import {
  fetchRemoteResourceVia,
  RemoteImageError,
  type RemoteDialer,
  type RemoteFetchOptions,
} from "./remote.js";
import {
  evaluateRobots,
  isRobotsProductToken,
  parseRobotsTxt,
  type RobotsGroupMatch,
  type RobotsRule,
  type RobotsTxt,
} from "./robots.js";
import {
  crawlersForTargets,
  findSocialCrawler,
  type SocialCrawler,
  type SocialCrawlerRobotsPolicy,
} from "./social-crawlers.js";

/**
 * robots.txt fetch limits. RFC 9309 asks crawlers to follow at least five
 * redirects and to parse at least 500 KiB; a larger file is cut there and
 * the parsed part is used.
 */
export const REMOTE_ROBOTS_DEFAULTS = Object.freeze({
  maxBytes: 500 * 1024,
  maxRedirects: 5,
});

/** The `Accept` header sent for robots.txt. */
export const REMOTE_ROBOTS_ACCEPT = "text/plain";

/**
 * How a robots.txt fetch ended, in RFC 9309 section 2.3.1 terms:
 * `parsed` (its rules apply), `unavailable` (4xx, or more than five
 * redirects: everything is allowed), `unreachable` (5xx or a network
 * failure: everything is disallowed), or `unknown` (the fetch policy
 * refused it, so nothing can be said).
 */
export type RemotePageRobotsStatus = "parsed" | "unavailable" | "unreachable" | "unknown";

export type RemotePageRobotsFile = Readonly<{
  /** The origin the file governs. */
  origin: string;
  /** `<origin>/robots.txt`. */
  url: string;
  status: RemotePageRobotsStatus;
  /** The HTTP status of the final response, when there was one. */
  httpStatus?: number;
  /** Where the file was read from, after redirects, when it was read. */
  finalUrl?: string;
  /** Bytes parsed. */
  bytes?: number;
  /** The file was larger than the parsing limit and was cut to it. */
  truncated?: boolean;
  /** Why the file was not parsed. */
  message?: string;
}>;

/** One URL a crawler would fetch, judged against its origin's robots.txt. */
export type RemotePageCrawlerCheck = Readonly<{
  resource: "page" | "image";
  url: string;
  /** For images: each reference naming the URL, such as `og:image[0]`. */
  references?: readonly string[];
  robotsUrl: string;
  /** `null` when the robots.txt status is `unknown`. */
  allowed: boolean | null;
  /** The group the decision came from, when the file was parsed. */
  group?: RobotsGroupMatch;
  /** The deciding rule, when one matched. */
  rule?: RobotsRule;
}>;

export type RemotePageCrawlerReport = Readonly<{
  /** The robots.txt product token evaluated. */
  token: string;
  /** The platform, for a documented crawler. */
  platform?: string;
  /** What the platform documents; `requested` for a token it does not document. */
  robots: SocialCrawlerRobotsPolicy | "requested";
  /** The requested targets the crawler builds previews for. */
  targets: readonly SocialTarget[];
  /** Named with the `crawlers` option (`--crawler`). */
  requested: boolean;
  /** Every check allowed (`true`), any disallowed (`false`), or any unknown (`null`). */
  allowed: boolean | null;
  checks: readonly RemotePageCrawlerCheck[];
}>;

export type RemotePageRobotsReport = Readonly<{
  files: readonly RemotePageRobotsFile[];
  crawlers: readonly RemotePageCrawlerReport[];
}>;

export type RobotsIssueCode = "robots-disallowed" | "robots-unreachable" | "robots-unknown";

export type RobotsFinding = Readonly<{
  severity: "error" | "warning" | "unknown";
  code: RobotsIssueCode;
  message: string;
  /** Absent for a crawler requested without a target. */
  target?: SocialTarget;
  /** `undefined` for the page; otherwise the image URL. */
  image?: string;
}>;

/** One crawler to evaluate, resolved from targets and requested tokens. */
type Crawler = {
  token: string;
  documented?: SocialCrawler;
  targets: SocialTarget[];
  requested: boolean;
};

/** Every URL a crawler would fetch for the page and its images. */
export type CrawlerUrls = {
  /** The requested page URL and each redirect target. */
  page: readonly string[];
  /** Image URL chains, keyed by first URL, with the references naming each. */
  images: ReadonlyMap<string, { chain: readonly string[]; references: string[]; targets: Set<SocialTarget> }>;
};

/** Validates and canonicalizes requested tokens: a documented crawler keeps its own spelling. */
export function requestedCrawlerTokens(tokens: readonly string[] | undefined): string[] {
  const seen = new Map<string, string>();
  for (const token of tokens ?? []) {
    if (typeof token !== "string" || !isRobotsProductToken(token)) {
      throw new TypeError(`crawlers entries must be robots.txt product tokens (letters, "-", "_"); received ${JSON.stringify(token)}`);
    }
    const canonical = findSocialCrawler(token)?.token ?? token;
    if (!seen.has(canonical.toLowerCase())) seen.set(canonical.toLowerCase(), canonical);
  }
  return [...seen.values()];
}

/** The crawlers implied by `targets`, then any further requested tokens. */
export function resolveCrawlers(targets: readonly SocialTarget[], requested: readonly string[]): Crawler[] {
  const crawlers = new Map<string, Crawler>();
  for (const documented of crawlersForTargets(targets)) {
    crawlers.set(documented.token.toLowerCase(), {
      token: documented.token,
      documented,
      targets: documented.targets.filter((target) => targets.includes(target)),
      requested: false,
    });
  }
  for (const token of requested) {
    const existing = crawlers.get(token.toLowerCase());
    if (existing) existing.requested = true;
    else {
      const documented = findSocialCrawler(token);
      crawlers.set(token.toLowerCase(), { token, ...(documented ? { documented } : {}), targets: [], requested: true });
    }
  }
  return [...crawlers.values()];
}

type FileResult = { file: RemotePageRobotsFile; robots?: RobotsTxt };

function classify(error: RemoteImageError): Pick<RemotePageRobotsFile, "status" | "httpStatus"> {
  if (error.code === "status" && error.status !== undefined) {
    if (error.status >= 400 && error.status <= 499) return { status: "unavailable", httpStatus: error.status };
    if (error.status >= 500 && error.status <= 599) return { status: "unreachable", httpStatus: error.status };
    return { status: "unknown", httpStatus: error.status };
  }
  if (error.code === "too-many-redirects") return { status: "unavailable" };
  if (error.code === "timeout" || error.code === "network" || error.code === "dns") return { status: "unreachable" };
  return { status: "unknown" };
}

async function fetchRobots(origin: string, options: RemoteFetchOptions, dial: RemoteDialer): Promise<FileResult> {
  const url = `${origin}/robots.txt`;
  try {
    const response = await fetchRemoteResourceVia(url, {
      ...options,
      maxBytes: REMOTE_ROBOTS_DEFAULTS.maxBytes,
      maxRedirects: REMOTE_ROBOTS_DEFAULTS.maxRedirects,
    }, dial, REMOTE_ROBOTS_ACCEPT, { truncate: true });
    // RFC 9309 files are UTF-8; undecodable bytes become U+FFFD.
    const robots = parseRobotsTxt(new TextDecoder("utf-8").decode(response.bytes));
    return {
      robots,
      file: Object.freeze({
        origin,
        url,
        status: "parsed",
        httpStatus: response.status,
        finalUrl: response.finalUrl,
        bytes: response.byteLength,
        ...(response.truncated ? { truncated: true } : {}),
      }),
    };
  } catch (error) {
    if (!(error instanceof RemoteImageError)) throw error;
    return { file: Object.freeze({ origin, url, ...classify(error), message: error.message }) };
  }
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function policyOf(crawler: Crawler): SocialCrawlerRobotsPolicy | "requested" {
  return crawler.documented?.robots ?? "requested";
}

function name(crawler: Crawler): string {
  return crawler.documented ? `${crawler.token} (${crawler.documented.platform})` : crawler.token;
}

/** The severity a disallow carries: only crawlers documented to obey robots.txt, or requested ones, fail. */
function severityOf(crawler: Crawler): "error" | "warning" | undefined {
  const policy = policyOf(crawler);
  if (policy === "ignores") return undefined;
  return policy === "undocumented" ? "warning" : "error";
}

function consequence(crawler: Crawler): string {
  switch (policyOf(crawler)) {
    case "honors":
      return `${crawler.documented!.platform} documents that this crawler obeys robots.txt, so it will not fetch it.`;
    case "undocumented":
      return `${crawler.documented!.platform} does not document whether this crawler obeys robots.txt; if it does, it will not fetch it.`;
    default:
      return "A crawler that obeys robots.txt will not fetch it.";
  }
}

function describeRule(rule: RobotsRule): string {
  return `line ${rule.line} (${rule.kind === "allow" ? "Allow" : "Disallow"}: ${rule.pattern})`;
}

/**
 * Fetches robots.txt once per origin with the hardened fetcher and judges
 * every URL each crawler would fetch: the page (and each redirect), and each
 * fetched image (and each redirect). Never sends a crawler's user agent.
 */
export async function checkCrawlers(
  crawlers: readonly Crawler[],
  urls: CrawlerUrls,
  options: RemoteFetchOptions,
  dial: RemoteDialer,
): Promise<{ report: RemotePageRobotsReport; findings: RobotsFinding[] }> {
  const files = new Map<string, FileResult>();
  const allUrls = [...urls.page, ...[...urls.images.values()].flatMap(({ chain }) => chain)];
  for (const url of allUrls) {
    const origin = originOf(url);
    if (origin !== undefined && !files.has(origin)) files.set(origin, await fetchRobots(origin, options, dial));
  }

  const findings: RobotsFinding[] = [];
  const reports: RemotePageCrawlerReport[] = [];
  for (const crawler of crawlers) {
    const checks: RemotePageCrawlerCheck[] = [];
    const judge = (resource: "page" | "image", chain: readonly string[], image?: { first: string; references: string[]; targets: Set<SocialTarget> }) => {
      for (const url of chain) {
        const origin = originOf(url);
        if (origin === undefined) continue;
        const { file, robots } = files.get(origin)!;
        let check: RemotePageCrawlerCheck;
        if (file.status === "parsed") {
          const decision = evaluateRobots(robots!, crawler.token, url);
          check = { resource, url, robotsUrl: file.url, allowed: decision.allowed, group: decision.group, ...(decision.rule ? { rule: decision.rule } : {}) };
        } else {
          check = { resource, url, robotsUrl: file.url, allowed: file.status === "unknown" ? null : file.status === "unavailable" };
        }
        checks.push(Object.freeze({ ...check, ...(image ? { references: Object.freeze([...image.references]) } : {}) }));
        const finding = findingFor(crawler, check, file);
        if (!finding) continue;
        // A targeted crawler's image finding matters only where that image is
        // the one the target reads; a requested crawler's applies to all.
        const targets = image && crawler.targets.length > 0
          ? crawler.targets.filter((target) => image.targets.has(target))
          : crawler.targets;
        if (crawler.targets.length > 0 && targets.length === 0) continue;
        const place = image ? { image: image.first } : {};
        if (targets.length === 0) findings.push(Object.freeze({ ...finding, ...place }));
        for (const target of targets) findings.push(Object.freeze({ ...finding, target, ...place }));
      }
    };
    judge("page", urls.page);
    for (const [first, image] of urls.images) judge("image", image.chain, { first, ...image });
    const allowed = checks.some((check) => check.allowed === false)
      ? false
      : checks.some((check) => check.allowed === null) ? null : true;
    reports.push(Object.freeze({
      token: crawler.token,
      ...(crawler.documented ? { platform: crawler.documented.platform } : {}),
      robots: policyOf(crawler),
      targets: Object.freeze([...crawler.targets]),
      requested: crawler.requested,
      allowed,
      checks: Object.freeze(checks),
    }));
  }
  return {
    report: Object.freeze({ files: Object.freeze([...files.values()].map(({ file }) => file)), crawlers: Object.freeze(reports) }),
    findings,
  };
}

function findingFor(
  crawler: Crawler,
  check: RemotePageCrawlerCheck,
  file: RemotePageRobotsFile,
): Omit<RobotsFinding, "target" | "image"> | undefined {
  if (check.allowed === null) {
    if (policyOf(crawler) === "ignores") return undefined;
    return {
      severity: "unknown",
      code: "robots-unknown",
      message: `Could not tell whether ${name(crawler)} may fetch ${check.url}: ${file.url} was not read (${file.message ?? file.status}).`,
    };
  }
  if (check.allowed) return undefined;
  const severity = severityOf(crawler);
  if (severity === undefined) return undefined;
  if (file.status === "unreachable") {
    const why = file.httpStatus !== undefined ? `responded ${file.httpStatus}` : (file.message ?? "could not be fetched");
    return {
      severity,
      code: "robots-unreachable",
      message: `${file.url} is unreachable (${why}); RFC 9309 crawlers then treat every URL on ${file.origin} as disallowed, including ${check.url} for ${name(crawler)}. ${consequence(crawler)}`,
    };
  }
  return {
    severity,
    code: "robots-disallowed",
    message: `${file.url} disallows ${check.url} for ${name(crawler)} at ${describeRule(check.rule!)}. ${consequence(crawler)}`,
  };
}
