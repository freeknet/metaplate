// Vercel Function on the Edge runtime (https://vercel.com/docs/functions/runtimes/edge).
// Edge forbids compiling Wasm from bytes, so both modules arrive as `?module`
// imports (https://vercel.com/docs/functions/runtimes/wasm), and Satori's
// layout engine comes from satori/layout.wasm through `layout`.
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm?module";
import layoutWasm from "satori/layout.wasm?module";
import { createEdgeOg } from "metaplate/edge";
import { fontLoader } from "metaplate/font-data";

export const config = { runtime: "edge" };

// The font is a static file of this deployment (public/fonts); edge has no
// filesystem, so it is fetched once from the origin of the first request.
let fontOrigin;

const og = createEdgeOg({
  alt: (copy) => `${copy.title} hosted Vercel Edge card`,
  resvg: { wasm: resvgWasm },
  layout: { wasm: layoutWasm },
  fonts: fontLoader([
    {
      name: "Inter",
      weight: 700,
      data: async () => {
        const response = await fetch(new URL("/fonts/inter-latin-700-normal.woff", fontOrigin));
        if (!response.ok) throw new Error(`Unable to load font: ${response.status}`);
        return response.arrayBuffer();
      },
    },
  ]),
  headers: {
    "Cache-Control": "public, max-age=300, s-maxage=86400",
    // Evaluated where the module runs: the Edge runtime defines EdgeRuntime.
    "X-Metaplate-Runtime": typeof EdgeRuntime === "string" ? `edge:${EdgeRuntime}` : "not-edge",
  },
  etag: true,
  component: (copy) => ({
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: 80,
        background: "#1e1b4b",
        color: "#ffffff",
        fontFamily: "Inter",
      },
      children: [
        { type: "div", props: { style: { fontSize: 32, color: "#c4b5fd" }, children: "metaplate/edge on Vercel Edge" } },
        { type: "div", props: { style: { fontSize: 72, marginTop: 24 }, children: copy.title } },
      ],
    },
  }),
});

const fetchable = og.fetchableFrom((request) => {
  const url = new URL(request.url);
  fontOrigin ??= url.origin;
  const segment = url.pathname.split("/").filter(Boolean).at(-1) ?? "home";
  return { title: decodeURIComponent(segment).slice(0, 80) };
});

export default function handler(request) {
  return fetchable.fetch(request);
}
