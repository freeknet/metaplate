/* global URL, Response */
// The examples/hosted/cloudflare/worker card, rendered by takumi-js instead of
// metaplate/edge (Satori+resvg), served at /og/:slug. No caching, so every
// request renders and Cloudflare's per-request CPU time measures the render.
import { render } from "takumi-js";
import inter from "@fontsource/inter/files/inter-latin-700-normal.woff2";

const fonts = [{ name: "Inter", weight: 700, data: inter }];

const card = (title) => ({
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
      fontSize: 60,
      fontWeight: 700,
    },
    children: `${title} · metaplate/edge on Cloudflare Workers`,
  },
});

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/og/")) return new Response("Not found", { status: 404 });
    const title = decodeURIComponent(pathname.slice("/og/".length)).slice(0, 80) || "home";
    // emoji: "from-font" keeps Takumi from fetching emoji SVGs from its CDN.
    const png = await render(card(title), { width: 1200, height: 630, fonts, emoji: "from-font" });
    return new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  },
};
