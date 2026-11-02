// Deno Deploy certification app for metaplate. Deployed by `npm run deploy`;
// see README.md.
//   /og/:slug       metaplate/edge through @resvg/resvg-wasm
//   /og-node/:slug  metaplate/node through the native @resvg/resvg-js binding
// Wasm and font files are read from this deployment's own node_modules.
import { createEdgeOg } from "metaplate/edge";
import { createNodeOg } from "metaplate/node";
import { fontLoader } from "metaplate/font-data";

const file = (path: string) => Deno.readFile(new URL(path, import.meta.url));
const fonts = fontLoader([
  { name: "Inter", weight: 700, data: () => file("./node_modules/@fontsource/inter/files/inter-latin-700-normal.woff") },
]);

const card = (label: string) => (copy: { title: string }) => ({
  type: "div",
  props: {
    style: {
      // Satori sizes boxes as content-box by default, so without border-box
      // the 64px padding grows the card past the canvas and a one-line title
      // lands below it.
      boxSizing: "border-box",
      width: "100%",
      height: "100%",
      display: "flex",
      alignItems: "flex-end",
      padding: 64,
      background: "#0c4a6e",
      color: "#f0f9ff",
      fontFamily: "Inter",
      fontSize: 60,
    },
    children: `${copy.title} · ${label} on Deno Deploy`,
  },
});

const shared = {
  alt: (copy: { title: string }) => `${copy.title} Deno Deploy card`,
  fonts,
  headers: { "Cache-Control": "public, max-age=86400" },
  etag: true as const,
};

const edge = createEdgeOg({
  ...shared,
  resvg: { wasm: () => file("./node_modules/@resvg/resvg-wasm/index_bg.wasm") },
  layout: { wasm: () => file("./node_modules/satori/layout.wasm") },
  component: card("metaplate/edge"),
});
const node = createNodeOg({ ...shared, component: card("metaplate/node") });

const slug = (request: Request, prefix: string) =>
  decodeURIComponent(new URL(request.url).pathname.slice(prefix.length)).slice(0, 80) || "home";
const edgeCards = edge.fetchableFrom((request: Request) => ({ title: slug(request, "/og/") }));
const nodeCards = node.fetchableFrom((request: Request) => ({ title: slug(request, "/og-node/") }));

async function guarded(render: () => Promise<Response>): Promise<Response> {
  try {
    return await render();
  } catch (error) {
    // The details go to the deployment's logs, not to the client.
    console.error("render failed", error);
    return new Response("render failed\n", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

// metaplate-pack.json names the tarball this deployment installed.
const pack = await Deno.readTextFile(new URL("./metaplate-pack.json", import.meta.url)).catch(() => "null");

// METAPLATE_PORT exists only for local testing; Deno Deploy uses the default.
Deno.serve({ port: Number(Deno.env.get("METAPLATE_PORT") ?? "8000") }, (request) => {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/og-node/")) return guarded(() => nodeCards.fetch(request));
  if (pathname.startsWith("/og/")) return guarded(() => edgeCards.fetch(request));
  const body = { deno: Deno.version.deno, metaplate: JSON.parse(pack) };
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
});
