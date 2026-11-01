// Vercel Function on the Node.js runtime (https://vercel.com/docs/functions/runtimes/node-js):
// a named GET export over Web Request/Response, rendered by the packed metaplate/node.
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

const og = createNodeOg({
  alt: (copy) => `${copy.title} hosted Vercel card`,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  headers: { "Cache-Control": "public, max-age=300, s-maxage=86400" },
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
        background: "#111827",
        color: "#ffffff",
        fontFamily: "Inter",
      },
      children: [
        { type: "div", props: { style: { fontSize: 32, color: "#93c5fd" }, children: "metaplate/node on Vercel Functions" } },
        { type: "div", props: { style: { fontSize: 72, marginTop: 24 }, children: copy.title } },
      ],
    },
  }),
});

// Vercel passes the dynamic `[slug]` segment in the request path.
export const GET = og.handlerFrom((request) => {
  const segment = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "home";
  return { title: decodeURIComponent(segment).slice(0, 80) };
});
