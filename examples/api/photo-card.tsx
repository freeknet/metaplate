// examples/api/photo-card.tsx
import { readImageAsset } from "metaplate/assets";
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

type Copy = { eyebrow: string; title: string; photo: string; alt: string };

const PHOTO_WIDTH = 520;

export const og = createNodeOg<Copy>({
  alt: (copy) => copy.alt,
  // The route folder or output path takes this name, so hosts infer the type.
  imagePath: "og-image.jpg",
  fonts: fontsourceFontLoader([
    { font: "inter", weight: 400 },
    { font: "inter", weight: 700 },
  ]),
  output: {
    format: "jpeg",
    // Imported here so a page that only builds metadata never loads sharp.
    encode: async ({ pixels, width, height }) => {
      const { default: sharp } = await import("sharp");
      return sharp(pixels, { raw: { width, height, channels: 4 } })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer();
    },
  },
  guards: {
    missingGlyphs: "error",
    overflow: "error",
    blank: "error",
    // Fails a card whose text runs under the element with this `key`.
    avoid: { level: "error", keys: ["photo"], gap: 24 },
  },
  component: async (copy, { size }) => {
    // Read per card, so name only photos you control, never request input.
    const photo = await readImageAsset(`assets/photos/${copy.photo}.jpg`);
    return (
      <div style={{ display: "flex", width: "100%", height: "100%", background: "#10201c" }}>
        <div
          style={{
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            width: size.width - PHOTO_WIDTH,
            height: "100%",
            padding: "56px 48px 56px 64px",
            color: "#f2efe6",
            fontFamily: "Inter",
          }}
        >
          <span style={{ fontSize: 22, fontWeight: 400, color: "#e8a33d" }}>{copy.eyebrow}</span>
          <span style={{ fontSize: 58, fontWeight: 700, lineHeight: 1.08, marginTop: 14 }}>
            {copy.title}
          </span>
        </div>
        <img
          key="photo"
          src={photo.src}
          width={PHOTO_WIDTH}
          height={size.height}
          style={{ objectFit: "cover" }}
        />
      </div>
    );
  },
});
