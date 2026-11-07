// src/lib/site.ts
export const SITE = {
  name: "Fieldnotes",
  origin: "https://fieldnotes.example",
  locale: "en_US",
} as const;

/** Colors live in a module because Satori does not read CSS custom properties. */
export const BRAND = {
  ground: "#10201c",
  text: "#f2efe6",
  muted: "#a9b8b0",
  accent: "#e8a33d",
} as const;

/** Every route with hand-written copy. Adding one here requires a card in cards.ts. */
export const STATIC_ROUTES = ["/", "/pricing/"] as const;
export type StaticRoute = (typeof STATIC_ROUTES)[number];
