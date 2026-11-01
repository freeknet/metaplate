// Netlify Functions (Node.js runtime): a default export that receives a Web
// Request and Netlify's context and returns a Web Response.
// https://docs.netlify.com/build/functions/get-started/
// https://docs.netlify.com/build/functions/api/
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

const og = createNodeOg({
  alt: (copy) => `${copy.title} deployment card`,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  headers: { "Cache-Control": "public, max-age=86400" },
  etag: true,
  component: (copy) => ({
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        padding: 72,
        background: "#111827",
        color: "#ffffff",
        fontFamily: "Inter",
        fontSize: 64,
      },
      children: `${copy.title} · Netlify Functions`,
    },
  }),
});

// Named path params arrive on context.params; bound the copy length.
export default og.handlerFrom((_request, context) => ({
  title: (context.params.slug ?? "home").slice(0, 80),
}));

export const config = { path: "/og/:slug", method: "GET" };
