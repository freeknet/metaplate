// src/lib/og/metadata.ts
import type { Metadata } from "next";
import { SITE } from "../site";
import type { CardCopy } from "./cards";
import { og } from "./plate";

type PageText = {
  /** The `<title>`, before any template the layout applies. A label, not a sentence. */
  title: string;
  description: string;
};

/*
 * Next shallow-merges metadata, so a page's `openGraph` replaces the layout's
 * whole object. Every page comes through here, which restates the site fields.
 */
export function pageMetadata(route: string, page: PageText, card: CardCopy): Metadata {
  const social = og.metadata(route, card);
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: route },
    openGraph: {
      siteName: SITE.name,
      type: "website",
      locale: SITE.locale,
      url: route,
      title: card.title,
      description: card.description,
      images: social.openGraph.images,
    },
    twitter: {
      ...social.twitter,
      title: card.title,
      description: card.description,
    },
  };
}
