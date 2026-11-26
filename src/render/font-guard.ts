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
 * `fontStyle` down to every text it finds. Values set by `<style>` rules or
 * `tw` are not seen.
 */

/** A face the render can draw with: a plate font, or one a loader returned. */
export type LoadedFace = Readonly<{ name: string; weight?: number; style?: string }>;

type FontRequest = Readonly<{
  /** The `fontFamily` stack as written, or `undefined` when none applies. */
  family: string | undefined;
  /** `undefined` when the weight is relative or not a plain value, so no face check is possible. */
  weight: number | undefined;
  style: "normal" | "italic" | undefined;
}>;

const INITIAL: FontRequest = { family: undefined, weight: 400, style: "normal" };

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

function parseWeight(value: unknown, inherited: number | undefined): number | undefined {
  if (value === undefined || value === null || value === "inherit") return inherited;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  if (value === "normal") return 400;
  if (value === "bold") return 700;
  return /^\d+$/.test(value.trim()) ? Number(value) : undefined;
}

function parseStyle(value: unknown, inherited: FontRequest["style"]): FontRequest["style"] {
  if (value === undefined || value === null || value === "inherit") return inherited;
  if (typeof value !== "string") return undefined;
  const keyword = value.trim().split(/\s+/)[0];
  if (keyword === "normal") return "normal";
  return keyword === "italic" || keyword === "oblique" ? "italic" : undefined;
}

function inherit(request: FontRequest, style: unknown): FontRequest {
  if (typeof style !== "object" || style === null) return request;
  const declared = style as Record<string, unknown>;
  const family = declared.fontFamily;
  return {
    family: typeof family === "string" && family.trim() !== "" && family !== "inherit"
      ? family.includes("var(") ? undefined : family
      : request.family,
    weight: parseWeight(declared.fontWeight, request.weight),
    style: parseStyle(declared.fontStyle, request.style),
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
function collectText(node: unknown, request: FontRequest, element: string, found: FoundText[], depth = 0): void {
  if (depth > 256 || node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") {
    const text = String(node);
    if (text.trim() !== "") found.push({ request, element, text });
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, request, element, found, depth + 1);
    return;
  }
  if (typeof node !== "object" || !("type" in node)) return;
  const { type, props } = node as { type: unknown; props?: Record<string, unknown> };
  if (typeof type === "function") {
    collectText(renderComponent(type as (props: unknown) => unknown, props), request, element, found, depth + 1);
    return;
  }
  if (typeof type === "string" && OPAQUE_ELEMENTS.has(type)) return;
  const next = inherit(request, props?.style);
  collectText(props?.children, next, typeof type === "string" ? type : element, found, depth + 1);
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
 * satisfies, with the first text drawn under it.
 */
export function checkFontFallback(
  element: unknown,
  faces: readonly LoadedFace[],
  report: GuardReport,
  target: GuardTarget,
): void {
  const [first] = faces;
  if (!first) return;
  const found: FoundText[] = [];
  collectText(element, INITIAL, "div", found);
  const reported = new Set<string>();
  for (const { request, element: type, text } of found) {
    const signature = `${request.family ?? ""}\u0000${request.weight ?? ""}\u0000${request.style ?? ""}`;
    if (reported.has(signature)) continue;
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
