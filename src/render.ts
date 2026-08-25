import type { ImageSize } from "./core.js";
import { createPlateSocial } from "./plate.js";
import { loadSatori } from "./peers.js";

export const SVG_CONTENT_TYPE = "image/svg+xml" as const;

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

export type SvgOgDefinition<Copy> = {
  /** Satori-compatible JSX or a plain `{ type, props }` object tree. */
  component: (copy: Copy) => SatoriNode;
  alt: (copy: Copy) => string;
  /** Satori does not bundle a default font, so at least one face is required. */
  fonts: StandaloneFontLoader;
  /** One plate renders one size; `plate.size` is the size every render uses. */
  size?: ImageSize;
  imagePath?: string;
  basePath?: string;
  /** Scheme for absolute image URLs, such as `https://example.com`. */
  origin?: string;
  satori?: SatoriOptions;
};

/** Defines a framework-neutral social image renderer that emits SVG text. */
export function createSvgOg<Copy>(definition: SvgOgDefinition<Copy>) {
  const social = createPlateSocial(definition, SVG_CONTENT_TYPE);
  const { size } = social;

  async function renderSvg(copy: Copy) {
    const satori = await loadSatori();
    const fonts = await definition.fonts();
    if (fonts.length === 0) {
      throw new Error("Standalone Metaplate renderers require at least one font");
    }

    // SatoriNode is structurally what Satori walks; its own declarations type
    // the parameter as React's ReactNode, and its FontOptions narrow the font
    // data to `Buffer | ArrayBuffer`, so the boundary cast keeps the public
    // type surface free of React and of Node's Buffer global (which is also
    // why `definition.satori` is cast across the Satori boundary rather than
    // typed against it).
    return satori(
      definition.component(copy) as Parameters<typeof satori>[0],
      {
        ...(definition.satori as unknown as Parameters<typeof satori>[1]),
        width: size.width,
        height: size.height,
        fonts: [...fonts],
      } as unknown as Parameters<typeof satori>[1],
    );
  }

  return Object.freeze({
    ...social,
    contentType: SVG_CONTENT_TYPE,
    renderSvg,
  });
}
