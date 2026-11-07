import { og, type OgCopy } from "../../../../lib/og";

const POSTS = ["launch", "roadmap"];

function postCopy(slug: string): OgCopy {
  return {
    eyebrow: "Journal",
    title: `Post: ${slug}`,
    description: "A post from the journal.",
    alt: `Journal post: ${slug}`,
  };
}

// Under `output: "export"`, a dynamic route needs its params listed up front.
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return POSTS.map((slug) => ({ slug }));
}

export const GET = og.handlerFrom(
  async (_request: Request, { params }: { params: Promise<{ slug: string }> }) =>
    postCopy((await params).slug),
);
