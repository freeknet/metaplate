import sharp from "sharp";
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";
import { origin } from "./origin";

export const jpegOg = createNodeOg({
  alt: (copy: { title: string }) => `${copy.title} social card`,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  imagePath: "og-image.jpg",
  origin,
  headers: { "Cache-Control": "public, max-age=86400" },
  etag: true,
  output: {
    format: "jpeg",
    encode: ({ pixels, width, height }) =>
      sharp(pixels, { raw: { width, height, channels: 4 } }).jpeg({ quality: 80 }).toBuffer(),
  },
  component: (copy: { title: string }) => ({
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        padding: 80,
        background: "#0f172a",
        color: "#ffffff",
        fontFamily: "Inter",
        fontSize: 72,
      },
      children: `${copy.title} (metaplate/node JPEG on Vercel)`,
    },
  }),
});
