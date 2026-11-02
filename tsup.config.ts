import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    next: "src/next.tsx",
    render: "src/render.ts",
    node: "src/node.ts",
    edge: "src/edge.ts",
    fonts: "src/fonts.ts",
    "font-data": "src/font-data.ts",
    emoji: "src/emoji.ts",
    png: "src/png.ts",
    image: "src/image.ts",
    assets: "src/assets.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: [
    "@resvg/resvg-js",
    "@resvg/resvg-wasm",
    "next",
    "react",
    "react/jsx-runtime",
    "satori",
    "satori/standalone",
  ],
});
