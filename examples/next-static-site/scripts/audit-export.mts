// scripts/audit-export.mts
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { verifySocialImage } from "metaplate";
import { extractPageSocialMetadata } from "metaplate/node";
import { ALL_CARDS } from "../src/lib/og/cards";
import { og } from "../src/lib/og/plate";
import { SITE } from "../src/lib/site";

/*
 * Checks every exported page offline: reads the `og:image` the HTML names, checks
 * it is that page's own card, finds the file in `out/`, and verifies its bytes
 * against the tags. A page whose card is missing or wrong fails the build. Network
 * checks come after the deploy, with `metaplate verify-page`.
 */
const OUT = path.resolve("out");
const TARGETS = ["universal", "facebook", "linkedin", "slack", "whatsapp", "x"] as const;

// Crawlers require HTTPS image URLs. A local or CI build whose origin is
// `http://localhost` would fail that rule on every page, so it checks the files
// and tags alone, and a production build checks the URLs too.
const CHECK_URLS = SITE.origin.startsWith("https://");

// Each route's own card, so a page that inherits another page's metadata fails.
const EXPECTED = new Map(ALL_CARDS.map(({ route }) => [route, `/${og.sitePath(route)}`]));

const entries = await readdir(OUT, { recursive: true, withFileTypes: true });
const pages = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
  .map((entry) => path.join(entry.parentPath, entry.name))
  .filter((file) => !/[\\/]_next[\\/]|[\\/](404|_not-found)[\\/.]/.test(file));

const failures: string[] = [];

for (const file of pages) {
  const page = path.relative(OUT, file).replaceAll("\\", "/");
  const route = `/${page.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "")}`;
  const documentUrl = new URL(page, `${SITE.origin}/`).href;
  const { openGraph } = extractPageSocialMetadata(await readFile(file, "utf8"), documentUrl);
  const [image] = openGraph.images;
  if (!image?.url) {
    failures.push(`${page}: no og:image`);
    continue;
  }

  // Values come back as written, so resolve a relative URL against the page.
  // `?v=` is a cache-busting token on the URL; the file on disk does not carry it.
  const { pathname } = new URL(image.url, documentUrl);
  if (pathname !== EXPECTED.get(route)) {
    failures.push(`${page}: names ${pathname}, not its own card ${EXPECTED.get(route) ?? "(none registered)"}`);
    continue;
  }
  const bytes = await readFile(path.join(OUT, pathname)).catch(() => undefined);
  if (!bytes) {
    failures.push(`${page}: ${image.url} is not in the export`);
    continue;
  }
  const width = Number(image.width);
  const height = Number(image.height);
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    failures.push(`${page}: og:image:width and og:image:height must both be set`);
    continue;
  }

  // A missing alt is passed as "" so the targets' alt-text rule fails it.
  const report = verifySocialImage(
    bytes,
    { url: image.url, alt: image.alt ?? "", ...(image.type ? { type: image.type } : {}), width, height },
    { targets: TARGETS, checkUrl: CHECK_URLS },
  );
  for (const issue of report.issues) {
    if (issue.severity === "error") failures.push(`${page}: ${issue.target ?? ""} ${issue.message}`);
  }
}

if (failures.length > 0) {
  console.error(`Social card audit failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`Social card audit: ${pages.length} pages verified`);
