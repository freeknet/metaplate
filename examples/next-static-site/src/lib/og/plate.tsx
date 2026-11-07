// src/lib/og/plate.tsx
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";
import { BRAND, SITE } from "../site";
import type { CardCopy } from "./cards";

/** Drawn inline, so it needs no file. Geometry only: no `<title>`, no CSS classes. */
function Mark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="13" fill="none" stroke={BRAND.accent} strokeWidth="3" />
      <path d="M9 19c4-3 10-3 14 0" fill="none" stroke={BRAND.text} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export const og = createNodeOg<CardCopy>({
  alt: (copy) => copy.alt,
  // A real extension, so a static host knows the type without any header rules.
  imagePath: "og-image.png",
  // Absolute image URLs: crawlers require them, and the tests can check them as
  // they are published instead of relying on Next's `metadataBase`.
  origin: SITE.origin,
  // Crawlers cache an image by its URL, so a changed card gets a new `?v=`. Raise
  // `revision` when the layout changes what unchanged copy looks like.
  version: "copy",
  revision: "1",
  fonts: fontsourceFontLoader([
    { font: "inter", weight: 400 },
    { font: "inter", weight: 700 },
    { font: "jetbrains-mono", weight: 500 },
  ]),
  // A title that no longer fits, or a character no font covers, fails the build.
  guards: { missingGlyphs: "error", overflow: "error", safeArea: "error", blank: "error" },
  component: (copy) => (
    <div
      style={{
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px 72px",
        background: BRAND.ground,
        color: BRAND.text,
        fontFamily: "Inter",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Mark size={48} />
        <span style={{ fontSize: 30, fontWeight: 700 }}>{SITE.name}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span
          style={{
            fontFamily: "JetBrains Mono",
            fontWeight: 500,
            fontSize: 20,
            letterSpacing: 2,
            textTransform: "uppercase",
            color: BRAND.accent,
          }}
        >
          {copy.eyebrow}
        </span>
        <span style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.08, marginTop: 18 }}>
          {copy.title}
        </span>
        <span style={{ fontSize: 26, fontWeight: 400, lineHeight: 1.4, color: BRAND.muted, marginTop: 20 }}>
          {copy.description}
        </span>
      </div>
    </div>
  ),
});
