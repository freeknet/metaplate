import { createNextOg } from "metaplate/next";

const og = createNextOg({
  component: (copy: { title: string }) => (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", padding: 80, background: "#111827", color: "#ffffff", fontSize: 64 }}>
      {`${copy.title} (metaplate/next on Vercel)`}
    </div>
  ),
  alt: (copy) => `${copy.title} metadata card`,
});

export const dynamic = "force-dynamic";
export const size = og.size;
export const contentType = og.contentType;

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return og.render({ title: slug.slice(0, 80) });
}
