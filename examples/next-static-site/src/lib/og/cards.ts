// src/lib/og/cards.ts
import { GUIDES, type Guide } from "../../content/guides";
import type { StaticRoute } from "../site";

/*
 * What each card says. Plain data with no import from Next or the renderer,
 * because two programs read it: the pages, for their metadata, and
 * `metaplate render`, through ./cards.render.tsx.
 */
export type CardCopy = {
  /** Small label above the title. */
  eyebrow: string;
  title: string;
  /** One sentence under the title. */
  description: string;
  /** Alternative text for the image itself, not a description of the page. */
  alt: string;
};

/** The `Record` makes a static route without a card a type error. */
export const CARDS: Record<StaticRoute, CardCopy> = {
  "/": {
    eyebrow: "Field guides",
    title: "Notes from people who have been there.",
    description: "Practical guides to coastal survey work, written after the trip.",
    alt: "Fieldnotes: notes from people who have been there.",
  },
  "/pricing/": {
    eyebrow: "Pricing",
    title: "One price for the whole crew.",
    description: "No seats and no per-site fees. Cancel at the end of any season.",
    alt: "Fieldnotes pricing: one price for the whole crew.",
  },
};

export const guideRoute = (guide: Guide) => `/guides/${guide.slug}/`;

export function guideCard(guide: Guide): CardCopy {
  return {
    eyebrow: "Guide",
    title: guide.title,
    description: guide.summary,
    alt: `Fieldnotes guide: ${guide.title}.`,
  };
}

/** Every page with a card: what `metaplate render` draws and the tests check. */
export const ALL_CARDS: readonly { route: string; copy: CardCopy }[] = [
  ...Object.entries(CARDS).map(([route, copy]) => ({ route, copy })),
  ...GUIDES.map((guide) => ({ route: guideRoute(guide), copy: guideCard(guide) })),
];
