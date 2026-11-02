// Text in scripts the plate's fonts lack (Japanese, Arabic, Hebrew, ...)
// drawn with fallback fonts instead of missing-glyph boxes, offline. The
// application installs the Noto families it needs, for example
// `npm install @fontsource/noto-sans-jp @fontsource/noto-sans-arabic`
// (SIL Open Font License 1.1; see docs/fonts.md#other-scripts).
import { createEdgeOg } from "metaplate/edge";
import { fontLoader, languageFontLoader } from "metaplate/font-data";
import { fontsourceFontLoader, fontsourceLanguageFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

/** An English title with its translation, which may be in any script. */
type Copy = { title: string; localized: string };

const line = (text: string, fontSize: number) => ({
  type: "div",
  props: { style: { display: "flex", fontSize }, children: text },
});

// fontFamily stays the plate's own font: Satori draws each character with
// the first font that has it, so only what Inter lacks falls back.
const card = (copy: Copy) => ({
  type: "div",
  props: {
    style: {
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      justifyContent: "flex-end",
      padding: 64,
      gap: 16,
      background: "#0b1f33",
      color: "#f5f7fa",
      fontFamily: "Inter",
    },
    children: [line(copy.title, 72), line(copy.localized, 48)],
  },
});

/**
 * Node: read installed Fontsource packages. Only the subset files covering
 * the characters in the copy are read, each once per process.
 */
export const plate = createNodeOg({
  alt: (copy: Copy) => copy.title,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  languageFonts: fontsourceLanguageFontLoader({
    "ja-JP": { font: "noto-sans-jp", weight: 700 },
    "ar-AR": { font: "noto-sans-arabic", weight: [400, 700] },
    "he-IL": "noto-sans-hebrew",
  }),
  component: card,
});

export const png = () => plate.render({ title: "Release notes", localized: "リリースノート" });

/**
 * Edge: no filesystem, so serve the font files from the site's own origin
 * and fetch the subset files a segment needs. `unicodeRanges` is the
 * package's `unicode.json`, bundled with the function.
 */
export function edgePlate(
  origin: URL,
  inter: ArrayBuffer,
  japaneseRanges: Record<string, string>,
  wasm: { resvg: ArrayBuffer; layout: ArrayBuffer },
) {
  return createEdgeOg({
    alt: (copy: Copy) => copy.title,
    fonts: fontLoader([{ name: "Inter", weight: 700, data: inter }]),
    languageFonts: languageFontLoader({
      "ja-JP": {
        name: "Noto Sans JP",
        weight: 700,
        unicodeRanges: japaneseRanges,
        data: async (subset) => {
          const file = `/fonts/noto-sans-jp-${subset}-700-normal.woff`;
          const response = await fetch(new URL(file, origin));
          if (!response.ok) throw new Error(`Font request failed: ${response.status} ${file}`);
          return response.arrayBuffer();
        },
      },
    }),
    component: card,
    resvg: { wasm: wasm.resvg },
    layout: { wasm: wasm.layout },
  });
}
