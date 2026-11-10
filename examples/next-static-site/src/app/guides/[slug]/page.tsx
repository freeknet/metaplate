// src/app/guides/[slug]/page.tsx
import { GUIDES, getGuide } from "../../../content/guides";
import { guideCard, guideRoute } from "../../../lib/og/cards";
import { pageMetadata } from "../../../lib/og/metadata";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return GUIDES.map((guide) => ({ slug: guide.slug }));
}

export async function generateMetadata({ params }: Props) {
  const guide = getGuide((await params).slug);
  return pageMetadata(
    guideRoute(guide),
    { title: guide.title, description: guide.summary },
    guideCard(guide),
  );
}

export default async function GuidePage({ params }: Props) {
  const guide = getGuide((await params).slug);
  return <h1>{guide.title}</h1>;
}
