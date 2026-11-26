import type { MeasuredNode, Node as TakumiNode } from "takumi-js";
import { loadTakumi } from "../core/peers.js";
import { OG_CONTENT_TYPE } from "../core/social-image.js";
import { webSha256 } from "../core/stable-hash.js";
import type { LanguageFontLoader } from "../fonts/language-fonts.js";
import { checkLineClamp } from "./clamp-guard.js";
import { checkFontFallback, FaceRegistry } from "./font-guard.js";
import {
  describeTarget,
  GuardReport,
  guardLevel,
  LAYOUT_GUARD_NAMES,
  layoutGuards,
  overflowDetector,
  quote,
  type DetectedNode,
  type GuardTarget,
  type RasterRenderGuards,
  type RenderGuardName,
} from "./guards.js";
import { createPlateSocial, createPlateViews, isPendingElement, type PlateContext } from "./plate.js";
import {
  createRasterPlate,
  fetchShapedView,
  type Frame,
  type FrameRequest,
  type FrameSource,
  type OutputEncoder,
} from "./raster.js";
import type { SatoriFont, SvgOgDefinition } from "./svg.js";

export type { OutputEncoder, RenderedPixels } from "./raster.js";

export {
  MEMORY_RENDER_CACHE_DEFAULTS,
  memoryRenderCache,
  type CachedPlate,
  type MemoryRenderCache,
  type MemoryRenderCacheOptions,
  type RenderCacheEntry,
  type RenderCacheOptions,
  type RenderCacheStore,
} from "./cache.js";

export {
  RenderGuardError,
  type RasterRenderGuards,
  type RenderGuardBox,
  type RenderGuardIssue,
  type RenderGuardLevel,
  type RenderGuardName,
  type RenderGuards,
  type SafeAreaGuard,
} from "./guards.js";

export type { SatoriFont } from "./svg.js";

export type {
  PlateContext,
  PlateElement,
  PlateMetadataOptions,
  PlateRouteOptions,
  PlateUrlOptions,
  PlateVariant,
  PlateVariants,
  PlateVersioning,
  PlateView,
  SignedRouteOptions,
} from "./plate.js";

/**
 * Takumi's WebAssembly module, for a runtime where `takumi-js` cannot pick its
 * own binding: the module a bundler's `import wasm from
 * "@takumi-rs/wasm/takumi_wasm_bg.wasm"` yields, its bytes, or a `Response`
 * or URL to fetch it from.
 */
export type TakumiWasmModule =
  | WebAssembly.Module
  | ArrayBuffer
  | ArrayBufferView
  | Response
  | URL;

/** Takumi controls. */
export type TakumiOptions = {
  /**
   * Renders with Takumi's WebAssembly build instead of the binding
   * `takumi-js` selects. Not needed on Node.js (the native addon), Cloudflare
   * Workers, Deno, or browsers (the Wasm build, located by import
   * conditions). `takumi-js` keeps one renderer per isolate, so the first
   * render decides the binding for every Takumi plate in it.
   */
  module?: TakumiWasmModule | Promise<TakumiWasmModule>;
};

/** Guards `metaplate/takumi` runs: every raster guard except `avoid`. */
export type TakumiRenderGuards = Omit<RasterRenderGuards, "avoid"> & {
  /** Not supported: Takumi's layout keeps no React `key`, so text cannot be matched to a keyed element. */
  avoid?: never;
};

export type TakumiOgDefinition<Copy, Variant extends string = string> = Omit<
  SvgOgDefinition<Copy, Variant>,
  "satori" | "guards"
> & {
  /** Takumi controls. */
  takumi?: TakumiOptions;
  /** Headers added to Web Responses returned by `response` and `fetchable`. */
  headers?: HeadersInit;
  /** Adds a strong SHA-256 ETag, computed with Web Crypto, to responses. */
  etag?: boolean | "sha256";
  /** Encodes something other than PNG from the rendered pixels. */
  output?: OutputEncoder;
  /** Render guards; all off by default. */
  guards?: TakumiRenderGuards;
  /** Not supported: Takumi is not Satori. */
  satori?: never;
};

const TAKUMI_GUARDS: readonly RenderGuardName[] = [
  ...LAYOUT_GUARD_NAMES.filter((name) => name !== "avoid"),
  "blank",
];

/** Guards that read Takumi's layout, so a render measures before it paints. */
const MEASURED_GUARDS: readonly RenderGuardName[] = ["missingGlyphs", "overflow", "safeArea", "textOverlap"];

type Takumi = Awaited<ReturnType<typeof loadTakumi>>;
type TakumiFont = { name: string; data: Uint8Array | ArrayBuffer; weight?: number; style?: string };

/** WOFF 1.0 starts with `wOFF`; Takumi reads TrueType, OpenType, and WOFF2. */
function isWoff(data: Uint8Array | ArrayBuffer): boolean {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x46;
}

function takumiFont(font: SatoriFont): TakumiFont {
  if (isWoff(font.data)) {
    throw new TypeError(
      `metaplate/takumi cannot read the WOFF font "${font.name}": Takumi reads TrueType, OpenType, ` +
        "and WOFF2. Load the .woff2 file instead (Fontsource ships both).",
    );
  }
  return {
    name: font.name,
    data: font.data,
    ...(font.weight === undefined ? {} : { weight: font.weight }),
    ...(font.style === undefined ? {} : { style: font.style }),
  };
}

/** Satori's script detection, so `languageFonts` receives the codes it does under Satori. */
const SPECIAL_SCRIPTS: readonly [string, RegExp][] = [
  ["emoji", /\p{Extended_Pictographic}/u],
  ["symbol", /\p{Symbol}/u],
  ["math", /\p{Math}/u],
];
/** Satori also counts the ideographic space and the halfwidth and fullwidth forms as Japanese. */
const JAPANESE_EXTRA = `${String.fromCodePoint(0x3000)}|[${String.fromCodePoint(0xff00)}-${String.fromCodePoint(0xffef)}]`;
const SCRIPTS: readonly [string, RegExp][] = [
  ["ja-JP", new RegExp(`\\p{scx=Hira}|\\p{scx=Kana}|\\p{scx=Han}|${JAPANESE_EXTRA}`, "u")],
  ["ko-KR", /\p{scx=Hangul}/u],
  ["zh-CN", /\p{scx=Han}/u],
  ["zh-TW", /\p{scx=Han}/u],
  ["zh-HK", /\p{scx=Han}/u],
  ["th-TH", /\p{scx=Thai}/u],
  ["bn-IN", /\p{scx=Bengali}/u],
  ["ar-AR", /\p{scx=Arabic}/u],
  ["ta-IN", /\p{scx=Tamil}/u],
  ["ml-IN", /\p{scx=Malayalam}/u],
  ["he-IL", /\p{scx=Hebrew}/u],
  ["te-IN", /\p{scx=Telugu}/u],
  ["devanagari", /\p{scx=Devanagari}/u],
  ["kannada", /\p{scx=Kannada}/u],
];

function languageCode(character: string): string {
  for (const [code, pattern] of SPECIAL_SCRIPTS) if (pattern.test(character)) return code;
  const codes = SCRIPTS.filter(([, pattern]) => pattern.test(character)).map(([code]) => code);
  return codes.length === 0 ? "unknown" : codes.join("|");
}

function reportMissing(report: GuardReport, target: GuardTarget, languageCode: string, segment: string): void {
  const remedy = languageCode === "emoji"
    ? "set the plate's emoji option to draw emoji as images"
    : "add a font that covers it to fonts or languageFonts";
  report.add({
    guard: "missingGlyphs",
    variant: target.variant,
    size: target.size,
    languageCode,
    segment,
    message:
      `Missing glyphs in ${describeTarget(target)}: no font or image for ${quote(segment)} ` +
      `(language code "${languageCode}"); ${remedy}`,
  });
}

/**
 * Takumi's `loadFallbackFonts`: the characters no plate font draws, grouped
 * by script as Satori groups them and offered to `languageFonts`. A group
 * that comes back with no font is what the `missingGlyphs` guard reports, as
 * under Satori. Reports are deduplicated, since measuring and painting both
 * ask.
 */
function fallbackFonts(
  languageFonts: LanguageFontLoader | undefined,
  report: GuardReport,
  target: GuardTarget,
  faces: FaceRegistry | undefined,
) {
  const reported = new Set<string>();
  return async (characters: string[]): Promise<TakumiFont[]> => {
    const segments = new Map<string, string>();
    for (const character of characters) {
      const code = languageCode(character);
      segments.set(code, (segments.get(code) ?? "") + character);
    }
    const found = new Map<unknown, SatoriFont>();
    for (const [code, segment] of segments) {
      const fonts = code === "emoji" || !languageFonts ? [] : await languageFonts(code, segment);
      for (const font of fonts) found.set(font.data, font);
      if (fonts.length === 0 && !reported.has(segment)) {
        reported.add(segment);
        reportMissing(report, target, code, segment);
      }
    }
    const loaded = [...found.values()];
    faces?.record(loaded);
    return loaded.map(takumiFont);
  };
}

const TRANSPARENT = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');

/**
 * Takumi turns emoji into images named after their code points on a CDN.
 * Each is pointed at the plate's own emoji loader instead, so a render never
 * fetches from a third party; an emoji the loader has no image for is left
 * transparent and reported by `missingGlyphs`.
 */
async function withEmojiImages(
  node: TakumiNode,
  takumi: Takumi,
  emoji: NonNullable<SvgOgDefinition<unknown>["emoji"]>,
  onMissing: (grapheme: string) => void,
): Promise<TakumiNode> {
  if (node.type === "image" && typeof node.src === "string" && takumi.isEmojiImageUrl(node.src)) {
    const name = node.src.slice(node.src.lastIndexOf("/") + 1).replace(/\.svg$/, "");
    const grapheme = String.fromCodePoint(...name.split("-").map((hex) => Number.parseInt(hex, 16)));
    // Twemoji names drop the variation selector of a single-code-point emoji.
    const image = (await emoji(grapheme)) ?? ([...grapheme].length === 1 ? await emoji(`${grapheme}️`) : undefined);
    if (image === undefined) onMissing(grapheme);
    return { ...node, src: image ?? TRANSPARENT };
  }
  if (node.type !== "container" || !node.children) return node;
  const children = await Promise.all(node.children.map((child) => withEmojiImages(child, takumi, emoji, onMissing)));
  return { ...node, children };
}

/** The axis-aligned canvas box of a measured node, through its transform. */
function bounds({ width, height, transform: [a, b, c, d, e, f] }: MeasuredNode) {
  const xs = [e, a * width + e, c * height + e, a * width + c * height + e];
  const ys = [f, b * width + f, d * height + f, b * width + d * height + f];
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

const isAnonymousText = (node: TakumiNode) => node.type === "text" && node.tagName === undefined;

/**
 * Feeds the measured tree to the guards in the shape Satori's
 * `onNodeDetected` reports, root first. Text Takumi lays out as an anonymous
 * child counts as its element's own text, with the element's box, as in
 * Satori. The measured tree mirrors the converted one; if it ever does not,
 * the walk stops there rather than pair text with the wrong box.
 */
function detect(node: TakumiNode, measured: MeasuredNode, emit: (node: DetectedNode) => void): void {
  const type = node.tagName ?? (node.type === "image" ? "img" : "div");
  if (node.type === "text") {
    emit({ ...bounds(measured), type, textContent: node.text });
    return;
  }
  const children = node.type === "container" ? node.children ?? [] : [];
  const text = children.filter(isAnonymousText).map((child) => (child as { text: string }).text).join("");
  emit({ ...bounds(measured), type, textContent: text });
  if (measured.children.length !== children.length) return;
  children.forEach((child, index) => {
    if (!isAnonymousText(child)) detect(child, measured.children[index]!, emit);
  });
}

function layoutChecks(
  guards: TakumiRenderGuards | undefined,
  report: GuardReport,
  target: GuardTarget,
  node: TakumiNode,
  measured: MeasuredNode,
): void {
  const layout = layoutGuards(guards, report, target);
  const detectors = [
    ...(guardLevel(guards, "overflow") !== "off" ? [overflowDetector(report, target)] : []),
    ...(layout ? [layout.detect] : []),
  ];
  if (detectors.length === 0) return;
  detect(node, measured, (detected) => {
    for (const detector of detectors) detector(detected);
  });
  layout?.finish();
}

function bytesOf(output: Uint8Array): Uint8Array {
  return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
}

/** PNG width and height, from the IHDR chunk that always follows the signature. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Each size of a Takumi plate: the component's tree converted for Takumi,
 * measured first when a guard reads the layout, so an error-level issue is
 * raised before anything is painted.
 */
function takumiFrames<Copy, Variant extends string>(
  definition: TakumiOgDefinition<Copy, Variant>,
): FrameSource<Copy, Variant> {
  const social = createPlateSocial(definition, OG_CONTENT_TYPE);
  const { guards, emoji, languageFonts } = definition;
  const checksFonts = guardLevel(guards, "fontFallback") !== "off";
  // fontFallback learns the families languageFonts supplies only when Takumi
  // asks for fallback fonts during layout, so it needs the measure pass too.
  const measures =
    MEASURED_GUARDS.some((name) => guardLevel(guards, name) !== "off") || (checksFonts && languageFonts !== undefined);

  async function prepare(copy: Copy, context: PlateContext<Variant>) {
    const takumi = await loadTakumi();
    const fonts = await definition.fonts();
    if (fonts.length === 0) {
      throw new Error("Standalone Metaplate renderers require at least one font");
    }
    const rendered = definition.component(copy, context);
    const element = isPendingElement(rendered) ? await rendered : rendered;
    const target: GuardTarget = { variant: context.variant, size: context.size };
    const report = new GuardReport(guards);
    const faces = checksFonts ? new FaceRegistry(fonts) : undefined;

    const converted = await takumi.fromJsx(element as Parameters<Takumi["fromJsx"]>[0]);
    const node = emoji
      ? await withEmojiImages(takumi.extractEmojis(converted.node, "twemoji"), takumi, emoji, (grapheme) =>
          reportMissing(report, target, "emoji", grapheme))
      : converted.node;
    const module = definition.takumi?.module;
    const options = {
      width: context.size.width,
      height: context.size.height,
      fonts: fonts.map(takumiFont),
      css: converted.css,
      // Emoji are images already, or drawn from the fonts: never fetched.
      emoji: "from-font" as const,
      loadFallbackFonts: fallbackFonts(languageFonts, report, target, faces),
      ...(module === undefined ? {} : { module: (await module) as never }),
    };

    if (measures) layoutChecks(guards, report, target, node, await takumi.measure(node, options));
    if (faces) checkFontFallback(element, faces.all, report, target, "takumi");
    if (guardLevel(guards, "lineClamp") !== "off") checkLineClamp(element, report, target);
    // Warnings are reported, and error-level issues thrown, once the layout
    // is known, so one RenderGuardError lists every issue it has.
    report.settle();
    return { takumi, node, options };
  }

  return {
    view(name) {
      const { context } = social.view(name);
      return {
        async renderSvg(copy) {
          const { takumi, node, options } = await prepare(copy, context);
          return takumi.renderSvg(node, options);
        },
        async frame(copy, request: FrameRequest): Promise<Frame> {
          const { takumi, node, options } = await prepare(copy, context);
          const frame: Frame = { ...context.size };
          if (request.png) {
            frame.png = bytesOf(await takumi.render(node, { ...options, format: "png" }));
            Object.assign(frame, pngSize(frame.png));
          }
          if (request.pixels) {
            frame.pixels = bytesOf(await takumi.render(node, { ...options, format: "raw" }));
            if (frame.pixels.byteLength !== context.size.width * context.size.height * 4) {
              throw new Error(
                `Renderer dimension mismatch: expected ${context.size.width}x${context.size.height} RGBA, ` +
                  `received ${frame.pixels.byteLength} bytes`,
              );
            }
          }
          return frame;
        },
      };
    },
  };
}

/**
 * Defines a PNG renderer drawn by Takumi (`takumi-js`) instead of Satori and
 * Resvg. Takumi ships a precompiled WebAssembly build, so this entry renders
 * on Cloudflare Workers, where `metaplate/edge` cannot start, as well as on
 * Node.js (native), Deno, and other Fetch-shaped runtimes. Experimental:
 * Takumi lays out like a browser in places Satori does not (see
 * docs/takumi.md), so compare a plate's output before switching it.
 */
export function createTakumiOg<Copy, Variant extends string = string>(
  definition: TakumiOgDefinition<Copy, Variant>,
) {
  if ((definition as { satori?: unknown }).satori !== undefined) {
    throw new TypeError("metaplate/takumi does not use Satori: remove the satori option.");
  }
  if (guardLevel(definition.guards as RasterRenderGuards | undefined, "avoid") !== "off") {
    throw new TypeError(
      "metaplate/takumi cannot run guards.avoid: Takumi's layout keeps no React key to find the " +
        "element text must avoid. Use metaplate/node or metaplate/edge for the avoid guard.",
    );
  }
  const raster = createRasterPlate(
    definition,
    { frames: takumiFrames(definition), sha256: webSha256, renderer: "takumi" },
    TAKUMI_GUARDS,
  );
  return createPlateViews(raster.variants, (name) => fetchShapedView(raster.view(name)));
}
