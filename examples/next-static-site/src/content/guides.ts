// src/content/guides.ts
export type Guide = { slug: string; title: string; summary: string };

/** Stands in for a CMS, a folder of Markdown, or anything else read at build time. */
export const GUIDES: readonly Guide[] = [
  {
    slug: "first-survey",
    title: "Running your first survey",
    summary: "What to pack, what to record, and what to leave for the second visit.",
  },
  {
    slug: "reading-the-tide-tables",
    title: "Reading the tide tables without a chart",
    summary: "Three numbers that tell you when the site is safe to reach.",
  },
];

export function getGuide(slug: string): Guide {
  const guide = GUIDES.find((candidate) => candidate.slug === slug);
  if (!guide) throw new Error(`No guide with the slug "${slug}"`);
  return guide;
}
