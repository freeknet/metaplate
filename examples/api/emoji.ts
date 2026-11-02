// Emoji drawn as images instead of missing glyphs. Metaplate ships no emoji
// artwork: the application installs a set (`npm install @twemoji/svg`) and
// credits it, because the graphics carry their own license (see docs/emoji.md).
import { createEdgeOg } from "metaplate/edge";
import { emojiLoader, twemojiName } from "metaplate/emoji";
import { fontLoader } from "metaplate/font-data";
import { fontsourceFontLoader, packageEmojiLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

type Copy = { title: string };

const card = (copy: Copy) => ({
  type: "div",
  props: {
    style: {
      width: "100%",
      height: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#111",
      color: "#fff",
      fontFamily: "Inter",
      fontSize: 72,
    },
    children: copy.title,
  },
});

/**
 * Node: read Twemoji SVGs from the installed package, offline. Each emoji is
 * read once; one the package lacks is drawn with Inter instead.
 */
export const plate = createNodeOg({
  alt: (copy: Copy) => copy.title,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  emoji: packageEmojiLoader("twemoji"),
  component: card,
});

export const png = () => plate.render({ title: "Shipped 🚀 with 💜" });

/**
 * Edge: no filesystem, so serve copies of the SVGs from the site's own
 * origin (here `/emoji/<twemoji name>.svg`) and fetch them. A 404 means the
 * set has no image for that emoji; any other failure fails the render rather
 * than caching a card with a hole in it.
 */
export function edgePlate(origin: URL, inter: ArrayBuffer, wasm: { resvg: ArrayBuffer; layout: ArrayBuffer }) {
  return createEdgeOg({
    alt: (copy: Copy) => copy.title,
    fonts: fontLoader([{ name: "Inter", weight: 700, data: inter }]),
    emoji: emojiLoader(async ({ grapheme }) => {
      const response = await fetch(new URL(`/emoji/${twemojiName(grapheme)}.svg`, origin));
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`Emoji request failed: ${response.status}`);
      return response.arrayBuffer();
    }),
    component: card,
    resvg: { wasm: wasm.resvg },
    layout: { wasm: wasm.layout },
  });
}
