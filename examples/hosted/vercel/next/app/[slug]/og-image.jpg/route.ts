import { jpegOg } from "../../../lib/og";

type Context = { params: Promise<{ slug: string }> };

export const dynamic = "force-dynamic";
export const GET = jpegOg.handlerFrom(async (_request: Request, { params }: Context) => ({
  title: (await params).slug.slice(0, 80),
}));
