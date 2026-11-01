import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { fontsourceFontLoader } from "../src/fonts.js";
import { imageDimensions, verifyImage } from "../src/image.js";
import { socialImageMetadata, variantImagePath } from "../src/index.js";
import { createNextOg } from "../src/next.js";
import { createNodeOg, type RenderedPixels } from "../src/node.js";
import { verifyPng } from "../src/png.js";
import { createSvgOg, type PlateContext } from "../src/render.js";
import { fixture } from "./helpers/image-fixtures.js";

const SQUARE = { width: 1080, height: 1080 };
const STORY = { width: 1080, height: 1920 };
const inter = fontsourceFontLoader([{ font: "inter", weight: 700 }]);

type Copy = { title: string };

/** Lays the title out in a row on wide canvases and a column on tall ones. */
function reflowingCard(copy: Copy, { size }: PlateContext) {
  const portrait = size.height >= size.width;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: portrait ? "column" : "row",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "Inter",
        fontSize: portrait ? 96 : 64,
        background: "#111",
        color: "#fff",
      }}
    >
      <span>Metaplate</span>
      <span>{copy.title}</span>
    </div>
  );
}

const plateDefinition = {
  alt: (copy: Copy) => `${copy.title} card`,
  fonts: inter,
  component: reflowingCard,
  imagePath: "og-image.png",
  variants: {
    square: { size: SQUARE },
    story: { size: STORY, imagePath: "stories/card.png", alt: (copy: Copy) => `${copy.title} story` },
  },
};

/** A real, minimal PNG encoder: unfiltered scanlines, zlib, CRC-32 chunks. */
function encodePng({ pixels, width, height }: RenderedPixels): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...Buffer.from(type, "latin1"), ...data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    out.set(body, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw.set(pixels.subarray(row * width * 4, (row + 1) * width * 4), row * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

describe("variantImagePath", () => {
  it.each([
    ["og-image.png", "og-image-square.png"],
    ["og-image", "og-image-square"],
    ["social/card.jpg", "social/card-square.jpg"],
    ["/v1.2/og-image", "/v1.2/og-image-square"],
    ["og-image.png/", "og-image-square.png"],
    ["card.final.webp", "card.final-square.webp"],
  ])("inserts the variant name into %s", (imagePath, expected) => {
    expect(variantImagePath(imagePath, "square")).toBe(expected);
  });

  it.each(["Square", "1x1", "", "sq_uare", "-square", "square-", "sq--uare"])(
    "rejects the variant name %j",
    (name) => {
      expect(() => variantImagePath("og-image.png", name)).toThrow(/Invalid variant name/);
    },
  );

  it("rejects an image path without a file segment", () => {
    expect(() => variantImagePath("///", "square")).toThrow(/imagePath/);
  });
});

describe("socialImageMetadata variants", () => {
  const options = {
    origin: "https://example.com",
    basePath: "/project",
    imagePath: "og-image.png",
    type: "image/png",
    variants: {
      square: { size: SQUARE },
      story: { size: STORY, imagePath: "story.jpg", alt: "Docs story", type: "image/jpeg" },
    },
  };

  it("emits the default first, then each variant in declaration order", () => {
    const metadata = socialImageMetadata("/docs", "Docs card", options);

    expect(metadata.openGraph.images).toEqual([
      { url: "https://example.com/project/docs/og-image.png", width: 1200, height: 630, alt: "Docs card", type: "image/png" },
      { url: "https://example.com/project/docs/og-image-square.png", width: 1080, height: 1080, alt: "Docs card", type: "image/png" },
      { url: "https://example.com/project/docs/story.jpg", width: 1080, height: 1920, alt: "Docs story", type: "image/jpeg" },
    ]);
    expect(metadata.twitter.images).toEqual([metadata.openGraph.images[0]]);
  });

  it("selects a variant for the X Card image only when asked", () => {
    const metadata = socialImageMetadata("/docs", "Docs card", {
      ...options,
      twitter: { card: "summary", variant: "square" },
    });

    expect(metadata.twitter.card).toBe("summary");
    expect(metadata.twitter.images).toEqual([metadata.openGraph.images[1]]);
    expect(metadata.twitter).not.toHaveProperty("variant");
  });

  it("rejects unknown, conflicting, and colliding variants", () => {
    expect(() =>
      socialImageMetadata("/", "card", { ...options, twitter: { variant: "wide" } }),
    ).toThrow(/Unknown twitter.variant: wide/);
    expect(() =>
      socialImageMetadata("/", "card", {
        ...options,
        twitter: { variant: "square", image: { url: "/x.png", width: 1, height: 1, alt: "x" } },
      }),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      socialImageMetadata("/", "card", {
        imagePath: "og.png",
        variants: { square: { size: SQUARE, imagePath: "/og.png" } },
      }),
    ).toThrow(/already used by another size/);
    expect(() =>
      socialImageMetadata("/", "card", { variants: { Square: { size: SQUARE } } }),
    ).toThrow(/Invalid variant name/);
    expect(() =>
      socialImageMetadata("/", "card", { variants: { square: { size: { width: 0, height: 1 } } } }),
    ).toThrow(/Invalid size/);
  });

  it("lets an explicit Open Graph list replace the generated one", () => {
    const image = { url: "/only.png", width: 600, height: 600, alt: "Only" };
    const metadata = socialImageMetadata("/", "card", { ...options, openGraph: { images: [image] } });
    expect(metadata.openGraph.images).toEqual([image]);
  });
});

describe("plate variants", () => {
  const plate = createSvgOg(plateDefinition);
  const copy = { title: "Docs" };

  it("lists variants and binds views to each size", () => {
    expect(plate.variants).toEqual(["square", "story"]);
    expect(plate.variantName).toBeUndefined();
    expect(plate.size).toEqual({ width: 1200, height: 630 });
    expect(plate.variant("square").size).toEqual(SQUARE);
    expect(plate.variant("square").variantName).toBe("square");
    expect(plate.variant("square").variant("story").size).toEqual(STORY);
    expect(plate.variant("square")).toBe(plate.variant("square"));
    expect(() => plate.variant("wide" as "square")).toThrow(
      /Unknown plate variant: wide \(declared: square, story\)/,
    );
  });

  it("derives and overrides per-variant image paths and alt text", () => {
    const metadata = plate.metadata("/docs", copy);

    expect(metadata.openGraph.images.map(({ url, width, height, alt, type }) => [url, width, height, alt, type])).toEqual([
      ["/docs/og-image.png", 1200, 630, "Docs card", "image/svg+xml"],
      ["/docs/og-image-square.png", 1080, 1080, "Docs card", "image/svg+xml"],
      ["/docs/stories/card.png", 1080, 1920, "Docs story", "image/svg+xml"],
    ]);
    expect(metadata.twitter.images[0]?.url).toBe("/docs/og-image.png");
    expect(plate.metadata("/docs", copy, { twitter: { variant: "story" } }).twitter.images[0]?.url)
      .toBe("/docs/stories/card.png");
  });

  it("describes only its own size from a variant view", () => {
    const square = plate.variant("square");

    expect(square.image("/docs", copy)).toEqual({
      url: "/docs/og-image-square.png",
      width: 1080,
      height: 1080,
      alt: "Docs card",
      type: "image/svg+xml",
    });
    const metadata = square.metadata("/docs", copy);
    expect(metadata.openGraph.images).toEqual([square.image("/docs", copy)]);
    expect(metadata.twitter.images).toEqual([square.image("/docs", copy)]);
    expect(() => square.metadata("/docs", copy, { twitter: { variant: "story" } })).toThrow(
      /describes only its own size/,
    );
  });

  it("rejects invalid variants at plate creation", () => {
    const withVariants = (variants: Record<string, { size: { width: number; height: number }; imagePath?: string }>) =>
      () => createSvgOg({ ...plateDefinition, variants });

    expect(withVariants({ "1x1": { size: SQUARE } })).toThrow(/Invalid variant name/);
    expect(withVariants({ square: { size: { width: 1080, height: 0 } } })).toThrow(/Invalid size: height/);
    expect(withVariants({ square: { size: SQUARE, imagePath: "/og-image.png/" } })).toThrow(
      /already used by another size/,
    );
    expect(withVariants({
      square: { size: SQUARE, imagePath: "card.png" },
      story: { size: STORY, imagePath: "card.png" },
    })).toThrow(/Variant "story" imagePath card.png is already used/);
  });

  it(
    "reflows the component per variant instead of cropping",
    async () => {
      const contexts: PlateContext[] = [];
      const recording = createSvgOg({
        ...plateDefinition,
        component: (card: Copy, context: PlateContext) => {
          contexts.push(context);
          return reflowingCard(card, context);
        },
      });

      const wide = await recording.renderSvg(copy);
      const square = await recording.variant("square").renderSvg(copy);
      const story = await recording.variant("story").renderSvg(copy);

      expect(contexts).toEqual([
        { variant: undefined, size: { width: 1200, height: 630 } },
        { variant: "square", size: SQUARE },
        { variant: "story", size: STORY },
      ]);
      const encode = (svg: string) => new TextEncoder().encode(svg);
      expect(imageDimensions(encode(wide))).toEqual({ width: 1200, height: 630, format: "svg" });
      expect(verifyImage(encode(square), SQUARE, "svg").format).toBe("svg");
      expect(verifyImage(encode(story), STORY, "svg").format).toBe("svg");
      // The square layout is a reflowed column at a larger type size, not the
      // landscape drawing on a resized canvas: its glyph geometry differs.
      const glyphs = (svg: string) => svg.match(/<path[^>]*d="([^"]+)"/g)?.join("");
      expect(glyphs(square)).toBeTruthy();
      expect(glyphs(square)).not.toBe(glyphs(wide));
    },
    20_000,
  );
});

describe("Node variants", () => {
  it(
    "encodes each variant at its own size with the plate's output encoder",
    async () => {
      const encoded: { width: number; height: number }[] = [];
      const plate = createNodeOg({
        ...plateDefinition,
        etag: true,
        output: {
          format: "png",
          encode: (image) => {
            encoded.push({ width: image.width, height: image.height });
            return encodePng(image);
          },
        },
      });
      const copy = { title: "Encoded" };

      for (const view of [plate, plate.variant("square"), plate.variant("story")]) {
        const bytes = await view.render(copy);
        expect(verifyImage(bytes, view.size, "png")).toEqual({ ...view.size, format: "png" });

        const response = await view.handler(copy)();
        expect(response.headers.get("content-type")).toBe("image/png");
        verifyPng(await response.arrayBuffer(), view.size);

        const fetched = await view.fetchable(copy).fetch();
        verifyImage(new Uint8Array(await fetched.arrayBuffer()), view.size, "png");

        const artifact = await view.artifact("/posts/encoded", copy);
        expect(artifact.size).toEqual(view.size);
        expect(artifact.image).toEqual({ ...view.size, format: "png" });
        expect(artifact.metadata.openGraph.images).toEqual([view.image("/posts/encoded", copy)]);
        expect(artifact.etag).toMatch(/^"[0-9a-f]{64}"$/);
      }
      expect(encoded).toEqual([
        ...Array.from({ length: 4 }, () => ({ width: 1200, height: 630 })),
        ...Array.from({ length: 4 }, () => SQUARE),
        ...Array.from({ length: 4 }, () => STORY),
      ]);
    },
    60_000,
  );

  it(
    "renders a variant through the default PNG path and handlerFrom",
    async () => {
      const plate = createNodeOg(plateDefinition);
      const GET = plate.variant("square").handlerFrom(
        (_request: Request, context: { params: { slug: string } }) => ({ title: context.params.slug }),
      );
      const response = await GET(new Request("https://example.com/a/og-image-square.png"), {
        params: { slug: "a" },
      });
      verifyImage(new Uint8Array(await response.arrayBuffer()), SQUARE, "png");
      const pixels = await plate.variant("story").renderPixels({ title: "Tall" });
      expect([pixels.width, pixels.height, pixels.pixels.byteLength]).toEqual([1080, 1920, 1080 * 1920 * 4]);
    },
    20_000,
  );

  it("checks Resvg size preservation against every variant", () => {
    const fitTo = { mode: "width", value: 1200 } as const;
    expect(() => createNodeOg({ ...plateDefinition, variants: {}, resvg: { fitTo } })).not.toThrow();
    expect(() => createNodeOg({ ...plateDefinition, resvg: { fitTo } })).toThrow(
      /resvg.fitTo must preserve the plate's 1080x1080 dimensions/,
    );
  });
});

it(
  "renders a Next variant at its own size",
  async () => {
    const plate = createNextOg<Copy, "square">({
      alt: (copy) => copy.title,
      variants: { square: { size: SQUARE } },
      component: (copy, { variant }) => (
        <div style={{ width: "100%", height: "100%", display: "flex", fontSize: variant ? 96 : 64 }}>
          {copy.title}
        </div>
      ),
    });

    const square = plate.variant("square");
    expect(square.contentType).toBe("image/png");
    verifyPng(await (await square.handler({ title: "Square" })()).arrayBuffer(), SQUARE);
    verifyPng(await (await plate.render({ title: "Wide" })).arrayBuffer(), plate.size);
    expect(plate.metadata("/", { title: "Next" }).openGraph.images.map((image) => image.url)).toEqual([
      "/og-image",
      "/og-image-square",
    ]);
  },
  20_000,
);

// The baseline JSON was produced by metaplate 0.8.0's own source (before size
// variants existed) from the same inputs. String equality pins key order too,
// so a single-size plate's metadata object is byte-for-byte unchanged.
it("keeps single-size metadata byte-for-byte identical to 0.8.0", () => {
  const fonts = () => [{ name: "Inter", data: new ArrayBuffer(1), weight: 700 as const }];
  const component = (copy: Copy) => ({ type: "div", props: { children: copy.title } });
  const alt = (copy: Copy) => `${copy.title} card`;
  const actual = {
    core: socialImageMetadata("/docs", "Docs card", { origin: "https://example.com", basePath: "/project", imagePath: "og-image.jpg", type: "image/jpeg" }),
    coreDefault: socialImageMetadata("/", "card"),
    coreChannels: socialImageMetadata("/docs", "Docs card", {
      imagePath: "og-image.png",
      openGraph: { images: [{ url: "/a.png", width: 1200, height: 630, alt: "A" }, { url: "/b.png", width: 1080, height: 1080, alt: "B" }] },
      twitter: { card: "summary", image: { url: "/x.png", width: 800, height: 800, alt: "X" }, site: "@example", creator: "@author" },
    }),
    svg: createSvgOg({ alt, fonts, component, imagePath: "social/card", basePath: "/p", origin: "https://example.com" }).metadata("/blog/post", { title: "Post" }),
    node: createNodeOg({ alt, fonts, component, size: SQUARE, imagePath: "og-image.png" }).metadata("/", { title: "Home" }),
    nodeImage: createNodeOg({ alt, fonts, component }).image("/x", { title: "X" }),
  };

  const baseline = fixture("single-size-metadata-0.8.0.json").toString("utf8").replace(/\r\n/g, "\n").trimEnd();
  expect(JSON.stringify(actual, null, 2)).toBe(baseline);
});
