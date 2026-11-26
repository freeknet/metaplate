import { describeTarget, quote, type GuardReport, type GuardTarget } from "./guards.js";

/**
 * Not an entry point: the `fontFallback` render guard, shared by
 * `metaplate/render`, `metaplate/node`, and `metaplate/edge`. Web-platform
 * only, so the edge bundle can include it unchanged.
 *
 * Satori never fails on a font it does not have. A `fontFamily` stack with no
 * loaded family is drawn with the first loaded font, and a weight or style
 * the family lacks is drawn with another of its faces, so a card can ship in
 * the wrong typeface with no error. Satori's `onNodeDetected` reports each
 * element's own declarations but not what it inherits, so this guard walks
 * the element tree itself, carrying inline `fontFamily`, `fontWeight`, and
 * `fontStyle` down to every text it finds, starting each element from its
 * renderer's default style for the tag (`<h1>` and `<strong>` bold, `<em>`
 * italic, `<code>` monospace) as the renderer does. Custom properties declared
 * in inline styles are inherited and resolve `var()` the same way. Values set
 * by `<style>` rules or `tw` are not seen.
 */

/** A face the render can draw with: a plate font, or one a loader returned. */
export type LoadedFace = Readonly<{ name: string; weight?: number; style?: string }>;

type FontRequest = Readonly<{
  /** The `fontFamily` stack as written, or `undefined` when none applies. */
  family: string | undefined;
  /** `true` when the family is a `var()` with no value or fallback: the request is not checked. */
  unresolved: boolean;
  /** `undefined` when the weight is relative or not a plain value, so no face check is possible. */
  weight: number | undefined;
  style: "normal" | "italic" | undefined;
  /** Custom properties in scope, as declared (unresolved), keyed with their leading `--`. */
  vars: ReadonlyMap<string, string>;
}>;

const INITIAL: FontRequest = { family: undefined, unresolved: false, weight: 400, style: "normal", vars: new Map() };

/** The font properties a renderer's default style for a tag sets, the only ones this guard reads. */
type FontPreset = Readonly<{ fontFamily?: string; fontWeight?: string; fontStyle?: string }>;

/** Which renderer's tag defaults and keyword handling the walk mirrors. */
export type FontRenderer = "satori" | "takumi";

const BOLD: FontPreset = { fontWeight: "bold" };
const ITALIC: FontPreset = { fontStyle: "italic" };
const MONOSPACE: FontPreset = { fontFamily: "monospace" };

/**
 * Satori's default element styles (the tag table in satori/dist/index.js,
 * applied under each element's inline style), reduced to font properties.
 */
const SATORI_PRESETS: Readonly<Record<string, FontPreset>> = {
  h1: BOLD, h2: BOLD, h3: BOLD, h4: BOLD, h5: BOLD, h6: BOLD, strong: BOLD, b: BOLD,
  i: ITALIC, em: ITALIC,
  code: MONOSPACE, kbd: MONOSPACE, pre: MONOSPACE,
  select: { fontWeight: "normal", fontStyle: "normal" },
};

/**
 * Takumi's default element styles (`defaultStyles` in @takumi-rs/helpers,
 * used by `fromJsx`), reduced to font properties. They differ from Satori's:
 * `<strong>` and `<b>` are `bolder`, and `<th>`, `<address>`, `<cite>`,
 * `<dfn>`, and `<samp>` are styled too.
 */
const TAKUMI_PRESETS: Readonly<Record<string, FontPreset>> = {
  h1: BOLD, h2: BOLD, h3: BOLD, h4: BOLD, h5: BOLD, h6: BOLD, th: BOLD,
  strong: { fontWeight: "bolder" }, b: { fontWeight: "bolder" },
  i: ITALIC, em: ITALIC, cite: ITALIC, dfn: ITALIC, address: ITALIC,
  code: MONOSPACE, kbd: MONOSPACE, samp: MONOSPACE, pre: MONOSPACE,
};

const PRESETS: Readonly<Record<FontRenderer, Readonly<Record<string, FontPreset>>>> = {
  satori: SATORI_PRESETS,
  takumi: TAKUMI_PRESETS,
};

/** CSS generic families and keywords: Satori loads no font under these names. */
const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif",
  "ui-monospace", "ui-rounded", "emoji", "math", "fangsong", "inherit", "initial", "unset", "revert",
]);

/** Element types whose children are not text Satori lays out with the plate's fonts. */
const OPAQUE_ELEMENTS = new Set(["style", "svg", "img"]);

/** Satori matches family names case-insensitively and without quotes. */
const familyKey = (name: string): string => name.trim().replace(/^(["'])(.*)\1$/, "$2").trim().toLowerCase();

function familyStack(family: string): string[] {
  return family.split(",").map(familyKey).filter((name) => name !== "" && !GENERIC_FAMILIES.has(name));
}

/** CSS's relative weights: `bolder` and `lighter` against the inherited weight. */
function relativeWeight(keyword: "bolder" | "lighter", inherited: number | undefined): number | undefined {
  if (inherited === undefined) return undefined;
  if (keyword === "bolder") return inherited < 350 ? 400 : inherited < 550 ? 700 : 900;
  return inherited < 550 ? 100 : inherited < 750 ? 400 : 700;
}

function parseWeight(value: unknown, inherited: number | undefined, renderer: FontRenderer): number | undefined {
  if (value === undefined || value === null || value === "inherit") return inherited;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const keyword = value.trim();
  if (keyword === "normal") return 400;
  if (keyword === "bold") return 700;
  // Takumi resolves relative weights as CSS does; Satori has no rule for them.
  if (keyword === "bolder" || keyword === "lighter") return renderer === "takumi" ? relativeWeight(keyword, inherited) : undefined;
  return /^\d+$/.test(keyword) ? Number(keyword) : undefined;
}

function parseStyle(value: unknown, inherited: FontRequest["style"]): FontRequest["style"] {
  if (value === undefined || value === null || value === "inherit") return inherited;
  if (typeof value !== "string") return undefined;
  const keyword = value.trim().split(/\s+/)[0];
  if (keyword === "normal") return "normal";
  return keyword === "italic" || keyword === "oblique" ? "italic" : undefined;
}

/** Keywords that leave a custom property as inherited, as Satori treats them. */
const KEEP_INHERITED = new Set(["inherit", "unset", "revert", "revert-layer"]);

function declareVars(vars: ReadonlyMap<string, string>, declared: Record<string, unknown>): ReadonlyMap<string, string> {
  let next: Map<string, string> | undefined;
  for (const [name, value] of Object.entries(declared)) {
    if (!name.startsWith("--") || (typeof value !== "string" && typeof value !== "number")) continue;
    const text = String(value);
    if (KEEP_INHERITED.has(text.trim().toLowerCase())) continue;
    next ??= new Map(vars);
    next.set(name, text);
  }
  return next ?? vars;
}

/** Index of the parenthesis that closes the one opened just before `start`, or -1. */
function closingParen(value: string, start: number): number {
  let depth = 1;
  for (let index = start; index < value.length; index++) {
    if (value[index] === "(") depth++;
    else if (value[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

/**
 * Substitutes every `var(--name, fallback)` in `value`, as Satori does: an
 * undeclared or `initial` property takes the fallback, and one with neither
 * leaves the whole value unresolved (`undefined`).
 */
function resolveVars(value: string, vars: ReadonlyMap<string, string>, seen: ReadonlySet<string> = new Set()): string | undefined {
  let result = "";
  let rest = value;
  for (let at = rest.search(/var\(/i); at !== -1; at = rest.search(/var\(/i)) {
    const end = closingParen(rest, at + 4);
    if (end === -1) return undefined;
    const inner = rest.slice(at + 4, end);
    const comma = inner.indexOf(",");
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? undefined : inner.slice(comma + 1);
    const declared = seen.has(name) ? undefined : vars.get(name);
    let substituted: string | undefined;
    if (declared !== undefined && declared.trim().toLowerCase() !== "initial") {
      substituted = resolveVars(declared, vars, new Set(seen).add(name));
    }
    if (substituted === undefined && fallback !== undefined) substituted = resolveVars(fallback, vars, seen);
    if (substituted === undefined) return undefined;
    result += rest.slice(0, at) + substituted;
    rest = rest.slice(end + 1);
  }
  return (result + rest).trim();
}

/** Marks a `var()` with no value and no fallback. */
const UNRESOLVED = Symbol("unresolved");

function inherit(request: FontRequest, preset: FontPreset | undefined, style: unknown, renderer: FontRenderer): FontRequest {
  const own = typeof style === "object" && style !== null ? style as Record<string, unknown> : undefined;
  if (own === undefined && preset === undefined) return request;
  const vars = own === undefined ? request.vars : declareVars(request.vars, own);
  // The tag's default style applies first; the inline style overrides it.
  const declared: Record<string, unknown> = { ...preset, ...own };
  const resolve = (value: unknown): unknown =>
    typeof value === "string" && /var\(/i.test(value) ? resolveVars(value, vars) ?? UNRESOLVED : value;
  const family = resolve(declared.fontFamily);
  const weight = resolve(declared.fontWeight);
  const fontStyle = resolve(declared.fontStyle);
  const setsFamily = family === UNRESOLVED || (typeof family === "string" && family.trim() !== "" && family !== "inherit");
  return {
    family: setsFamily ? (family === UNRESOLVED ? undefined : family as string) : request.family,
    unresolved: setsFamily ? family === UNRESOLVED : request.unresolved,
    weight: weight === UNRESOLVED ? undefined : parseWeight(weight, request.weight, renderer),
    style: fontStyle === UNRESOLVED ? undefined : parseStyle(fontStyle, request.style),
    vars,
  };
}

type FoundText = { request: FontRequest; element: string; text: string };

/** React's class components carry this marker; Satori cannot render them either. */
const isClassComponent = (type: { prototype?: { isReactComponent?: unknown } }): boolean =>
  Boolean(type.prototype?.isReactComponent);

/**
 * What a function component renders, called with its props as Satori calls
 * it. `undefined` for a class component, or one that throws or returns a
 * promise: the walk skips it, and Satori reports it.
 */
export function renderComponent(type: (props: unknown) => unknown, props: unknown): unknown {
  if (isClassComponent(type as never)) return undefined;
  let rendered: unknown;
  try {
    rendered = type(props ?? {});
  } catch {
    return undefined;
  }
  return rendered instanceof Promise ? undefined : rendered;
}

/**
 * Every text the element tree draws, with the font request it inherits.
 * Function components are called with their props, as Satori calls them; one
 * that throws or returns a promise is skipped, and Satori reports it.
 */
function collectText(
  node: unknown,
  request: FontRequest,
  element: string,
  found: FoundText[],
  renderer: FontRenderer,
  depth = 0,
): void {
  if (depth > 256 || node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") {
    const text = String(node);
    if (text.trim() !== "") found.push({ request, element, text });
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, request, element, found, renderer, depth + 1);
    return;
  }
  if (typeof node !== "object" || !("type" in node)) return;
  const { type, props } = node as { type: unknown; props?: Record<string, unknown> };
  if (typeof type === "function") {
    collectText(renderComponent(type as (props: unknown) => unknown, props), request, element, found, renderer, depth + 1);
    return;
  }
  if (typeof type === "string" && OPAQUE_ELEMENTS.has(type)) return;
  const presets = PRESETS[renderer];
  const preset = typeof type === "string" && Object.hasOwn(presets, type) ? presets[type] : undefined;
  const next = inherit(request, preset, props?.style, renderer);
  collectText(props?.children, next, typeof type === "string" ? type : element, found, renderer, depth + 1);
}

function describeFace(face: LoadedFace): string {
  return `${face.name} ${face.weight ?? 400} ${face.style ?? "normal"}`;
}

/**
 * Collects the faces a render can draw with: the plate's fonts first, then
 * every font a `loadAdditionalAsset` answer supplies during the render.
 */
export class FaceRegistry {
  private readonly faces: LoadedFace[];

  constructor(fonts: readonly LoadedFace[]) {
    this.faces = [...fonts];
  }

  /** Records the fonts in one of Satori's asset answers; images and empty answers add nothing. */
  record(asset: unknown): void {
    if (!Array.isArray(asset)) return;
    for (const font of asset) {
      if (typeof font === "object" && font !== null && typeof (font as LoadedFace).name === "string") {
        this.faces.push(font as LoadedFace);
      }
    }
  }

  get all(): readonly LoadedFace[] {
    return this.faces;
  }
}

/**
 * Reports each distinct font request in the tree that no loaded face
 * satisfies, with the first text drawn under it. `renderer` picks whose tag
 * defaults and weight keywords the walk follows.
 */
export function checkFontFallback(
  element: unknown,
  faces: readonly LoadedFace[],
  report: GuardReport,
  target: GuardTarget,
  renderer: FontRenderer = "satori",
): void {
  const [first] = faces;
  if (!first) return;
  const found: FoundText[] = [];
  collectText(element, INITIAL, "div", found, renderer);
  const reported = new Set<string>();
  for (const { request, element: type, text } of found) {
    const signature = `${request.family ?? ""}\u0000${request.weight ?? ""}\u0000${request.style ?? ""}`;
    // A family no `var()` resolves has no static answer.
    if (request.unresolved || reported.has(signature)) continue;
    reported.add(signature);
    const stack = request.family === undefined ? [] : familyStack(request.family);
    const resolved = stack.length === 0
      ? familyKey(first.name)
      : stack.find((name) => faces.some((face) => familyKey(face.name) === name));
    const base = {
      guard: "fontFallback" as const,
      variant: target.variant,
      size: target.size,
      element: type,
      text,
      fontFamily: request.family,
      fontWeight: request.weight ?? 400,
      fontStyle: request.style ?? "normal",
    };
    if (resolved === undefined) {
      const names = [...new Set(faces.map((face) => face.name))];
      report.add({
        ...base,
        missing: "family",
        loaded: Object.freeze(faces.map(describeFace)),
        message:
          `Text ${quote(text)} in a <${type}> asks for fontFamily ${JSON.stringify(request.family)} in ` +
          `${describeTarget(target)}, but no loaded font is in that stack, so it is drawn with ${first.name}; ` +
          `load the family in fonts or name a loaded one (loaded: ${names.join(", ")})`,
      });
      continue;
    }
    if (request.weight === undefined || request.style === undefined) continue;
    const family = faces.filter((face) => familyKey(face.name) === resolved);
    const matches = family.some((face) => (face.weight ?? 400) === request.weight && (face.style ?? "normal") === request.style);
    if (matches) continue;
    const name = family[0]?.name ?? resolved;
    report.add({
      ...base,
      missing: "face",
      loaded: Object.freeze(family.map(describeFace)),
      message:
        `Text ${quote(text)} in a <${type}> asks for ${name} ${request.weight} ${request.style} in ` +
        `${describeTarget(target)}, but the loaded ${name} faces are ${family.map(describeFace).map((face) => face.slice(name.length + 1)).join(", ")}, ` +
        "so it is drawn with another face; load that weight and style in fonts or use a loaded one",
    });
  }
}
