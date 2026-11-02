import {
  createPlateSocial,
  createPlateViews,
  isPendingElement,
  type PlateContext,
} from "./plate.js";
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
  return satori(
    element as Parameters<typeof satori>[0],
    {
      ...(satoriOptions(definition) as unknown as Parameters<typeof satori>[1]),
      width: context.size.width,
      height: context.size.height,
      fonts: [...fonts],
    } as unknown as Parameters<typeof satori>[1],
  );
}

/**
 * Routes Satori's emoji requests through the plate's emoji loader. Every other
 * language code, and an emoji the loader has no image for, goes to the
 * caller's own `loadAdditionalAsset` when there is one; otherwise an empty
 * font list tells Satori to draw the segment with the fonts it has.
 */
function satoriOptions<Copy, Variant extends string>(
  definition: SvgOgDefinition<Copy, Variant>,
): SatoriOptions | undefined {
  const { emoji, satori } = definition;
  if (!emoji) return satori;
  const fallback = satori?.loadAdditionalAsset;
  return {
    ...satori,
    loadAdditionalAsset: async (languageCode, segment) => {
      if (languageCode === "emoji") {
        const image = await emoji(segment);
        if (image !== undefined) return image;
      }
      return fallback ? fallback(languageCode, segment) : [];
    },
  };
}
