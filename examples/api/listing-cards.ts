// examples/api/listing-cards.ts
import { readFile } from "node:fs/promises";
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg, type RenderJob, type RenderModule } from "metaplate/node";

type Listing = { id: string; name: string; address?: string };
type Copy = { name: string; line: string; alt: string };

const el = (type: string, style: Record<string, unknown>, children: unknown) => ({
  type,
  props: { style, children },
});

export const og = createNodeOg<Copy>({
  alt: (copy) => copy.alt,
  imagePath: "og-image.png",
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  // With data you did not write, a guard is what stops one bad row shipping.
  guards: { missingGlyphs: "error", overflow: "error" },
  component: (copy) =>
    el(
      "div",
      {
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: 72,
        background: "#111",
        color: "#fff",
        fontFamily: "Inter",
      },
      [
        el("div", { display: "block", lineClamp: 2, fontSize: 64 }, copy.name),
        el("div", { fontSize: 30, marginTop: 24 }, copy.line),
      ],
    ),
});

/** The default export may be a function, so the pages can come from anywhere. */
const listingCards: RenderModule = async () => {
  const listings: Listing[] = JSON.parse(await readFile("data/listings.json", "utf8"));
  const pages = listings.map((listing) => ({
    route: `/listings/${listing.id}/`,
    copy: {
      name: listing.name,
      line: listing.address ?? "Address to be announced",
      alt: listing.address ? `${listing.name}, ${listing.address}` : listing.name,
    },
  }));
  return { plate: og, pages } satisfies RenderJob<Copy>;
};

export default listingCards;
