// Images inside a plate: a project logo read once, and a per-page avatar
// fetched only from an allowlisted origin, both embedded as `data:` URIs so
// Satori never fetches anything itself (see docs/rendering.md#images-and-assets).
import { fileImageLoader, remoteImageLoader } from "metaplate/assets";
import { createEdgeOg } from "metaplate/edge";
import { fontLoader } from "metaplate/font-data";
import { fontsourceFontLoader } from "metaplate/fonts";
import { imageAssetLoader, type ImageAsset } from "metaplate/image";
import { createNextOg } from "metaplate/next";
import { createNodeOg } from "metaplate/node";

type Copy = { title: string; avatar: string };

/** Read on first render and shared by every card after it. */
const logo = fileImageLoader("public/logo.svg");

/** Fetched per page, only from the CDN, and kept in a bounded cache. */
const avatars = remoteImageLoader({ origins: ["https://avatars.example.com"] });

function card(copy: Pick<Copy, "title">, images: { logo: ImageAsset; avatar?: ImageAsset }) {
  return (
    <div
      style={{
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        gap: 48,
        padding: 72,
        background: "#111",
        color: "#fff",
        fontFamily: "Inter",
        fontSize: 64,
      }}
    >
      {images.avatar ? (
        <img src={images.avatar.src} width={160} height={160} style={{ borderRadius: 80 }} />
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <img src={images.logo.src} height={48} width={(48 * images.logo.width) / images.logo.height} />
        {copy.title}
      </div>
    </div>
  );
}

export const og = createNodeOg<Copy>({
  alt: (copy) => copy.title,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  // An async component loads what this page needs before laying it out.
  component: async (copy) => {
    const [logoAsset, avatar] = await Promise.all([logo(), avatars(copy.avatar)]);
    return card(copy, { logo: logoAsset, avatar });
  },
});

export const png = () =>
  og.render({ title: "Release notes", avatar: "https://avatars.example.com/u/42.png" });

/** The same loaders work in a Next.js `opengraph-image` route. */
export const nextOg = createNextOg<Copy>({
  alt: (copy) => copy.title,
  component: async (copy) => card(copy, { logo: await logo(), avatar: await avatars(copy.avatar) }),
});

/**
 * Edge: no filesystem and no `metaplate/assets`, so fetch the logo from the
 * site's own origin and embed it with the runtime-neutral loader.
 */
export function edgePlate(origin: URL, inter: ArrayBuffer, wasm: { resvg: ArrayBuffer; layout: ArrayBuffer }) {
  const edgeLogo = imageAssetLoader(() => fetch(new URL("/images/logo.png", origin)));
  return createEdgeOg({
    alt: (copy: Pick<Copy, "title">) => copy.title,
    fonts: fontLoader([{ name: "Inter", weight: 700, data: inter }]),
    resvg: { wasm: wasm.resvg },
    layout: { wasm: wasm.layout },
    component: async (copy) => card(copy, { logo: await edgeLogo() }),
  });
}
