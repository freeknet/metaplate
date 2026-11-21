// A Cloudflare Worker serving cards drawn by Takumi (experimental; see
// docs/takumi.md). Wrangler bundles the font as an ArrayBuffer through a Data
// rule for `**/*.woff2`; `takumi-js` loads its own precompiled Wasm.
import { emojiLoader, twemojiName } from "metaplate/emoji";
import { fontLoader, languageFontLoader } from "metaplate/font-data";
import { createTakumiOg } from "metaplate/takumi";

type Copy = { title: string };

export function workerCards(fonts: { inter: ArrayBuffer; notoSansJp: ArrayBuffer }, origin: URL) {
  const og = createTakumiOg({
    alt: (copy: Copy) => copy.title,
    // Takumi reads WOFF2, TrueType, and OpenType, not WOFF.
    fonts: fontLoader([{ name: "Inter", weight: 700, data: fonts.inter }]),
    // Offered Satori's language codes, so the same loader serves both renderers.
    languageFonts: languageFontLoader({ "ja-JP": { name: "Noto Sans JP", weight: 700, data: () => fonts.notoSansJp } }),
    // Emoji come from the site's own copies, never Takumi's CDN.
    emoji: emojiLoader(async ({ grapheme }) => {
      const response = await fetch(new URL(`/emoji/${twemojiName(grapheme)}.svg`, origin));
      return response.ok ? response.arrayBuffer() : undefined;
    }),
    guards: { missingGlyphs: "error", overflow: "error", fontFallback: "error" },
    // The Workers Free plan allows 10 ms of CPU per request and a warm render
    // takes more, so let caches serve repeats.
    headers: { "Cache-Control": "public, max-age=86400, immutable" },
    etag: true,
    component: (copy: Copy) => ({
      type: "div",
      props: {
        style: {
          boxSizing: "border-box",
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "flex-end",
          padding: 64,
          background: "#1e1b4b",
          color: "#eef2ff",
          fontFamily: "Inter",
          fontWeight: 700,
          fontSize: 60,
        },
        children: copy.title,
      },
    }),
  });

  const cards = og.fetchableFrom((request: Request) => ({
    title: decodeURIComponent(new URL(request.url).pathname.slice("/og/".length)).slice(0, 80) || "home",
  }));

  return {
    fetch(request: Request): Response | Promise<Response> {
      if (!new URL(request.url).pathname.startsWith("/og/")) return new Response("Not found", { status: 404 });
      return cards.fetch(request);
    },
  };
}
