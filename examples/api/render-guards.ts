// Render guards: fail a render that would ship a broken card instead of
// returning it. Every guard is off unless the plate turns it on (see
// docs/rendering.md#render-guards).
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg, RenderGuardError, type RenderGuardIssue } from "metaplate/node";
import { createSvgOg } from "metaplate/render";

type Copy = { title: string };

const card = (copy: Copy) => ({
  type: "div",
  props: {
    style: {
      boxSizing: "border-box",
      width: "100%",
      height: "100%",
      display: "flex",
      alignItems: "flex-end",
      background: "#111",
      color: "#fff",
      fontFamily: "Inter",
      fontSize: 72,
      padding: 72,
    },
    children: copy.title,
  },
});

const fonts = fontsourceFontLoader([{ font: "inter", weight: 700 }]);

/**
 * A build that must never publish a broken card: text without a font, text
 * laid out off the canvas, and a single-color image all fail the render.
 */
export const strict = createNodeOg({
  alt: (copy: Copy) => copy.title,
  fonts,
  component: card,
  guards: { missingGlyphs: "error", overflow: "error", blank: "error" },
});

export async function build(copy: Copy): Promise<Uint8Array | undefined> {
  try {
    return await strict.render(copy);
  } catch (error) {
    if (!(error instanceof RenderGuardError)) throw error;
    for (const issue of error.issues) console.error(`${issue.guard}: ${issue.message}`);
    return undefined;
  }
}

/**
 * A live route that keeps serving while it reports: warnings go to the
 * application's logger instead of console.warn.
 */
export function lenient(log: (issue: RenderGuardIssue) => void) {
  return createNodeOg({
    alt: (copy: Copy) => copy.title,
    fonts,
    component: card,
    guards: { missingGlyphs: "warn", overflow: "warn", blank: "warn", onWarning: log },
  });
}

/** SVG output has no pixels, so `metaplate/render` runs the layout guards only. */
export const svg = createSvgOg({
  alt: (copy: Copy) => copy.title,
  fonts,
  component: card,
  guards: { missingGlyphs: "error", overflow: "error" },
});
