// examples/api/long-titles.tsx
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

type Copy = { title: string; alt: string };

/** Step the size down by length. Measured against this plate's font and width. */
const titleSize = (title: string) => (title.length > 72 ? 48 : title.length > 36 ? 60 : 76);

export const og = createNodeOg<Copy>({
  alt: (copy) => copy.alt,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  // The clamp keeps text on the card, so this catches layout mistakes, not long copy.
  guards: { overflow: "error" },
  component: (copy) => (
    <div
      style={{
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: 72,
        background: "#111",
        color: "#fff",
        fontFamily: "Inter",
      }}
    >
      {/* `lineClamp` needs `display: "block"`, and ends the last line with an ellipsis. */}
      <div
        style={{
          display: "block",
          lineClamp: 3,
          fontSize: titleSize(copy.title),
          fontWeight: 700,
          lineHeight: 1.1,
        }}
      >
        {copy.title}
      </div>
    </div>
  ),
});
