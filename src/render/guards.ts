import type { ImageSize } from "../core/social-image.js";

/**
 * Not an entry point: render guards, shared by `metaplate/render`,
 * `metaplate/node`, and `metaplate/edge`. Web-platform only, so the edge
 * bundle can include it unchanged.
 */

/**
 * What a guard does when it finds a problem: `"error"` fails the render with a
 * `RenderGuardError`, `"warn"` reports the problem and returns the image, and
 * `"off"` (the default) skips the check entirely.
 */
export type RenderGuardLevel = "error" | "warn" | "off";

/** Guards every renderer can run, because each works on Satori's layout. */
export type RenderGuards = {
  /**
   * Text Satori had to ask `loadAdditionalAsset` for, because no plate font
   * covers it, and that came back with no font or image. Satori draws such
   * text from fonts that lack it: missing-glyph boxes ("tofu") or nothing.
   */
  missingGlyphs?: RenderGuardLevel;
  /**
   * An element holding text whose laid-out box reaches outside the canvas.
   * Only text-bearing elements are checked, so decorative shapes and images
   * may bleed off the edge on purpose.
   */
  overflow?: RenderGuardLevel;
  /**
   * Text whose laid-out box reaches outside the safe area: by default the
   * part of a landscape canvas that survives the centered 2:1 (X
   * `summary_large_image`) and 1.91:1 (Open Graph) crops, which trims 15px
   * from the top and bottom of 1200x630. A square or portrait canvas has no
   * default crop. `inset` replaces the default with a margin in pixels from
   * every edge, or from the left/right (`x`) and top/bottom (`y`) edges.
   */
  safeArea?: SafeAreaGuard;
  /** Two text-bearing elements whose laid-out boxes intersect. */
  textOverlap?: RenderGuardLevel;
  /**
   * Text that comes within `gap` pixels (default 0) of an element whose
   * React `key` is listed in `keys`, such as the photo a headline must not
   * run under. Key the element to keep clear, not a container that holds
   * the text.
   */
  avoid?: AvoidGuard;
  /**
   * Receives each problem found by a guard set to `"warn"`. Without it,
   * warnings go to `console.warn`, so a `"warn"` guard is never silent.
   */
  onWarning?: (warning: RenderGuardIssue) => void;
};

/** `safeArea`: a level, or a level with its own inset. */
export type SafeAreaGuard =
  | RenderGuardLevel
  | Readonly<{ level: RenderGuardLevel; inset?: number | Readonly<{ x: number; y: number }> }>;

/** `avoid`: the keys of elements text must stay clear of, and by how much. */
export type AvoidGuard = Readonly<{ level: RenderGuardLevel; keys: readonly (string | number)[]; gap?: number }>;

/** Guards for renderers that rasterise, adding a check on the pixels. */
export type RasterRenderGuards = RenderGuards & {
  /**
   * A rasterised image in which every pixel is the same color (fully
   * transparent pixels count as one color whatever their RGB). Checked on the
   * raw pixels before encoding, so it costs one pass that stops at the first
   * differing pixel.
   */
  blank?: RenderGuardLevel;
};

export type RenderGuardName = "missingGlyphs" | "overflow" | "safeArea" | "textOverlap" | "avoid" | "blank";

type IssueBase = Readonly<{
  /** The variant being rendered; `undefined` for the plate's default size. */
  variant: string | undefined;
  size: ImageSize;
  message: string;
}>;

/** A laid-out box in canvas pixels, before any CSS `transform`. */
export type RenderGuardBox = Readonly<{ left: number; top: number; width: number; height: number }>;

/** One problem a guard found in one render. */
export type RenderGuardIssue =
  | (IssueBase & Readonly<{
      guard: "missingGlyphs";
      /** Satori's language code for the text, such as `ja-JP|zh-CN`, `emoji`, or `unknown`. */
      languageCode: string;
      /** The characters left without a font or image. */
      segment: string;
    }>)
  | (IssueBase & Readonly<{
      guard: "overflow";
      /** The element's type, such as `div`. */
      element: string;
      /** The element's own text. */
      text: string;
      box: RenderGuardBox;
    }>)
  | (IssueBase & Readonly<{
      guard: "safeArea";
      element: string;
      text: string;
      box: RenderGuardBox;
      /** The area text must stay inside. */
      safeArea: RenderGuardBox;
    }>)
  | (IssueBase & Readonly<{
      guard: "textOverlap";
      element: string;
      text: string;
      box: RenderGuardBox;
      /** The text this text overlaps. */
      other: Readonly<{ element: string; text: string; box: RenderGuardBox }>;
    }>)
  | (IssueBase & Readonly<{
      guard: "avoid";
      element: string;
      text: string;
      box: RenderGuardBox;
      /** The keyed element the text comes too close to. */
      avoided: Readonly<{ element: string; key: string; box: RenderGuardBox }>;
    }>)
  | (IssueBase & Readonly<{
      guard: "blank";
      /** The single color of every pixel, as RGBA bytes. */
      color: readonly [number, number, number, number];
    }>);

/** A render that a guard set to `"error"` refused to return. */
export class RenderGuardError extends Error {
  /** Every error-level problem found in the render, in the order found. */
  readonly issues: readonly RenderGuardIssue[];

  constructor(issues: readonly RenderGuardIssue[]) {
    const [first] = issues;
    const more = issues.length > 1 ? ` (and ${issues.length - 1} more render guard issue${issues.length > 2 ? "s" : ""})` : "";
    super(`${first?.message ?? "Render guard failed"}${more}`);
    this.name = "RenderGuardError";
    this.issues = Object.freeze([...issues]);
  }
}

/** Where a render is happening, for issue reports. */
export type GuardTarget = Readonly<{ variant: string | undefined; size: ImageSize }>;

type GuardLevels = Readonly<{
  [Name in RenderGuardName]?: RenderGuardLevel | Readonly<{ level: RenderGuardLevel }>;
}> & {
  onWarning?: ((warning: RenderGuardIssue) => void) | undefined;
};

const LEVELS = new Set<unknown>(["error", "warn", "off"]);
const GUARD_NAMES: readonly RenderGuardName[] = ["missingGlyphs", "overflow", "safeArea", "textOverlap", "avoid", "blank"];

/** The guards that work on Satori's layout, which every renderer can run. */
export const LAYOUT_GUARD_NAMES: readonly RenderGuardName[] = ["missingGlyphs", "overflow", "safeArea", "textOverlap", "avoid"];

const isPixels = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The level of a guard written as a level or as `{ level, ... }`, validating the object form's options. */
function configuredLevel(name: RenderGuardName, value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    if (name === "avoid") throw new TypeError("guards.avoid must be { level, keys, gap? }");
    return value;
  }
  if (name !== "safeArea" && name !== "avoid") throw new TypeError(`guards.${name} must be "error", "warn", or "off"`);
  const options = value as Record<string, unknown>;
  if (name === "safeArea") {
    const inset = options.inset as { x?: unknown; y?: unknown } | number | undefined;
    const valid = inset === undefined || isPixels(inset) ||
      (typeof inset === "object" && inset !== null && isPixels(inset.x) && isPixels(inset.y));
    if (!valid) throw new TypeError("guards.safeArea.inset must be a non-negative number or { x, y } of them");
  } else {
    const { keys, gap } = options;
    const validKeys = Array.isArray(keys) && keys.length > 0 &&
      keys.every((key) => (typeof key === "string" && key !== "") || (typeof key === "number" && Number.isFinite(key)));
    if (!validKeys) throw new TypeError("guards.avoid.keys must be a non-empty array of React keys");
    if (gap !== undefined && !isPixels(gap)) throw new TypeError("guards.avoid.gap must be a non-negative number");
  }
  return options.level;
}

/**
 * Validates a plate's `guards` at definition time, so a typo such as
 * `"warning"` fails where it was written rather than silently disabling a
 * check. `allowed` names the guards the renderer can run.
 */
export function assertRenderGuards(guards: unknown, allowed: readonly RenderGuardName[], entry: string): void {
  if (guards === undefined) return;
  if (guards === null || typeof guards !== "object") {
    throw new TypeError("guards must be an object");
  }
  const record = guards as Record<string, unknown>;
  for (const name of GUARD_NAMES) {
    if (record[name] === undefined) continue;
    const level = configuredLevel(name, record[name]);
    if (!LEVELS.has(level)) {
      const field = typeof record[name] === "object" ? `guards.${name}.level` : `guards.${name}`;
      throw new TypeError(`${field} must be "error", "warn", or "off"`);
    }
    if (level !== "off" && !allowed.includes(name)) {
      throw new TypeError(
        `${entry} cannot run guards.${name}: it never sees the rendered pixels. ` +
          "Use metaplate/node or metaplate/edge for the blank guard.",
      );
    }
  }
  if (record.onWarning !== undefined && typeof record.onWarning !== "function") {
    throw new TypeError("guards.onWarning must be a function");
  }
}

export function guardLevel(guards: GuardLevels | undefined, name: RenderGuardName): RenderGuardLevel {
  const value = guards?.[name];
  if (value === undefined) return "off";
  return typeof value === "string" ? value : value.level;
}

/**
 * Collects the issues of one render, then reports warnings and throws for
 * errors once the render step has finished, so one error lists everything
 * that step found rather than only the first problem.
 */
export class GuardReport {
  private readonly errors: RenderGuardIssue[] = [];
  private readonly warnings: RenderGuardIssue[] = [];

  constructor(private readonly guards: GuardLevels | undefined) {}

  add(issue: RenderGuardIssue): void {
    const level = guardLevel(this.guards, issue.guard);
    if (level === "error") this.errors.push(issue);
    else if (level === "warn") this.warnings.push(issue);
  }

  settle(): void {
    const warn = this.guards?.onWarning ?? defaultWarning;
    for (const warning of this.warnings.splice(0)) warn(warning);
    const errors = this.errors.splice(0);
    if (errors.length > 0) throw new RenderGuardError(errors);
  }
}

function defaultWarning(warning: RenderGuardIssue): void {
  console.warn(`metaplate: ${warning.message}`);
}

function describeTarget(target: GuardTarget): string {
  const { width, height } = target.size;
  return target.variant === undefined
    ? `the ${width}x${height} plate`
    : `variant "${target.variant}" (${width}x${height})`;
}

function quote(text: string, limit = 60): string {
  const single = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(single.length > limit ? `${single.slice(0, limit - 1)}…` : single);
}

/** Satori's own asset contract: a string is an image, a list or object is fonts. */
function isEmptyAsset(asset: unknown): boolean {
  return asset === undefined || asset === null || asset === "" || (Array.isArray(asset) && asset.length === 0);
}

/** Removes the graphemes `graphemeImages` draws, which Satori still reports as missing from the fonts. */
function withoutImages(segment: string, images: Readonly<Record<string, string>> | undefined): string {
  if (!images) return segment;
  let rest = segment;
  for (const [grapheme, image] of Object.entries(images)) {
    if (grapheme !== "" && image) rest = rest.split(grapheme).join("");
  }
  return rest;
}

type AssetLoader = (languageCode: string, segment: string) => Promise<unknown>;

/**
 * Wraps the `loadAdditionalAsset` Satori will call. Satori calls it only for
 * text no supplied font covers (once per language code and segment in a
 * render); when the whole chain answers with nothing, Satori draws the text
 * from fonts that lack it, which is exactly what this guard reports.
 */
export function guardAssetLoader<Loader extends AssetLoader>(
  loader: Loader | undefined,
  report: GuardReport,
  target: GuardTarget,
  graphemeImages: Readonly<Record<string, string>> | undefined,
): Loader {
  return (async (languageCode: string, segment: string) => {
    const asset = loader ? await loader(languageCode, segment) : [];
    const unresolved = withoutImages(segment, graphemeImages);
    if (isEmptyAsset(asset) && unresolved !== "") {
      const remedy = languageCode === "emoji"
        ? "set the plate's emoji option to draw emoji as images"
        : "add a font that covers it to fonts, or return one from satori.loadAdditionalAsset";
      report.add({
        guard: "missingGlyphs",
        variant: target.variant,
        size: target.size,
        languageCode,
        segment: unresolved,
        message:
          `Missing glyphs in ${describeTarget(target)}: no font or image for ${quote(unresolved)} ` +
          `(Satori language code "${languageCode}"); ${remedy}`,
      });
    }
    return asset;
  }) as Loader;
}

/** What Satori's `onNodeDetected` reports for one laid-out element. */
export type DetectedNode = {
  left: number;
  top: number;
  width: number;
  height: number;
  type: string;
  key?: string | number | null;
  textContent?: unknown;
};

/** Sub-pixel slack for layout rounding (for example under `pointScaleFactor`). */
const OVERFLOW_TOLERANCE = 0.5;

/** The text an element lays out itself: a string, a number, or those inside an array of children. */
function ownText(content: unknown): string {
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "bigint") return String(content);
  if (Array.isArray(content)) return content.map(ownText).join("");
  return "";
}

/**
 * Reports a text-bearing element whose layout box is not wholly inside the
 * canvas. Elements without their own text, such as a decorative shape or an
 * image deliberately bleeding off the edge, are never reported.
 */
export function overflowDetector(report: GuardReport, target: GuardTarget) {
  const { width: canvasWidth, height: canvasHeight } = target.size;
  return (node: DetectedNode): void => {
    const text = ownText(node.textContent);
    if (text.trim() === "") return;
    const { left, top, width, height } = node;
    const inside =
      left >= -OVERFLOW_TOLERANCE &&
      top >= -OVERFLOW_TOLERANCE &&
      left + width <= canvasWidth + OVERFLOW_TOLERANCE &&
      top + height <= canvasHeight + OVERFLOW_TOLERANCE;
    if (inside) return;
    const box = Object.freeze({ left, top, width, height });
    report.add({
      guard: "overflow",
      variant: target.variant,
      size: target.size,
      element: node.type,
      text,
      box,
      message:
        `Text ${quote(text)} in a <${node.type}> is laid out at ${round(left)},${round(top)} ` +
        `${round(width)}x${round(height)}, outside ${describeTarget(target)}; ` +
        "a root with width/height 100% and padding needs boxSizing: \"border-box\"",
    });
  };
}

type TextBox = { element: string; text: string; box: RenderGuardBox };
type KeyedBox = { element: string; key: string; box: RenderGuardBox };

/** The default safe area keeps what the centered 2:1 and 1.91:1 crops of a landscape canvas keep. */
const WIDE_CROPS = [2, 1.91] as const;

/** The safe area of a canvas, from `safeArea`'s inset or the default crops. */
export function safeAreaBox(size: ImageSize, guard: SafeAreaGuard | undefined): RenderGuardBox {
  const { width, height } = size;
  const inset = typeof guard === "object" ? guard.inset : undefined;
  let x = 0;
  let y = 0;
  if (inset !== undefined) {
    x = typeof inset === "number" ? inset : inset.x;
    y = typeof inset === "number" ? inset : inset.y;
  } else if (width > height) {
    for (const ratio of WIDE_CROPS) {
      if (width / height > ratio) x = Math.max(x, (width - height * ratio) / 2);
      else y = Math.max(y, (height - width / ratio) / 2);
    }
  }
  return Object.freeze({ left: x, top: y, width: Math.max(0, width - 2 * x), height: Math.max(0, height - 2 * y) });
}

/** Whether `inner` lies within `outer`, give or take layout rounding. */
function contains(outer: RenderGuardBox, inner: RenderGuardBox): boolean {
  return (
    inner.left >= outer.left - OVERFLOW_TOLERANCE &&
    inner.top >= outer.top - OVERFLOW_TOLERANCE &&
    inner.left + inner.width <= outer.left + outer.width + OVERFLOW_TOLERANCE &&
    inner.top + inner.height <= outer.top + outer.height + OVERFLOW_TOLERANCE
  );
}

/** Whether two boxes share more than layout rounding in both directions. */
function intersects(a: RenderGuardBox, b: RenderGuardBox): boolean {
  const across = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const down = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return across > OVERFLOW_TOLERANCE && down > OVERFLOW_TOLERANCE;
}

function describeBox({ left, top, width, height }: RenderGuardBox): string {
  return `${round(left)},${round(top)} ${round(width)}x${round(height)}`;
}

/**
 * The `safeArea`, `textOverlap`, and `avoid` guards. They compare boxes
 * across the whole layout, so `detect` collects every text-bearing and keyed
 * element and `finish` reports once Satori has laid out everything. Returns
 * `undefined` when all three are off.
 */
export function layoutGuards(
  guards: RenderGuards | undefined,
  report: GuardReport,
  target: GuardTarget,
): { detect: (node: DetectedNode) => void; finish: () => void } | undefined {
  const safe = guardLevel(guards, "safeArea") !== "off";
  const overlap = guardLevel(guards, "textOverlap") !== "off";
  const avoid = guardLevel(guards, "avoid") !== "off" ? guards?.avoid : undefined;
  if (!safe && !overlap && !avoid) return undefined;
  const avoidKeys = new Set((avoid?.keys ?? []).map(String));
  const texts: TextBox[] = [];
  const keyed: KeyedBox[] = [];
  const at = { variant: target.variant, size: target.size };

  function checkSafeArea() {
    const area = safeAreaBox(target.size, guards?.safeArea);
    for (const { element, text, box } of texts) {
      if (contains(area, box)) continue;
      report.add({
        ...at, guard: "safeArea", element, text, box, safeArea: area,
        message:
          `Text ${quote(text)} in a <${element}> is laid out at ${describeBox(box)}, outside the safe area ` +
          `${describeBox(area)} of ${describeTarget(target)}; move it inward or set guards.safeArea.inset`,
      });
    }
  }

  function checkOverlap() {
    texts.forEach((first, index) => {
      for (const second of texts.slice(index + 1)) {
        if (!intersects(first.box, second.box)) continue;
        report.add({
          ...at, guard: "textOverlap", element: first.element, text: first.text, box: first.box,
          other: Object.freeze({ ...second }),
          message:
            `Text ${quote(first.text)} (<${first.element}> at ${describeBox(first.box)}) overlaps text ` +
            `${quote(second.text)} (<${second.element}> at ${describeBox(second.box)}) in ${describeTarget(target)}`,
        });
      }
    });
  }

  function checkAvoid(gap: number) {
    const relation = gap === 0 ? "overlaps" : `is within ${gap}px of`;
    for (const { element, text, box } of texts) {
      const reach = { left: box.left - gap, top: box.top - gap, width: box.width + 2 * gap, height: box.height + 2 * gap };
      for (const avoided of keyed) {
        // A keyed element's own text belongs to it rather than running into it.
        if (avoided.box === box || !intersects(reach, avoided.box)) continue;
        report.add({
          ...at, guard: "avoid", element, text, box, avoided: Object.freeze({ ...avoided }),
          message:
            `Text ${quote(text)} in a <${element}> at ${describeBox(box)} ${relation} the element ` +
            `keyed ${JSON.stringify(avoided.key)} (<${avoided.element}> at ${describeBox(avoided.box)}) in ${describeTarget(target)}`,
        });
      }
    }
  }

  return {
    detect(node) {
      const box = Object.freeze({ left: node.left, top: node.top, width: node.width, height: node.height });
      const text = ownText(node.textContent);
      if (text.trim() !== "") texts.push({ element: node.type, text, box });
      if (node.key !== undefined && node.key !== null && avoidKeys.has(String(node.key))) {
        keyed.push({ element: node.type, key: String(node.key), box });
      }
    },
    finish() {
      if (safe) checkSafeArea();
      if (overlap) checkOverlap();
      if (avoid) checkAvoid(avoid.gap ?? 0);
    },
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The single color of an RGBA pixmap, or `undefined` once any pixel differs.
 * Fully transparent pixels compare equal whatever their color channels hold.
 */
export function uniformColor(pixels: Uint8Array): [number, number, number, number] | undefined {
  if (pixels.length < 4) return undefined;
  const first = pixel(pixels, 0);
  const transparent = first[3] === 0;
  for (let offset = 4; offset + 3 < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3];
    if (transparent) {
      if (alpha !== 0) return undefined;
    } else if (
      alpha !== first[3] ||
      pixels[offset] !== first[0] ||
      pixels[offset + 1] !== first[1] ||
      pixels[offset + 2] !== first[2]
    ) {
      return undefined;
    }
  }
  return transparent ? [0, 0, 0, 0] : first;
}

function pixel(pixels: Uint8Array, offset: number): [number, number, number, number] {
  return [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0, pixels[offset + 3] ?? 0];
}

/** Reports a rasterised frame in which every pixel is one color. */
export function checkBlank(pixels: Uint8Array, report: GuardReport, target: GuardTarget): void {
  const color = uniformColor(pixels);
  if (!color) return;
  report.add({
    guard: "blank",
    variant: target.variant,
    size: target.size,
    color: Object.freeze(color),
    message:
      `Blank render: every pixel of ${describeTarget(target)} is rgba(${color.slice(0, 3).join(", ")}, ` +
      `${round(color[3] / 255)}); check for text drawn off the canvas or fonts that did not load`,
  });
}
