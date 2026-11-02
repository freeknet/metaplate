import type { ImageSize } from "../core/social-image.js";

/**
 * Not an entry point: the HTML, script, and stylesheet `metaplate preview`
 * serves. Every value that reaches the markup passes through `escapeHtml`,
 * because routes, copy, alt text, and error messages all come from the
 * user's render module.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for an HTML text node or a quoted attribute value. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]!);
}

/**
 * A documented preview aspect ratio drawn over each image. Only ratios a
 * platform publishes are listed; docs/preview.md quotes each source.
 */
export type CropGuide = Readonly<{
  id: string;
  label: string;
  /** Width divided by height. */
  ratio: number;
  ratioLabel: string;
  source: string;
}>;

export const CROP_GUIDES: readonly CropGuide[] = [
  {
    id: "open-graph",
    label: "Open Graph link share",
    ratio: 1.91,
    ratioLabel: "1.91:1",
    source: "https://developers.facebook.com/docs/sharing/webmasters/images/",
  },
  {
    id: "x-large",
    label: "X summary_large_image",
    ratio: 2,
    ratioLabel: "2:1",
    source: "https://developer.x.com/en/docs/x-for-websites/cards/overview/summary-card-with-large-image",
  },
  {
    id: "square",
    label: "Square thumbnail (X summary)",
    ratio: 1,
    ratioLabel: "1:1",
    source: "https://developer.x.com/en/docs/x-for-websites/cards/overview/summary",
  },
];

export type CropRegion = { x: number; y: number; width: number; height: number };

/**
 * The largest centered region of `size` with the given aspect ratio: what
 * stays visible if a platform center-crops the image to that ratio. No
 * platform documents its crop anchor, so the center is an assumption the
 * page states.
 */
export function cropRegion(size: ImageSize, ratio: number): CropRegion {
  if (size.width / size.height > ratio) {
    const width = Math.min(size.width, Math.round(size.height * ratio));
    return { x: Math.floor((size.width - width) / 2), y: 0, width, height: size.height };
  }
  const height = Math.min(size.height, Math.round(size.width / ratio));
  return { x: 0, y: Math.floor((size.height - height) / 2), width: size.width, height };
}

export type PreviewFinding = Readonly<{
  /** A `--target` name, or `metadata` for the checks every target shares. */
  target: string;
  compatible: boolean;
  issues: readonly Readonly<{ severity: string; message: string }>[];
}>;

export type PreviewRendered = Readonly<{
  ok: true;
  url: string;
  alt: string | undefined;
  size: ImageSize;
  format: string | null;
  contentType: string;
  bytes: number;
  /** Whether the plate exposes `renderSvg`, which the debug view needs. */
  debuggable: boolean;
  findings: readonly PreviewFinding[];
}>;

export type PreviewImage = Readonly<{
  index: number;
  path: string;
  route: string;
  variant: string | null;
  result: PreviewRendered | Readonly<{ ok: false; message: string }>;
}>;

export type GalleryState = Readonly<{
  /** The module as the user named it. */
  module: string;
  /** Changes on every load and every server start; open pages reload when it does. */
  version: string;
  generation: number;
  loadedAt: Date;
  /** Set when the module failed to load or broke the render contract. */
  error: string | undefined;
  images: readonly PreviewImage[];
  targets: readonly string[];
  /** False where Node has no `module.registerHooks`: imported files are not reloaded. */
  tracksImports: boolean;
}>;

function overlay(guide: CropGuide, size: ImageSize): string {
  const { width, height } = size;
  const region = cropRegion(size, guide.ratio);
  const stroke = Math.max(2, Math.round(Math.max(width, height) / 300));
  // An even-odd path dims everything outside the crop region. Geometry is
  // carried in attributes, which the page's style-src policy permits.
  const shade = `M0 0H${width}V${height}H0Z M${region.x} ${region.y}h${region.width}v${region.height}h${-region.width}Z`;
  return `<svg class="overlay" data-overlay="${guide.id}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true" hidden>` +
    `<path d="${shade}" fill="#000" fill-opacity="0.55" fill-rule="evenodd"/>` +
    `<rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" fill="none" stroke="#ffd400" stroke-width="${stroke}"/>` +
    "</svg>";
}

function findingsList(findings: readonly PreviewFinding[]): string {
  if (findings.length === 0) return "";
  const items = findings.map((finding) => {
    const issues = finding.issues.map((found) =>
      `<li class="issue ${escapeHtml(found.severity)}"><span class="severity">${escapeHtml(found.severity)}</span> ${escapeHtml(found.message)}</li>`).join("");
    const verdict = finding.compatible ? "compatible" : "incompatible";
    return `<li class="finding ${verdict}"><strong>${escapeHtml(finding.target)}</strong> ${verdict}` +
      (issues ? `<ul>${issues}</ul>` : "") + "</li>";
  });
  return `<section class="findings"><h3>Target checks</h3><ul>${items.join("")}</ul></section>`;
}

function imageCard(image: PreviewImage, generation: number): string {
  const title = `<header><h2>${escapeHtml(image.route)}</h2>` +
    `<span class="variant">${escapeHtml(image.variant ?? "default size")}</span></header>`;
  const key = escapeHtml(image.path);
  if (!image.result.ok) {
    return `<article class="card failed" data-key="${key}">${title}` +
      `<dl><dt>Path</dt><dd><code>${key}</code></dd></dl>` +
      `<pre class="error" role="alert">${escapeHtml(image.result.message)}</pre></article>`;
  }
  const result = image.result;
  const { width, height } = result.size;
  const png = `/image/${image.index}?v=${generation}`;
  const debug = `/debug/${image.index}.svg?v=${generation}`;
  const toggles = [
    `<label><input type="checkbox" data-toggle="debug"${result.debuggable ? "" : " disabled"}> Satori debug boxes</label>`,
    ...CROP_GUIDES.map((guide) =>
      `<label><input type="checkbox" data-toggle="overlay" value="${guide.id}"> ${escapeHtml(guide.label)} ${guide.ratioLabel}</label>`),
  ].join("");
  return `<article class="card" data-key="${key}">${title}` +
    `<div class="frame"><img class="plate" src="${png}" data-png="${png}" data-debug="${debug}" ` +
    `width="${width}" height="${height}" alt="${escapeHtml(result.alt ?? "")}">` +
    CROP_GUIDES.map((guide) => overlay(guide, result.size)).join("") + "</div>" +
    `<fieldset class="toggles"><legend>Show</legend>${toggles}</fieldset>` +
    "<dl>" +
    `<dt>Path</dt><dd><a href="${png}"><code>${key}</code></a></dd>` +
    `<dt>URL</dt><dd><code>${escapeHtml(result.url)}</code></dd>` +
    `<dt>Alt</dt><dd>${result.alt === undefined ? "<em>none</em>" : escapeHtml(result.alt)}</dd>` +
    `<dt>Size</dt><dd>${width}x${height}</dd>` +
    `<dt>Format</dt><dd>${escapeHtml(result.format ?? "unverified")} (${escapeHtml(result.contentType)})</dd>` +
    `<dt>Bytes</dt><dd>${result.bytes.toLocaleString("en-US")}</dd>` +
    "</dl>" + findingsList(result.findings) + "</article>";
}

/** The gallery page: one card per page and size, or the module's error. */
export function galleryHtml(state: GalleryState): string {
  const failed = state.images.filter((image) => !image.result.ok).length;
  const summary = [
    `${state.images.length} image${state.images.length === 1 ? "" : "s"}`,
    ...(failed > 0 ? [`${failed} failed`] : []),
    `generation ${state.generation}`,
    `loaded ${state.loadedAt.toLocaleTimeString("en-US", { hour12: false })}`,
    ...(state.targets.length > 0 ? [`targets: ${state.targets.join(", ")}`] : []),
  ].map(escapeHtml).join(" · ");
  const error = state.error === undefined ? "" :
    `<section class="module-error" role="alert"><h2>The render module could not be rendered</h2><pre>${escapeHtml(state.error)}</pre>` +
    "<p>Fix the module and save it: this page reloads on its own.</p></section>";
  const tracking = state.tracksImports ? "" :
    "<p class=\"note\">This Node version has no <code>module.registerHooks</code>, so only the module file itself " +
    "is reloaded; restart the preview after editing a file it imports.</p>";
  const guides = CROP_GUIDES.map((guide) =>
    `<li>${escapeHtml(guide.label)} ${guide.ratioLabel}: <a href="${escapeHtml(guide.source)}" rel="noreferrer">${escapeHtml(guide.source)}</a></li>`).join("");
  return "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    `<title>metaplate preview: ${escapeHtml(state.module)}</title>` +
    "<link rel=\"stylesheet\" href=\"/assets/preview.css\"><script src=\"/assets/preview.js\" defer></script></head>" +
    `<body data-version="${escapeHtml(state.version)}">` +
    `<header class="top"><h1>metaplate preview <code>${escapeHtml(state.module)}</code></h1><p>${summary}</p>${tracking}</header>` +
    `${error}<main class="gallery">${state.images.map((image) => imageCard(image, state.generation)).join("")}</main>` +
    "<footer><p>Overlays dim what falls outside a centered crop to each ratio; the platforms publish the ratio, not the crop anchor.</p>" +
    `<ul>${guides}</ul></footer></body></html>\n`;
}

/** Toggles, remembered across reloads, and the reload-on-change listener. */
export const PREVIEW_SCRIPT = `"use strict";
const STORE = "metaplate-preview-toggles";
function readToggles() {
  try { return JSON.parse(sessionStorage.getItem(STORE) || "{}"); } catch { return {}; }
}
function writeToggles(toggles) {
  try { sessionStorage.setItem(STORE, JSON.stringify(toggles)); } catch { /* storage unavailable */ }
}
function apply(box) {
  const card = box.closest(".card");
  if (box.dataset.toggle === "debug") {
    const image = card.querySelector("img.plate");
    image.src = box.checked ? image.dataset.debug : image.dataset.png;
  } else {
    const overlay = card.querySelector('svg[data-overlay="' + box.value + '"]');
    if (overlay) overlay.hidden = !box.checked;
  }
}
const saved = readToggles();
for (const box of document.querySelectorAll("input[data-toggle]")) {
  const key = box.closest(".card").dataset.key + "|" + box.dataset.toggle + "|" + box.value;
  if (saved[key] && !box.disabled) { box.checked = true; apply(box); }
  box.addEventListener("change", () => {
    apply(box);
    const toggles = readToggles();
    if (box.checked) toggles[key] = true; else delete toggles[key];
    writeToggles(toggles);
  });
}
const version = document.body.dataset.version;
const events = new EventSource("/events");
events.addEventListener("version", (event) => {
  if (event.data !== version) location.reload();
});
`;

export const PREVIEW_STYLES = `:root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1b1b1b; --muted: #5d5d5d; --card: #fff; --line: #d9d9d4; --bad: #b3261e; --warn: #8a5a00; --good: #1e6b34; }
@media (prefers-color-scheme: dark) { :root { --bg: #151515; --fg: #ececec; --muted: #a5a5a5; --card: #202020; --line: #353535; --bad: #ff8a80; --warn: #ffcc66; --good: #7ad19a; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
h1 { font-size: 18px; margin: 0 0 4px; overflow-wrap: anywhere; }
h2 { font-size: 15px; margin: 0; overflow-wrap: anywhere; }
h3 { font-size: 13px; margin: 12px 0 4px; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.top p, .note, footer { color: var(--muted); }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: 16px; margin-top: 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-width: 0; }
.card > header { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; margin-bottom: 8px; }
.variant { color: var(--muted); white-space: nowrap; }
.frame { position: relative; background: repeating-conic-gradient(#8883 0% 25%, transparent 0% 50%) 0 0 / 16px 16px; }
.frame img { display: block; width: 100%; height: auto; }
.overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.toggles { border: 0; padding: 0; margin: 8px 0; display: flex; flex-wrap: wrap; gap: 4px 12px; }
.toggles legend { float: left; margin-right: 8px; color: var(--muted); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 8px 0 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; min-width: 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.error, .module-error pre { color: var(--bad); }
.module-error { border: 1px solid var(--bad); border-radius: 8px; padding: 12px; margin-top: 16px; background: var(--card); }
.findings ul { margin: 0; padding-left: 18px; }
.finding.compatible > strong { color: var(--good); }
.finding.incompatible > strong, .issue.error .severity { color: var(--bad); }
.issue.warning .severity, .issue.unknown .severity { color: var(--warn); }
footer { margin-top: 24px; }
footer a { color: inherit; overflow-wrap: anywhere; }
`;
