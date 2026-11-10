// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // No image optimizer runs behind a static export.
  images: { unoptimized: true },
  // `/pricing/` is written as `pricing/index.html`, beside `pricing/og-image.png`.
  trailingSlash: true,
  // Pages import the plate to build their metadata. The renderer loads only when
  // something renders, but Turbopack still traces the import and cannot bundle
  // Resvg's native binary or Satori's Wasm.
  serverExternalPackages: ["@resvg/resvg-js", "satori"],
};

export default nextConfig;
