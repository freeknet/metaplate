import type { Metadata } from "next";
import { jpegOg } from "../../lib/og";

type Props = { params: Promise<{ slug: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: slug, twitter: jpegOg.metadata(`/${slug}`, { title: slug }).twitter };
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  return <main>Metaplate hosted Vercel Next fixture: {slug}</main>;
}
