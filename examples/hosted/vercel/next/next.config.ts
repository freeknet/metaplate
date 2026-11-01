import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // As in the README's "JPEG or WebP cards in Next.js": keep the native Resvg
  // binding and Satori's HarfBuzz Wasm out of the bundle.
  serverExternalPackages: ["@resvg/resvg-js", "satori"],
  // fontsourceFontLoader reads the font from node_modules at runtime, which
  // output file tracing cannot see; include the one face the plate uses.
  outputFileTracingIncludes: {
    // Keys are picomatch globs over route paths, so brackets cannot be literal.
    "/*/og-image.jpg": [
      "./node_modules/@fontsource/inter/package.json",
      "./node_modules/@fontsource/inter/metadata.json",
      "./node_modules/@fontsource/inter/files/inter-latin-700-normal.woff",
    ],
  },
};

export default nextConfig;
