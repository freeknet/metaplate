import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    next: "src/next.tsx",
    render: "src/render.ts",
    node: "src/node.ts",
    fonts: "src/fonts.ts",
    "font-data": "src/font-data.ts",
    png: "src/png.ts",
    image: "src/image.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: [
    "@resvg/resvg-js",
    "next",
    "react",
    "react/jsx-runtime",
    "satori",
  ],
});
