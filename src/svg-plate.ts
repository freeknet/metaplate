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
  overflowDetector,
  type GuardTarget,
} from "./guards.js";
import type { SatoriOptions, SvgOgDefinition } from "./render.js";

export const SVG_CONTENT_TYPE = "image/svg+xml" as const;

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
      renderSvg: (copy: Copy) => renderSvg(definition, loadSatori, copy, view.context),
    };
  });
}

async function renderSvg<Copy, Variant extends string>(
  definition: SvgOgDefinition<Copy, Variant>,
  loadSatori: () => Promise<SatoriRender>,
  copy: Copy,
  context: PlateContext<Variant>,
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
  const svg = await satori(
    element as Parameters<typeof satori>[0],
    {
      ...(satoriOptions(definition, report, target) as unknown as Parameters<typeof satori>[1]),
      width: context.size.width,
      height: context.size.height,
      fonts: [...fonts],
    } as unknown as Parameters<typeof satori>[1],
  );
  // Warnings are reported, and error-level issues thrown, only once Satori
  // has finished, so one RenderGuardError lists every issue in the layout.
  report.settle();
  return svg;
}

/**
 * Routes Satori's emoji requests through the plate's emoji loader. Every other
 * language code, and an emoji the loader has no image for, goes to the
 * caller's own `loadAdditionalAsset` when there is one; otherwise an empty
 * font list tells Satori to draw the segment with the fonts it has.
 */
function emojiFirst(
  emoji: NonNullable<SvgOgDefinition<unknown>["emoji"]>,
  fallback: SatoriOptions["loadAdditionalAsset"],
): NonNullable<SatoriOptions["loadAdditionalAsset"]> {
  return async (languageCode, segment) => {
    if (languageCode === "emoji") {
      const image = await emoji(segment);
      if (image !== undefined) return image;
    }
    return fallback ? fallback(languageCode, segment) : [];
  };
}

/**
 * The Satori options for one render: the plate's own, with the emoji loader
 * and any enabled guards composed around the caller's `loadAdditionalAsset`
 * and `onNodeDetected`. With no emoji loader and every guard off, the plate's
 * options pass through untouched, so Satori's behavior is unchanged.
 */
function satoriOptions<Copy, Variant extends string>(
  definition: SvgOgDefinition<Copy, Variant>,
  report: GuardReport,
  target: GuardTarget,
): SatoriOptions | undefined {
  const { emoji, satori, guards } = definition;
  let loadAdditionalAsset = satori?.loadAdditionalAsset;
  if (emoji) loadAdditionalAsset = emojiFirst(emoji, loadAdditionalAsset);
  if (guardLevel(guards, "missingGlyphs") !== "off") {
    loadAdditionalAsset = guardAssetLoader(loadAdditionalAsset, report, target, satori?.graphemeImages);
  }

  let onNodeDetected = satori?.onNodeDetected;
  if (guardLevel(guards, "overflow") !== "off") {
    const detect = overflowDetector(report, target);
    const callerDetect = onNodeDetected;
    onNodeDetected = (node) => {
      detect(node);
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
