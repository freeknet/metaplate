import { expect, it } from "vitest";
import { createNextOg } from "../src/next.js";
import { verifyPng } from "../src/png.js";

type HandlerCopy = { title: string; alt: string };

function createHandlerPlate() {
  return createNextOg<HandlerCopy>({
    alt: (copy) => copy.alt,
    component: (copy) => (
      <div style={{ width: "100%", height: "100%", display: "flex", fontSize: 48 }}>
        {copy.title}
      </div>
    ),
  });
}

it("renders a real PNG through Next ImageResponse", async () => {
  const plate = createNextOg<{ title: string; alt: string }>({
    alt: (copy) => copy.alt,
    component: (copy) => (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#111111",
          color: "#ffffff",
          fontSize: 64,
        }}
      >
        {copy.title}
      </div>
    ),
  });

  const response = await plate.render({ title: "Metaplate", alt: "Metaplate card" });
  expect(response.headers.get("content-type")).toBe("image/png");
  verifyPng(await response.arrayBuffer(), plate.size);
});

it("keeps route and metadata helpers on the same definition", () => {
  const plate = createNextOg<{ alt: string }>({
    alt: (copy) => copy.alt,
    component: () => <div style={{ display: "flex" }}>Card</div>,
    imagePath: "social-image",
    basePath: "/project",
  });

  const copy = { alt: "A card" };
  expect(plate.image("/docs", copy).url).toBe("/project/docs/social-image");
  expect(plate.metadata("/docs", copy).twitter.images[0]?.alt).toBe("A card");
});

it("returns a route handler bound to one copy", async () => {
  const plate = createHandlerPlate();

  const GET = plate.handler({ title: "Route", alt: "Route card" });
  const response = await GET();

  expect(response.headers.get("content-type")).toBe("image/png");
  verifyPng(await response.arrayBuffer(), plate.size);
});

it("resolves dynamic copy from promised Next route params", async () => {
  const plate = createHandlerPlate();
  const GET = plate.handlerFrom(
    async (_request: Request, context: { params: Promise<{ slug: string }> }) => {
      const { slug } = await context.params;
      return { title: slug, alt: `${slug} card` };
    },
  );
  const response = await GET(new Request("https://example.com/card"), {
    params: Promise.resolve({ slug: "Dynamic" }),
  });

  expect(response.headers.get("content-type")).toBe("image/png");
  verifyPng(await response.arrayBuffer(), plate.size);
});

it("rejects a size outside the supported range at definition", () => {
  expect(() =>
    createNextOg({
      alt: () => "card",
      size: { width: 0, height: 100 },
      component: () => <div style={{ display: "flex" }}>Card</div>,
    }),
  ).toThrow(/Invalid size: width/);
});

it("advertises an origin URL when one is configured", () => {
  const plate = createNextOg({
    alt: () => "card",
    origin: "https://example.com",
    component: () => <div style={{ display: "flex" }}>Card</div>,
  });

  expect(plate.metadata("/docs", {}).openGraph.images[0]?.url).toBe(
    "https://example.com/docs/og-image",
  );
  expect(plate.metadata("/docs", {}).openGraph.images[0]?.type).toBe("image/png");
});
