// src/app/page.tsx
import { CARDS } from "../lib/og/cards";
import { pageMetadata } from "../lib/og/metadata";

export const metadata = pageMetadata(
  "/",
  { title: "Fieldnotes", description: "Practical guides to coastal survey work." },
  CARDS["/"],
);

export default function Home() {
  return <h1>{CARDS["/"].title}</h1>;
}
