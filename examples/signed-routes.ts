import { signImagePath, verifyImageSignature } from "metaplate";
import { createNodeOg } from "metaplate/node";

/**
 * Secrets come from the server environment, newest first. Keep the previous
 * secret listed until pages and crawler caches that carry its URLs expire.
 */
const secrets = [process.env.OG_IMAGE_SECRET, process.env.OG_IMAGE_SECRET_PREVIOUS].filter(
  (secret): secret is string => secret !== undefined,
);

const og = createNodeOg<{ title: string }>({
  alt: (copy) => `${copy.title} card`,
  fonts: () => [{ name: "Inter", data: new ArrayBuffer(1), weight: 700 }],
  imagePath: "og-image.png",
  origin: "https://example.com",
  component: (copy) => ({
    type: "div",
    props: { style: { display: "flex", fontFamily: "Inter" }, children: copy.title },
  }),
});

/** Copy comes from the application's own content, never from the request. */
const posts = new Map([["hello", "Hello, world"]]);

/** The page emits the signed URL: `/posts/<slug>/<signature>/og-image.png`. */
export async function pageMetadata(slug: string, title: string) {
  return og.signedMetadata(`/posts/${slug}`, { title }, { secrets });
}

/**
 * SvelteKit `src/routes/posts/[slug]/[signature]/og-image.png/+server.ts`:
 * an unsigned or tampered path is answered with 403 before this resolver or
 * the renderer runs.
 */
export const GET = og.handlerFrom(
  ({ params }: { request: Request; params: { slug: string } }) => ({
    title: posts.get(params.slug) ?? "Example",
  }),
  { signed: { secrets } },
);

/** Express or any other server without `handlerFrom`: sign and verify directly. */
export async function expressStyle(originalUrl: string): Promise<boolean> {
  const signed = await signImagePath("/posts/hello/og-image.png", secrets);
  void signed;
  return (await verifyImageSignature(originalUrl, secrets)).valid;
}
