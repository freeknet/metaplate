import {
  createPlateSocial,
  createPlateViews,
  isPendingElement,
  type PlateContext,
} from "./plate.js";
import {
  GuardReport,
  guardAssetLoader,
  guardLevel,
  layoutGuards,
  overflowDetector,
  type GuardTarget,
} from "./guards.js";
import type { SatoriLayoutNode, SatoriOptions, SvgOgDefinition } from "./svg.js";

export const SVG_CONTENT_TYPE = "image/svg+xml" as const;

/** Per-call controls for `renderSvg`, layered over the plate's `satori` options. */
export type SvgRenderOptions = {
  /**
   * Overrides the plate's `satori.debug` for this call: Satori outlines every
   * element's layout box in red and every line of text in blue, which is how
   * `metaplate preview` shows a plate's boxes without editing the plate.
   */
  debug?: boolean;
};

/** The Satori render function, whichever Satori build provides it. */
export type SatoriRender = typeof import("satori").default;

/**
 * Not an entry point: `createSvgOg` with the Satori build injected, so
 * `metaplate/edge` can lay out through `satori/standalone` and a
 * caller-supplied Yoga module while every other entry keeps the default build.
 */
export function createSvgPlate<Copy, Variant extends string = string>(
  definition: SvgOgDefinition<Copy, Variant>,
  loadSatori: () => Promise<SatoriRender>,
) {
  const social = createPlateSocial(definition, SVG_CONTENT_TYPE);

  return createPlateViews(social.variants, (name) => {
    const view = social.view(name);
    return {
      size: view.context.size,
      image: view.image,
      metadata: view.metadata,
      /** The image path relative to the deployment root, without `basePath` or `origin`. */
      sitePath: view.sitePath,
      contentType: SVG_CONTENT_TYPE,
      renderSvg: (copy: Copy, options?: SvgRenderOptions) =>
        renderSvg(definition, loadSatori, copy, view.context, options),
    };
  });
}

async function renderSvg<Copy, Variant extends string>(
  definition: SvgOgDefinition<Copy, Variant>,
  loadSatori: () => Promise<SatoriRender>,
  copy: Copy,
  context: PlateContext<Variant>,
  options: SvgRenderOptions | undefined,
) {
  const satori = await loadSatori();
  const fonts = await definition.fonts();
  if (fonts.length === 0) {
    throw new Error("Standalone Metaplate renderers require at least one font");
  }
  const rendered = definition.component(copy, context);
  const element = isPendingElement(rendered) ? await rendered : rendered;

  // SatoriNode is structurally what Satori walks; its own declarations type
  // the parameter as React's ReactNode, and its FontOptions narrow the font
  // data to `Buffer | ArrayBuffer`, so the boundary cast keeps the public
  // type surface free of React and of Node's Buffer global (which is also
  // why `definition.satori` is cast across the Satori boundary rather than
  // typed against it).
  const report = new GuardReport(definition.guards);
  const target: GuardTarget = { variant: context.variant, size: context.size };
  const layout = layoutGuards(definition.guards, report, target);
  const svg = await satori(
    element as Parameters<typeof satori>[0],
    {
      ...(satoriOptions(definition, report, target, layout?.detect) as unknown as Parameters<typeof satori>[1]),
      ...(options?.debug === undefined ? {} : { debug: options.debug }),
      width: context.size.width,
      height: context.size.height,
      fonts: [...fonts],
    } as unknown as Parameters<typeof satori>[1],
  );
  // Warnings are reported, and error-level issues thrown, only once Satori
  // has finished, so one RenderGuardError lists every issue in the layout.
  layout?.finish();
  report.settle();
  return svg;
}

/**
 * Composes Satori's `loadAdditionalAsset` from the plate's options. Each
 * request is offered, in this order, to:
 *
 * 1. `emoji`, for the `emoji` language code: an image resolves the grapheme;
 * 2. `languageFonts`, for every other code: a non-empty font list resolves
 *    the segment;
 * 3. the caller's own `satori.loadAdditionalAsset`, for anything the steps
 *    above did not resolve.
 *
 * Without a caller loader, an empty font list tells Satori to draw the
 * segment with the fonts it has.
 */
function scriptAssets(
  emoji: SvgOgDefinition<unknown>["emoji"],
  languageFonts: SvgOgDefinition<unknown>["languageFonts"],
  fallback: SatoriOptions["loadAdditionalAsset"],
): NonNullable<SatoriOptions["loadAdditionalAsset"]> {
  return async (languageCode, segment) => {
    if (languageCode === "emoji") {
      const image = await emoji?.(segment);
      if (image !== undefined) return image;
    } else if (languageFonts) {
      const fonts = await languageFonts(languageCode, segment);
      if (fonts.length > 0) return fonts;
    }
    return fallback ? fallback(languageCode, segment) : [];
  };
}

/**
 * The Satori options for one render: the plate's own, with the emoji loader,
 * language fonts, and any enabled guards composed around the caller's `loadAdditionalAsset`
 * and `onNodeDetected`. With no emoji loader and every guard off, the plate's
 * options pass through untouched, so Satori's behavior is unchanged.
 */
function satoriOptions<Copy, Variant extends string>(
  definition: SvgOgDefinition<Copy, Variant>,
  report: GuardReport,
  target: GuardTarget,
  detectLayout: ((node: SatoriLayoutNode) => void) | undefined,
): SatoriOptions | undefined {
  const { emoji, languageFonts, satori, guards } = definition;
  let loadAdditionalAsset = satori?.loadAdditionalAsset;
  if (emoji || languageFonts) loadAdditionalAsset = scriptAssets(emoji, languageFonts, loadAdditionalAsset);
  if (guardLevel(guards, "missingGlyphs") !== "off") {
    loadAdditionalAsset = guardAssetLoader(loadAdditionalAsset, report, target, satori?.graphemeImages);
  }

  let onNodeDetected = satori?.onNodeDetected;
  const detectors = [
    ...(guardLevel(guards, "overflow") !== "off" ? [overflowDetector(report, target)] : []),
    ...(detectLayout ? [detectLayout] : []),
  ];
  if (detectors.length > 0) {
    const callerDetect = onNodeDetected;
    onNodeDetected = (node) => {
      for (const detect of detectors) detect(node);
      callerDetect?.(node);
    };
  }

  if (loadAdditionalAsset === satori?.loadAdditionalAsset && onNodeDetected === satori?.onNodeDetected) {
    return satori;
  }
  return {
    ...satori,
    ...(loadAdditionalAsset ? { loadAdditionalAsset } : {}),
    ...(onNodeDetected ? { onNodeDetected } : {}),
  };
}
