// Netlify Edge Function (Deno): a default export over a Web Request and
// Netlify's context, routed by config.path.
// https://docs.netlify.com/build/edge-functions/api/
import { createEdgeOg } from "metaplate/edge";
import { fontLoader } from "metaplate/font-data";

type Context = { params: Record<string, string | undefined> };

// The Resvg and Yoga Wasm modules and the font are static files of this
// deployment (public/), fetched as bytes from the origin of the first request.
let origin = "";

async function asset(path: string): Promise<ArrayBuffer> {
  const response = await fetch(new URL(path, origin));
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.arrayBuffer();
}

const og = createEdgeOg({
  alt: (copy: { title: string }) => `${copy.title} Netlify Edge card`,
  resvg: { wasm: () => asset("/wasm/resvg.wasm") },
  layout: { wasm: () => asset("/wasm/layout.wasm") },
  fonts: fontLoader([{ name: "Inter", weight: 700, data: () => asset("/fonts/inter-latin-700-normal.woff") }]),
  headers: {
    "Cache-Control": "public, max-age=86400",
    // Deno is a global only inside the Deno-based edge runtime.
    "X-Metaplate-Runtime": typeof (globalThis as { Deno?: { version?: { deno?: string } } }).Deno === "object"
      ? `deno:${(globalThis as { Deno: { version: { deno: string } } }).Deno.version.deno}`
      : "not-deno",
  },
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
        background: "#064e3b",
        color: "#ecfdf5",
        fontFamily: "Inter",
        fontSize: 60,
      },
      children: `${copy.title} · metaplate/edge on Netlify Edge`,
    },
  }),
});

const route = og.fetchableFrom((request: Request, context: Context) => {
  origin ||= new URL(request.url).origin;
  return { title: (context.params.slug ?? "home").slice(0, 80) };
});

export default (request: Request, context: Context) => route.fetch(request, context);

export const config = { path: "/og-edge/:slug" };
