import { createPlateSocial } from "./plate.js";
import type { SvgOgDefinition } from "./render.js";

export const SVG_CONTENT_TYPE = "image/svg+xml" as const;

/** The Satori render function, whichever Satori build provides it. */
export type SatoriRender = typeof import("satori").default;

/**
 * Not an entry point: `createSvgOg` with the Satori build injected, so
 * `metaplate/edge` can lay out through `satori/standalone` and a
 * caller-supplied Yoga module while every other entry keeps the default build.
 */
export function createSvgPlate<Copy>(
  definition: SvgOgDefinition<Copy>,
  loadSatori: () => Promise<SatoriRender>,
) {
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
