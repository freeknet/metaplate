import { createNodeOg } from "metaplate/node";

const og = createNodeOg<{ title: string; alt: string }>({
  alt: (copy) => copy.alt,
  fonts: () => [{ name: "Inter", data: new ArrayBuffer(1), weight: 700 }],
  component: (copy) => ({
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        fontFamily: "Inter",
      },
      children: copy.title,
    },
  }),
});

/** Vercel Node Functions receive a Web Request as their first argument. */
export const vercelOg = og.fetchableFrom((request: Request) => {
  const slug = new URL(request.url).pathname.split("/").pop() ?? "home";
  return { title: slug, alt: `${slug} card` };
});

/** Netlify supplies route params on the second context argument. */
export const netlifyOg = og.handlerFrom(
  (_request: Request, context: { params: { slug?: string } }) => {
    const slug = context.params.slug ?? "home";
    return { title: slug, alt: `${slug} card` };
  },
);

void vercelOg;
void netlifyOg;
