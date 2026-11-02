// Cloudflare Worker serving metaplate/edge cards at /og/:slug. It reproduces
// the Workers limitation: Satori's bundled HarfBuzz reads self.location.href
// and compiles its Wasm from embedded bytes, so every render returns 500 with
// metaplate/edge's error naming the limitation.
// https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import layoutWasm from "satori/layout.wasm";
import inter from "@fontsource/inter/files/inter-latin-700-normal.woff";
import { createEdgeOg } from "metaplate/edge";
import { fontLoader } from "metaplate/font-data";

const og = createEdgeOg({
  alt: (copy: { title: string }) => `${copy.title} Cloudflare Workers card`,
  resvg: { wasm: resvgWasm },
  layout: { wasm: layoutWasm },
  fonts: fontLoader([{ name: "Inter", weight: 700, data: inter as ArrayBuffer }]),
  headers: { "Cache-Control": "public, max-age=86400" },
  etag: true,
  component: (copy: { title: string }) => ({
    type: "div",
    props: {
      style: {
        // Satori sizes boxes as content-box by default, so without border-box
        // the 64px padding grows the card past the canvas and a one-line
        // title lands below it, leaving a blank card.
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
      },
      children: `${copy.title} · metaplate/edge on Cloudflare Workers`,
    },
  }),
});

const cards = og.fetchableFrom((request: Request) => ({
  title: decodeURIComponent(new URL(request.url).pathname.slice("/og/".length)).slice(0, 80) || "home",
}));

export default {
  fetch(request: Request): Response | Promise<Response> {
    if (!new URL(request.url).pathname.startsWith("/og/")) return new Response("Not found", { status: 404 });
    return cards.fetch(request);
  },
};
