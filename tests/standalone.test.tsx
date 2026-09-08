import { createElement } from "react";
import { expect, it } from "vitest";
import { packageFontLoader } from "../src/fonts.js";
import { createNextOg } from "../src/next.js";
import { createNodeOg, type RenderedPixels } from "../src/node.js";
import { imageDimensions, verifyImage } from "../src/image.js";
import { verifyPng } from "../src/png.js";
import { createSvgOg } from "../src/render.js";

const fonts = packageFontLoader([
  {
    name: "Inter",
    package: "@fontsource/inter",
    file: "files/inter-latin-700-normal.woff",
    weight: 700,
  },
]);

const definition = {
  alt: (copy: { title: string }) => `${copy.title} social card`,
  fonts,
  component: (copy: { title: string }) => (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#111111",
        color: "#ffffff",
        fontFamily: "Inter",
        fontWeight: 700,
        fontSize: 64,
      }}
    >
      {copy.title}
    </div>
  ),
} as const;

it("renders SVG without Next.js", async () => {
  const plate = createSvgOg(definition);
  expect(plate.contentType).toBe("image/svg+xml");
  const svg = await plate.renderSvg({ title: "Framework neutral" });
  expect(svg).toMatch(/^<svg/);
  expect(svg).toContain('width="1200"');
  expect(imageDimensions(new TextEncoder().encode(svg))).toEqual({
    width: 1200,
    height: 630,
    format: "svg",
  });
  expect(verifyImage(new TextEncoder().encode(svg), plate.size, "svg")).toMatchObject({
    format: "svg",
  });
  expect(plate.metadata("/docs", { title: "Docs" }).openGraph.images[0]?.alt).toBe(
    "Docs social card",
  );
});

it(
  "renders PNG bytes without Next.js",
  async () => {
    const plate = createNodeOg(definition);
    expect(plate.contentType).toBe("image/png");
    const png = await plate.render({ title: "Node PNG" });
    verifyPng(png, plate.size);
  },
  // Loading the native renderer and fonts can exceed Vitest's five-second
  // default on a cold Windows runner; warmed renders remain much faster.
  20_000,
);

it("returns a Web Response usable by route-based frameworks", async () => {
  const plate = createNodeOg({
    ...definition,
    headers: { "Cache-Control": "public, max-age=3600" },
  });
  const response = await plate.response({ title: "HTTP response" });
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  verifyPng(await response.arrayBuffer(), plate.size);
});

// The README documents `createElement` as the build-script authoring form for
// projects without a JSX toolchain, including its lone-string-child rule.
it("types and renders a React-free plain object tree", async () => {
  // No `createElement`, no JSX: the tree is exactly the `{ type, props }`
  // shape the README promises works when React is not installed at all.
  const plate = createSvgOg({
    ...definition,
    component: () => ({
      type: "div",
      props: {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "Inter",
          fontSize: 48,
        },
        children: "Plain tree",
      },
    }),
  });

  const svg = await plate.renderSvg({ title: "Plain" });
  expect(svg).toMatch(/^<svg/);
  // Satori outlines text into paths rather than keeping text nodes, so the
  // assertion proves the tree rendered (glyph paths exist for the heading).
  expect(svg).toContain("<path");
  expect(svg).toMatch(/width="1200"/);
});

it("renders an element tree authored without JSX", async () => {
  const plate = createSvgOg({
    ...definition,
    component: (copy: { title: string }) =>
      createElement(
        "div",
        {
          style: {
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            fontFamily: "Inter",
          },
        },
        createElement("div", { style: { fontSize: 32 } }, "Eyebrow"),
        createElement("div", { style: { fontSize: 64 } }, copy.title),
      ),
  });

  const svg = await plate.renderSvg({ title: "No JSX" });
  expect(svg).toMatch(/^<svg/);
  expect(svg).toContain('width="1200"');
});

it("requires at least one font", async () => {
  const plate = createSvgOg({ ...definition, fonts: () => [] });

  await expect(plate.renderSvg({ title: "No fonts" })).rejects.toThrow(
    /at least one font/,
  );
});

it("renders the defined size and only that size", async () => {
  const plate = createSvgOg({ ...definition, size: { width: 600, height: 315 } });

  expect(plate.size).toEqual({ width: 600, height: 315 });
  const svg = await plate.renderSvg({ title: "Small" });
  expect(svg).toContain('width="600"');
  expect(svg).toContain('height="315"');
  expect(plate.metadata("/", { title: "Small" }).openGraph.images[0]?.width).toBe(600);
});

it("rejects invalid definition sizes at plate creation", () => {
  const invalid = (size: { width: number; height: number }) =>
    () => createSvgOg({ ...definition, size });
  expect(invalid({ width: 0, height: 630 })).toThrow(/Invalid size: width/);
  expect(invalid({ width: 1200.5, height: 630 })).toThrow(/Invalid size: width/);
  expect(invalid({ width: 1200, height: Number.NaN })).toThrow(/Invalid size: height/);

  const invalidNext = (size: { width: number; height: number }) =>
    createNextOg({
      alt: () => "card",
      size,
      component: () => <div style={{ display: "flex" }}>Card</div>,
    });
  expect(() => invalidNext({ width: 0, height: 630 })).toThrow(/Invalid size: width/);
});

it("builds absolute metadata URLs from a plate origin", () => {
  const plate = createSvgOg({ ...definition, origin: "https://example.com" });
  expect(plate.metadata("/docs", { title: "Docs" }).openGraph.images[0]?.url).toBe(
    "https://example.com/docs/og-image",
  );

  const node = createNodeOg({ ...definition, origin: "https://example.com" });
  expect(node.image("/docs", { title: "Docs" }).url).toBe(
    "https://example.com/docs/og-image",
  );
});

it(
  "renders raw RGBA pixels for another encoder",
  async () => {
    const plate = createNodeOg(definition);
    const { pixels, width, height } = await plate.renderPixels({ title: "Pixels" });

    expect(width).toBe(plate.size.width);
    expect(height).toBe(plate.size.height);
    expect(pixels.length).toBe(width * height * 4);
  },
  20_000,
);

// Dust Compass renders 1,513 cards through a six-way pool. Satori is a pure
// call and each render builds its own Resvg instance, so concurrent renders
// must agree with sequential ones rather than share mutable state.
it(
  "renders concurrently without sharing state",
  async () => {
    const plate = createNodeOg(definition);
    const copies = ["one", "two", "three", "four", "five", "six"].map((title) => ({
      title,
    }));

    const concurrent = await Promise.all(copies.map((copy) => plate.render(copy)));
    const sequential = [];
    for (const copy of copies) sequential.push(await plate.render(copy));

    for (const [index, bytes] of concurrent.entries()) {
      expect(Buffer.from(bytes).equals(Buffer.from(sequential[index]!))).toBe(true);
    }
    expect(Buffer.from(concurrent[0]!).equals(Buffer.from(concurrent[1]!))).toBe(false);
  },
  60_000,
);

it(
  "encodes with a supplied encoder and serves its media type",
  async () => {
    const encoded = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0);
    const seen: RenderedPixels[] = [];
    const plate = createNodeOg({
      ...definition,
      output: {
        format: "jpeg",
        encode: (image) => {
          seen.push(image);
          return encoded;
        },
      },
    });

    expect(plate.contentType).toBe("image/jpeg");
    expect(await plate.render({ title: "Encoded" })).toEqual(encoded);

    const response = await plate.response({ title: "Encoded" });
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(encoded);

    const image = seen[0]!;
    expect(image.pixels.length).toBe(image.width * image.height * 4);
  },
  20_000,
);

// The README promises row-major RGBA, and every consumer encoder is configured
// from that promise. A channel-order regression would leave dimensions correct
// and every card's colours wrong, so the bytes are asserted directly.
it(
  "returns pixels in row-major RGBA order",
  async () => {
    const plate = createNodeOg({
      ...definition,
      component: () => (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            background: "rgb(0,170,255)",
          }}
        />
      ),
    });

    const { pixels, width, height } = await plate.renderPixels({ title: "Colour" });
    const centre = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;

    expect(Array.from(pixels.slice(0, 4))).toEqual([0, 170, 255, 255]);
    expect(Array.from(pixels.slice(centre, centre + 4))).toEqual([0, 170, 255, 255]);
  },
  20_000,
);

// sharp and other native encoders return Buffers backed by a shared pool, so
// the encoded bytes usually sit at a non-zero offset inside a larger
// ArrayBuffer. `response` slices by that offset; getting it wrong would serve
// neighbouring pool memory rather than the card.
it(
  "serves encoded bytes that sit at an offset inside a pooled buffer",
  async () => {
    // Buffer.from already allocates from Node's pool, so this view starts well
    // inside a much larger ArrayBuffer rather than at zero.
    const pool = Buffer.from([0xaa, 0xbb, 0xcc, 0xff, 0xd8, 0xff, 0xe0, 0x99]);
    const encoded = pool.subarray(3, 7);
    expect(encoded.byteOffset).toBeGreaterThan(0);
    expect(encoded.buffer.byteLength).toBeGreaterThan(encoded.byteLength);

    const plate = createNodeOg({
      ...definition,
      output: { format: "jpeg", encode: () => encoded },
    });

    const response = await plate.response({ title: "Pooled" });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      Uint8Array.of(0xff, 0xd8, 0xff, 0xe0),
    );
  },
  20_000,
);

// `handler` is the documented integration point for Astro, SvelteKit, and any
// other route system that returns a Web Response, and nothing called it.
it(
  "returns a Fetch handler bound to one copy",
  async () => {
    const plate = createNodeOg({
      ...definition,
      headers: { "Cache-Control": "public, max-age=86400" },
    });

    const GET = plate.handler({ title: "Handler" });
    const response = await GET();

    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    verifyPng(await response.arrayBuffer(), plate.size);
  },
  20_000,
);

it(
  "resolves dynamic copy from all framework handler arguments",
  async () => {
    const plate = createNodeOg(definition);
    const GET = plate.handlerFrom(
      async (request: Request, context: { params: { slug: string } }) => ({
        title: `${context.params.slug}:${new URL(request.url).pathname}`,
      }),
    );
    const response = await GET(new Request("https://example.com/cards/guide"), {
      params: { slug: "guide" },
    });

    expect(response.headers.get("content-type")).toBe("image/png");
    verifyPng(await response.arrayBuffer(), plate.size);
  },
  20_000,
);

it("rejects Resvg settings that can desynchronize rendered dimensions", () => {
  expect(() =>
    createNodeOg({
      ...definition,
      resvg: { fitTo: { mode: "width", value: 600 } },
    }),
  ).toThrow(/must preserve.*1200x630/);
  expect(() =>
    createNodeOg({
      ...definition,
      resvg: { crop: { left: 0, top: 0, right: 600, bottom: 315 } },
    }),
  ).toThrow(/crop is not supported/);
  expect(() =>
    createNodeOg({
      ...definition,
      resvg: { fitTo: { mode: "width", value: 1200 } },
    }),
  ).not.toThrow();
});

// TypeScript covers the encoder contract for typed consumers; plain JavaScript
// build scripts are exactly the case this API was added for, and there the
// wrong return type has to say which side is wrong.
it.each([
  ["a string", "not bytes", "string"],
  ["an ArrayBuffer", new ArrayBuffer(4), "ArrayBuffer"],
  ["null", null, "null"],
])("rejects an encoder returning %s", async (_label, value, described) => {
  const plate = createNodeOg({
    ...definition,
    output: {
      format: "jpeg",
      encode: () => value as unknown as Uint8Array,
    },
  });

  await expect(plate.render({ title: "Wrong" })).rejects.toThrow(
    `output.encode must return a Uint8Array; received ${described}`,
  );
}, 20_000);

it(
  "rejects encoded bytes that do not match the declared format",
  async () => {
    // Declared JPEG, but the bytes are really WebP (RIFF....WEBPVP8X...).
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x2a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const plate = createNodeOg({
      ...definition,
      output: { format: "jpeg", encode: () => webp },
    });

    await expect(plate.render({ title: "Mismatch" })).rejects.toThrow(
      /output.encode produced webp bytes, not the declared jpeg format/,
    );
  },
  20_000,
);

it(
  "rejects empty custom encoder output and invalid media types",
  async () => {
    expect(() => createNodeOg({
      ...definition,
      output: { contentType: "not-a-media-type", checkSignature: false, encode: () => Uint8Array.of(1) },
    })).toThrow(/Invalid output contentType/);
    const plate = createNodeOg({
      ...definition,
      output: { format: "jpeg", encode: () => new Uint8Array() },
    });
    await expect(plate.render({ title: "Empty" })).rejects.toThrow(/non-empty image bytes/);
  },
  20_000,
);

it(
  "serves a declared custom format through the escape hatch",
  async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const plate = createNodeOg({
      ...definition,
      output: {
        contentType: "image/avif",
        checkSignature: false,
        encode: () => bytes,
      },
    });

    expect(plate.contentType).toBe("image/avif");
    expect(await plate.render({ title: "Custom" })).toEqual(bytes);
  },
  20_000,
);

it(
  "supports Fetchable handlers with async multi-argument resolvers",
  async () => {
    const plate = createNodeOg(definition);
    const route = plate.fetchableFrom(async (request: Request, context: { params: { slug: string } }) => ({
      title: `${context.params.slug}:${new URL(request.url).pathname}`,
    }));
    const response = await route.fetch(new Request("https://example.com/cards/guide"), {
      params: { slug: "guide" },
    });
    expect(response.headers.get("content-type")).toBe("image/png");
    verifyPng(await response.arrayBuffer(), plate.size);
  },
  20_000,
);

it(
  "returns a byte and metadata artifact from the same copy",
  async () => {
    const plate = createNodeOg({ ...definition, etag: "sha256", origin: "https://example.com" });
    const artifact = await plate.artifact("/docs", { title: "Docs" });
    expect(artifact.byteLength).toBe(artifact.bytes.byteLength);
    expect(artifact.contentType).toBe("image/png");
    expect(artifact.image).toEqual({ width: 1200, height: 630, format: "png" });
    expect(artifact.metadata.openGraph.images[0]?.url).toBe("https://example.com/docs/og-image");
    expect(artifact.etag).toBeDefined();
    expect(artifact.etag?.length).toBe(66);
    expect(artifact.etag?.startsWith('"')).toBe(true);
  },
  20_000,
);

it(
  "owns representation headers and computes length and ETag",
  async () => {
    const plate = createNodeOg({ ...definition, etag: true, headers: { "Cache-Control": "public, max-age=60" } });
    const response = await plate.response({ title: "Headers" });
    expect(response.headers.get("content-length")).toBe(String(Number(response.headers.get("content-length"))));
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("etag")).toBeDefined();
    expect(response.headers.get("etag")?.length).toBe(66);
    expect(response.headers.get("etag")?.startsWith('"')).toBe(true);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(() => createNodeOg({ ...definition, headers: { "Content-Length": "1" } })).toThrow(/owned by Metaplate/);
    expect(() => createNodeOg({ ...definition, headers: { "Content-Encoding": "gzip" } })).toThrow(/owned by Metaplate/);
    expect(() => createNodeOg({ ...definition, etag: true, headers: { ETag: "\"caller\"" } })).toThrow(/automatic Metaplate ETag generation/);
  },
  20_000,
);

it(
  "preserves a caller ETag when automatic ETag generation is disabled",
  async () => {
    const plate = createNodeOg({
      ...definition,
      headers: { ETag: "\"caller\"" },
    });
    const response = await plate.response({ title: "Caller ETag" });
    expect(response.headers.get("etag")).toBe('"caller"');
  },
  20_000,
);

it("advertises the output content type in metadata", async () => {
  const plate = createNodeOg({
    ...definition,
    imagePath: "og-image.jpg",
    output: { format: "jpeg", encode: () => Uint8Array.of(0xff, 0xd8, 0xff, 0xe0) },
  });

  expect(plate.image("/docs", { title: "Docs" }).type).toBe("image/jpeg");
  expect(plate.metadata("/docs", { title: "Docs" }).openGraph.images[0]?.type).toBe(
    "image/jpeg",
  );
  expect(plate.image("/docs", { title: "Docs" }).url).toBe("/docs/og-image.jpg");
});
