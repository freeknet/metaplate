import { renderComponent } from "./font-guard.js";
import { describeTarget, quote, type GuardReport, type GuardTarget } from "./guards.js";

/**
 * Not an entry point: the `lineClamp` render guard, shared by
 * `metaplate/render`, `metaplate/node`, `metaplate/edge`, and
 * `metaplate/takumi`. Web-platform only, so the edge bundle can include it
 * unchanged.
 *
 * Satori ignores a truncation it cannot apply without an error, and the
 * `overflow` guard stays quiet because the full text still fits. Probed on
 * Satori 0.63.2:
 *
 * - `lineClamp` takes effect only on an element whose display is `block`
 *   (written, or the default for its tag: `block` for `div`, `p`, and the
 *   other block elements, `inline` for `span` and unknown tags). `flex`,
 *   `grid`, `inline-block`, `inline-flex`, `list-item`, and `-webkit-box`
 *   ignore it.
 * - `WebkitLineClamp` takes effect only with `display: "-webkit-box"` and
 *   `WebkitBoxOrient: "vertical"`.
 * - `textOverflow: "ellipsis"` takes effect, whatever the display, only with
 *   an `overflow` other than `visible` on either axis (`hidden`, as usually
 *   written) and a `whiteSpace` that does not wrap (`nowrap` or `pre`,
 *   inherited).
 * - Each applies only to text that is the element's own child: text inside a
 *   child element, or beside an inline child such as a `<span>` or `<br>`,
 *   is drawn in full.
 *
 * The guard walks the element tree the component returned, calling nested
 * function components as Satori does, and reads inline styles only: values
 * set by `<style>` rules or `tw` are not seen.
 */

type Style = Readonly<Record<string, unknown>>;

/** A host element with its function components and fragments expanded. */
type Host = { type: string; style: Style | undefined; children: (string | Host)[] };

/** Satori's default display for each tag it styles; any other tag is `inline`. */
const DEFAULT_DISPLAY = new Map<string, string>([
  ...[
    "html", "body", "address", "article", "aside", "details", "dialog", "figcaption", "footer", "form",
    "header", "hgroup", "main", "nav", "search", "section", "summary", "figure", "p", "div", "blockquote",
    "center", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "menu", "dir", "dl", "dt", "dd", "pre",
  ].map((tag) => [tag, "block"] as const),
  ...[
    "area", "base", "basefont", "datalist", "head", "link", "meta", "noembed", "noframes", "param", "rp",
    "script", "style", "template", "title",
  ].map((tag) => [tag, "none"] as const),
  ...["input", "button", "select", "textarea"].map((tag) => [tag, "inline-block"] as const),
  ["li", "list-item"],
]);

/** Element types whose children are not text Satori lays out. */
const OPAQUE_ELEMENTS = new Set(["style", "svg", "img"]);

/** `whiteSpace` values Satori never soft-wraps, which `textOverflow` needs. */
const NO_WRAP = new Set(["nowrap", "pre"]);

function styleOf(props: Record<string, unknown> | undefined): Style | undefined {
  const style = props?.style;
  return typeof style === "object" && style !== null ? (style as Style) : undefined;
}

/** Appends `node`'s strings and host elements to `out`, expanding components, fragments, and arrays. */
function expand(node: unknown, out: (string | Host)[], depth: number): void {
  if (depth > 256 || node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") {
    out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) expand(child, out, depth + 1);
    return;
  }
  if (typeof node !== "object" || !("type" in node)) return;
  const { type, props } = node as { type: unknown; props?: Record<string, unknown> };
  if (typeof type === "function") {
    expand(renderComponent(type as (props: unknown) => unknown, props), out, depth + 1);
    return;
  }
  if (typeof type !== "string") {
    // A fragment: its children belong to the parent.
    expand(props?.children, out, depth + 1);
    return;
  }
  const children: (string | Host)[] = [];
  if (!OPAQUE_ELEMENTS.has(type)) expand(props?.children, children, depth + 1);
  out.push({ type, style: styleOf(props), children });
}

function displayOf(host: Host): string {
  const written = host.style?.display;
  const display = typeof written === "string" && written.trim() !== "" ? written : DEFAULT_DISPLAY.get(host.type);
  return (display ?? "inline").trim();
}

const isInline = (display: string): boolean => display === "inline" || display.startsWith("inline-");

/** The element's own text: its direct string children. */
const ownText = (host: Host): string => host.children.filter((child) => typeof child === "string").join("");

/** The first text anywhere inside the element, for the report when it has none of its own. */
function firstText(host: Host): string {
  for (const child of host.children) {
    if (typeof child === "string") {
      if (child.trim() !== "") return child;
    } else if (displayOf(child) !== "none") {
      const text = firstText(child);
      if (text !== "") return text;
    }
  }
  return "";
}

/** A clamp count Satori would act on: a positive number, or a string that starts with one. */
function clampCount(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value !== "string") return false;
  const match = /^\s*(\d+)/.exec(value);
  return match !== null && Number(match[1]) > 0;
}

/**
 * Whether either axis overflows anything but `visible`: Satori then treats the
 * element as `overflow: "hidden"`, which is what `textOverflow` checks.
 */
function clipsOverflow(style: Style): boolean {
  const shorthand = typeof style.overflow === "string" ? style.overflow.trim().split(/\s+/) : [];
  const axis = (value: unknown, fallback: string | undefined) =>
    (typeof value === "string" && value.trim() !== "" ? value.trim() : fallback) ?? "visible";
  const x = axis(style.overflowX, shorthand[0]);
  const y = axis(style.overflowY, shorthand[1] ?? shorthand[0]);
  return x !== "visible" || y !== "visible";
}

function written(property: string, value: unknown): string {
  return `${property}: ${typeof value === "number" ? value : JSON.stringify(value)}`;
}

type Reason = "display" | "children" | "overflow" | "whiteSpace";
type Property = "lineClamp" | "WebkitLineClamp" | "textOverflow";

/**
 * Why Satori draws `host`'s text without the truncation its own style asks
 * for, or `undefined` when the truncation applies (or none is asked for).
 */
function ignoredTruncation(
  host: Host,
  display: string,
  whiteSpace: string,
): { property: Property; reason: Reason; detail: string } | undefined {
  const style = host.style ?? {};
  const own = ownText(host);
  const inlineChild = host.children.find((child): child is Host => typeof child !== "string" && isInline(displayOf(child)));
  const children = (): string | undefined => {
    if (own.trim() === "") {
      const holder = host.children.find((child): child is Host => typeof child !== "string" && firstText(child) !== "");
      return `its text is inside a child <${holder?.type ?? "div"}>`;
    }
    return inlineChild ? `its text sits beside an inline <${inlineChild.type}>` : undefined;
  };
  const defaulted = typeof style.display === "string" && style.display.trim() !== "" ? "" : ` (the default for <${host.type}>)`;

  if (clampCount(style.lineClamp)) {
    const property = "lineClamp";
    const asked = written(property, style.lineClamp);
    if (display !== "block") {
      return {
        property,
        reason: "display",
        detail:
          `sets ${asked}, but its display is ${JSON.stringify(display)}${defaulted} and Satori clamps only an element ` +
          `with display: "block", so every line is drawn; add display: "block" to that element`,
      };
    }
    const why = children();
    return why === undefined ? undefined : {
      property,
      reason: "children",
      detail:
        `sets ${asked}, but ${why}, and Satori clamps only text that is the element's own child with no inline ` +
        "element beside it, so every line is drawn; move the clamp onto the element that holds the text, or pass the text as one string",
    };
  }
  if (clampCount(style.WebkitLineClamp)) {
    const property = "WebkitLineClamp";
    const asked = written(property, style.WebkitLineClamp);
    if (display !== "-webkit-box" || style.WebkitBoxOrient !== "vertical") {
      return {
        property,
        reason: "display",
        detail:
          `sets ${asked}, but Satori honors it only with display: "-webkit-box" and WebkitBoxOrient: "vertical" ` +
          `(its display is ${JSON.stringify(display)}${defaulted}), so every line is drawn; use lineClamp with display: "block" instead`,
      };
    }
    const why = children();
    return why === undefined ? undefined : {
      property,
      reason: "children",
      detail:
        `sets ${asked}, but ${why}, and Satori clamps only text that is the element's own child with no inline ` +
        "element beside it, so every line is drawn; move the clamp onto the element that holds the text, or pass the text as one string",
    };
  }
  if (style.textOverflow === "ellipsis") {
    const property = "textOverflow";
    const asked = written(property, style.textOverflow);
    if (!clipsOverflow(style)) {
      return {
        property,
        reason: "overflow",
        detail:
          `sets ${asked} without overflow: "hidden", so Satori never draws the ellipsis; ` +
          'add overflow: "hidden" and whiteSpace: "nowrap"',
      };
    }
    if (!NO_WRAP.has(whiteSpace)) {
      return {
        property,
        reason: "whiteSpace",
        detail:
          `sets ${asked}, but its whiteSpace is ${JSON.stringify(whiteSpace)}, which wraps, so Satori never draws the ellipsis; ` +
          'add whiteSpace: "nowrap", or clamp it to one line with display: "block" and lineClamp: 1',
      };
    }
    const why = children();
    return why === undefined ? undefined : {
      property,
      reason: "children",
      detail:
        `sets ${asked}, but ${why}, and Satori draws the ellipsis only for text that is the element's own child ` +
        "with no inline element beside it; move the style onto the element that holds the text, or pass the text as one string",
    };
  }
  return undefined;
}

function check(host: Host, inheritedWhiteSpace: string, report: GuardReport, target: GuardTarget): void {
  const display = displayOf(host);
  if (display === "none") return;
  const declared = host.style?.whiteSpace;
  const whiteSpace = typeof declared === "string" && declared.trim() !== "" && declared !== "inherit"
    ? declared.trim()
    : inheritedWhiteSpace;
  const text = ownText(host).trim() !== "" ? ownText(host) : firstText(host);
  if (text !== "") {
    const ignored = ignoredTruncation(host, display, whiteSpace);
    if (ignored) {
      report.add({
        guard: "lineClamp",
        variant: target.variant,
        size: target.size,
        element: host.type,
        text,
        property: ignored.property,
        display,
        reason: ignored.reason,
        message: `Text ${quote(text)} in a <${host.type}> in ${describeTarget(target)} ${ignored.detail}`,
      });
    }
  }
  for (const child of host.children) {
    if (typeof child !== "string") check(child, whiteSpace, report, target);
  }
}

/**
 * Reports each element whose inline `lineClamp`, `WebkitLineClamp`, or
 * `textOverflow: "ellipsis"` Satori would ignore, drawing its text in full.
 */
export function checkLineClamp(element: unknown, report: GuardReport, target: GuardTarget): void {
  const roots: (string | Host)[] = [];
  expand(element, roots, 0);
  for (const root of roots) {
    if (typeof root !== "string") check(root, "normal", report, target);
  }
}
