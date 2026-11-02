import type { ImageSize } from "./core.js";
import type { EmojiLoader } from "./emoji.js";
import { assertRenderGuards, type RenderGuards } from "./guards.js";
import type { PlateContext, PlateVariants } from "./plate.js";
import { loadSatori } from "./peers.js";
import { createSvgPlate } from "./svg-plate.js";

export { SVG_CONTENT_TYPE } from "./svg-plate.js";

export {
  RenderGuardError,
  type RenderGuardBox,
  type RenderGuardIssue,
  type RenderGuardLevel,
  type RenderGuardName,
  type RenderGuards,
} from "./guards.js";

/**
 * A font face the standalone renderer passes through to Satori. Declared
 * structurally so `metaplate/render`'s public type surface stays free of
 * Satori's declarations, which import React, and of Node's typings: `data`
 * is `ArrayBuffer | Uint8Array` rather than Satori's `Buffer | ArrayBuffer`
 * because `Buffer` is a bare Node global that would otherwise make every
 * consumer need `@types/node` just to load the declaration. A Node `Buffer`
 * remains assignable (it is a `Uint8Array`), and Satori itself wraps either
 * shape into a `Uint8Array` before parsing.
 */
export type SatoriFont = {
  data: ArrayBuffer | Uint8Array;
  name: string;
  weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
  style?: "normal" | "italic";
  lang?: string;
};

/**
 * A laid-out node passed to Satori's `onNodeDetected` callback. This is the
 * *output* of layout (Satori's own `SatoriNode`), distinct from the input
 * element tree a plate's `component` returns; declared structurally so the
 * public surface stays free of Satori's React-typed declarations.
 */
export type SatoriLayoutNode = {
  left: number;
  top: number;
  width: number;
  height: number;
  type: string;
  key?: string | number;
  props: Record<string, unknown>;
  textContent?: string;
};

/**
 * Satori options beyond the width, height, and fonts Metaplate owns. A
 * React-free mirror of Satori's options so a plate author can tune these
 * without pulling Satori's React-typed declarations into a React-free build.
 * Leaf shapes follow Satori's contract (for example `loadAdditionalAsset` is
 * asynchronous) even though Satori itself is declared here structurally.
 */
export type SatoriOptions = {
  debug?: boolean;
  embedFont?: boolean;
  graphemeImages?: Record<string, string>;
  onNodeDetected?: (node: SatoriLayoutNode) => void;
  pointScaleFactor?: number;
  loadAdditionalAsset?: (
    languageCode: string,
    segment: string,
  ) => Promise<string | SatoriFont[]>;
  /**
   * Passed through to Satori. Typed as `object` — not `Record<string, unknown>`
   * and not Satori's `TwConfig` — so an upstream-typed config (an interface
   * with named properties and no index signature) is accepted without pulling
   * Satori's React-dependent declaration graph into this surface.
   */
  tailwindConfig?: object;
};

export type StandaloneFontLoader = () =>
  | Promise<readonly SatoriFont[]>
  | readonly SatoriFont[];

/**
 * The element tree Satori walks: a `{ type, props }` element — React's JSX
 * elements are exactly that shape — or a text/fragment node. Declared here
 * instead of importing `ReactNode` so `metaplate/render` and
 * `metaplate/node` typecheck without React or @types/react installed; the
 * README's React-free plain-object authoring path is therefore typed, not
 * just runtime-supported.
 */
export type SatoriNode =
  | { type: unknown; props?: object | null }
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | readonly SatoriNode[];

export type {
  PlateContext,
  PlateMetadataOptions,
  PlateVariant,
  PlateVariants,
  PlateView,
} from "./plate.js";

export type SvgOgDefinition<Copy, Variant extends string = string> = {
  /**
   * Satori-compatible JSX or a plain `{ type, props }` object tree. The
   * second argument names the variant and size being rendered so the layout
   * can reflow; a single-argument component ignores it.
   */
  component: (copy: Copy, context: PlateContext<Variant>) => SatoriNode;
  alt: (copy: Copy) => string;
  /** Satori does not bundle a default font, so at least one face is required. */
  fonts: StandaloneFontLoader;
  /**
   * The default size. Each view of a plate renders one size: `plate.size`
   * for the default, `plate.variant(name).size` for a declared variant.
   */
  size?: ImageSize;
  /** Additional named sizes rendered from the same copy and component. */
  variants?: PlateVariants<Copy, Variant>;
  imagePath?: string;
  basePath?: string;
  /** Scheme for absolute image URLs, such as `https://example.com`. */
  origin?: string;
  satori?: SatoriOptions;
  /**
   * Draws emoji as images: `packageEmojiLoader` from `metaplate/fonts` reads
   * an installed SVG set, `emojiLoader` from `metaplate/emoji` wraps any
   * source. Emoji without an image fall back to the plate's fonts. Takes
   * precedence over `satori.loadAdditionalAsset` for emoji, which still
   * receives every other script and any emoji the loader has no image for.
   */
  emoji?: EmojiLoader;
  /**
   * Opt-in checks that fail (`"error"`) or report (`"warn"`) a render that
   * would ship a broken card instead of returning it. Every guard is off by
   * default. `metaplate/node` and `metaplate/edge` add a `blank` guard on the
   * rasterised pixels; see docs/rendering.md#render-guards.
   */
  guards?: RenderGuards;
};

/** Defines a framework-neutral social image renderer that emits SVG text. */
export function createSvgOg<Copy, Variant extends string = string>(
  definition: SvgOgDefinition<Copy, Variant>,
) {
  assertRenderGuards(definition.guards, ["missingGlyphs", "overflow"], "metaplate/render");
  return createSvgPlate(definition, loadSatori);
}
