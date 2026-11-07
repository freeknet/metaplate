// src/app/pricing/page.tsx
import { CARDS } from "../../lib/og/cards";
import { pageMetadata } from "../../lib/og/metadata";

export const metadata = pageMetadata(
  "/pricing/",
  { title: "Pricing", description: "One price for the whole crew, with no per-site fees." },
  CARDS["/pricing/"],
);

export default function Pricing() {
  return <h1>{CARDS["/pricing/"].title}</h1>;
}
