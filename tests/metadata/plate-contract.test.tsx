import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createEdgeOg } from "../../src/edge.js";
import { fontsourceFontLoader } from "../../src/fonts.js";
import { imageDimensions } from "../../src/image.js";
import { definePlate, type PlateContractDefinition } from "../../src/index.js";
import { createNextOg } from "../../src/next.js";
import { createNodeOg } from "../../src/node.js";
import { createSvgOg } from "../../src/render.js";
import { createTakumiOg } from "../../src/takumi.js";
import { entryBuilder } from "../helpers/entry-build.js";

type Copy = { title: string; tag?: string };
type Variant = "square" | "story";

const root = path.join(import.meta.dirname, "../..");
const fonts = () => [];
const component = (copy: Copy) => ({ type: "div", props: { children: copy.title } });
const inter = fontsourceFontLoader([{ font: "inter", weight: 700 }]);

/** Every combination of the options that decide a plate's URLs and metadata. */
function contracts(): PlateContractDefinition<Copy, Variant>[] {
  const sizes = [undefined, { width: 1600, height: 900 }];
  const imagePaths = [undefined, "og-image.png", "cards/social.jpg"];
  const basePaths = [undefined, "/docs"];
  const origins = [undefined, "https://example.com"];
  const versions = [undefined, "copy" as const];
  const revisions = [undefined, "2026-11"];
  const alts = [(copy: Copy) => `${copy.title} card`, (copy: Copy) => `${copy.tag ?? "untagged"}: ${copy.title}`];
  const variantSets = [
    undefined,
    { square: { size: { width: 1080, height: 1080 } } },
    {
      square: { size: { width: 1080, height: 1080 }, imagePath: "square.png" },
      story: { size: { width: 1080, height: 1920 }, alt: (copy: Copy) => `${copy.title} story` },
    },
  ];
  const result: PlateContractDefinition<Copy, Variant>[] = [];
  for (const size of sizes)
    for (const imagePath of imagePaths)
      for (const basePath of basePaths)
        for (const origin of origins)
          for (const version of versions)
            for (const revision of revisions)
              for (const [index, variants] of variantSets.entries()) {
                const definition: PlateContractDefinition<Copy, Variant> = {
                  alt: alts[(index + result.length) % alts.length]!,
                  ...(size === undefined ? {} : { size }),
                  ...(imagePath === undefined ? {} : { imagePath }),
                  ...(basePath === undefined ? {} : { basePath }),
                  ...(origin === undefined ? {} : { origin }),
                  ...(version === undefined ? {} : { version }),
                  ...(revision === undefined ? {} : { revision }),
                  ...(variants === undefined ? {} : { variants: variants as NonNullable<PlateContractDefinition<Copy, Variant>["variants"]> }),
                };
                result.push(definition);
              }
  return result;
}

const media = { videos: [{ url: "https://example.com/clip.mp4", type: "video/mp4", width: 1280, height: 720 }] };
const copies: Copy[] = [{ title: "Launch" }, { title: "Ünïcode & spaces", tag: "news" }];
const routes = ["/", "/blog/launch", "/docs/guide/"];

/** Each renderer, built by spreading the contract in as the guide does. */
const renderers = {
  node: (plate: ReturnType<typeof definePlate<Copy, Variant>>) => createNodeOg({ ...plate, fonts, component }),
  edge: (plate: ReturnType<typeof definePlate<Copy, Variant>>) => createEdgeOg({ ...plate, fonts, component }),
  takumi: (plate: ReturnType<typeof definePlate<Copy, Variant>>) => createTakumiOg({ ...plate, fonts, component }),
  next: (plate: ReturnType<typeof definePlate<Copy, Variant>>) =>
    createNextOg({ ...plate, component: (copy: Copy) => <div>{copy.title}</div> }),
};

describe("definePlate", () => {
  const definitions = contracts();

  it("publishes exactly the metadata, images, and file paths of every renderer built from it", () => {
    expect(definitions).toHaveLength(288);
    for (const definition of definitions) {
      const plate = definePlate(definition);
      const variantNames = Object.keys(definition.variants ?? {}) as Variant[];
      const perCall = [
        undefined,
        { version: "pinned-1" },
        { media },
        ...variantNames.map((variant) => ({ twitter: { variant } })),
      ];
      for (const build of Object.values(renderers)) {
        // A plate built from the raw definition, not the contract, matches too.
        for (const og of [build(plate), build(definition as never)]) {
          expect(og.size).toEqual(plate.size);
          expect(og.contentType).toBe(plate.contentType);
          for (const route of routes) {
            expect(og.sitePath(route)).toBe(plate.sitePath(route));
            for (const copy of copies) {
              expect(og.image(route, copy)).toEqual(plate.image(route, copy));
              for (const options of perCall) {
                expect(og.metadata(route, copy, options)).toEqual(plate.metadata(route, copy, options));
              }
              for (const name of variantNames) {
                const view = plate.variant(name);
                expect(view.variantName).toBe(name);
                expect(og.variant(name).size).toEqual(view.size);
                expect(og.variant(name).sitePath(route)).toBe(view.sitePath(route));
                expect(og.variant(name).image(route, copy)).toEqual(view.image(route, copy));
                expect(og.variant(name).metadata(route, copy, { media })).toEqual(view.metadata(route, copy, { media }));
              }
            }
          }
        }
      }
    }
    // Thousands of comparisons; a loaded CI runner exceeds the 5 s default.
  }, 60_000);

  it("matches an SVG plate when the contract declares the SVG type", () => {
    const definition = definitions[definitions.length - 1]!;
    const plate = definePlate({ ...definition, contentType: "image/svg+xml" });
    const og = createSvgOg({ ...plate, fonts, component });
    expect(og.metadata("/a", copies[1]!, { twitter: { variant: "story" } })).toEqual(
      plate.metadata("/a", copies[1]!, { twitter: { variant: "story" } }),
    );
    expect(og.variant("square").metadata("/a", copies[0]!)).toEqual(plate.variant("square").metadata("/a", copies[0]!));
  });

  it("signs the same URLs as the renderer's plate", async () => {
    const plate = definePlate({ alt: (copy: Copy) => copy.title, version: "copy", variants: { square: { size: { width: 10, height: 10 } } } });
    const og = createNodeOg({ ...plate, fonts, component });
    const secret = "a-signing-secret-of-at-least-thirty-two-bytes";
    expect(await plate.signedMetadata("/post", copies[0]!, { secret })).toEqual(
      await og.signedMetadata("/post", copies[0]!, { secret }),
    );
  });

  it("spreads only its contract options, with the defaulted size and type written out", () => {
    const alt = (copy: Copy) => copy.title;
    const plate = definePlate({ alt, imagePath: "og.png", version: "copy", revision: "r1" });
    expect({ ...plate }).toEqual({
      alt,
      imagePath: "og.png",
      version: "copy",
      revision: "r1",
      size: { width: 1200, height: 630 },
      contentType: "image/png",
    });
    expect(Object.isFrozen(plate)).toBe(true);
    expect(typeof plate.metadata).toBe("function");
    expect(plate.variantName).toBeUndefined();
  });

  it("drops options outside the contract when given a whole renderer definition", () => {
    const definition = { alt: (copy: Copy) => copy.title, fonts, component };
    expect(Object.keys(definePlate(definition))).toEqual(["alt", "size", "contentType"]);
  });

  it("validates at definition like a renderer's plate", () => {
    const alt = (copy: Copy) => copy.title;
    expect(() => definePlate({ alt, version: "hash" as "copy" })).toThrow(/version must be "copy"/);
    expect(() => definePlate({ alt, revision: "" })).toThrow(/Invalid revision/);
    expect(() => definePlate({ alt, size: { width: 0, height: 10 } })).toThrow();
    expect(() => definePlate({ alt, contentType: "png" })).toThrow(/Invalid contentType/);
    // Renderers compare the lowercase essence, so other spellings could never match one.
    expect(() => definePlate({ alt, contentType: "IMAGE/PNG" })).toThrow('lowercase media type with no parameters, such as "image/png"');
    expect(() => definePlate({ alt, contentType: "image/jpeg; q=1" })).toThrow('such as "image/jpeg"; got "image/jpeg; q=1"');
    expect(() => definePlate({} as PlateContractDefinition<Copy>)).toThrow(/alt/);
    expect(() =>
      definePlate({
        alt,
        imagePath: "og.png",
        variants: { square: { size: { width: 10, height: 10 }, imagePath: "og.png" } },
      }),
    ).toThrow(/already used/);
    expect(() => definePlate({ alt }).variant("missing" as never)).toThrow(/Unknown plate variant/);
  });

  it("refuses a renderer that would serve a different type than the contract publishes", () => {
    const png = definePlate({ alt: (copy: Copy) => copy.title });
    expect(() => createSvgOg({ ...png, fonts, component })).toThrow(/contentType is image\/png.*image\/svg\+xml/);
    const jpeg = definePlate({ alt: (copy: Copy) => copy.title, contentType: "image/jpeg" });
    expect(() => createNodeOg({ ...jpeg, fonts, component })).toThrow(/image\/jpeg.*image\/png/);
    expect(() => createEdgeOg({ ...jpeg, fonts, component })).toThrow(/image\/jpeg.*image\/png/);
    expect(() => createTakumiOg({ ...jpeg, fonts, component })).toThrow(/image\/jpeg.*image\/png/);
    expect(() => createNextOg({ ...jpeg, component: () => <div /> })).toThrow(/image\/jpeg.*image\/png/);
    const encode = () => new Uint8Array([0xff, 0xd8, 0xff]);
    expect(createNodeOg({ ...jpeg, fonts, component, output: { format: "jpeg", encode } }).contentType).toBe("image/jpeg");
    expect(createTakumiOg({ ...jpeg, fonts, component, output: { format: "jpeg", encode } }).contentType).toBe("image/jpeg");
  });

  it("renders through a renderer built from the contract", async () => {
    const plate = definePlate({
      alt: (copy: Copy) => copy.title,
      imagePath: "og.png",
      variants: { square: { size: { width: 400, height: 400 } } },
    });
    const og = createNodeOg({
      ...plate,
      fonts: inter,
      component: (copy) => (
        <div style={{ display: "flex", width: "100%", height: "100%", fontFamily: "Inter" }}>{copy.title}</div>
      ),
    });
    const artifact = await og.variant("square").artifact("/post", { title: "Hi" });
    expect(imageDimensions(artifact.bytes)).toMatchObject({ width: 400, height: 400 });
    expect(artifact.metadata.openGraph.images[0]).toEqual(plate.variant("square").image("/post", { title: "Hi" }));
  }, 30_000);
});

const indexBuild = entryBuilder("index");
afterAll(indexBuild.remove);

// Pages on a Worker import the contract from the root entry, so nothing a
// renderer needs may be reachable from it: not Satori, Resvg, React, Next,
// or Takumi, and no Node built-in.
describe("root entry", () => {
  it(
    "bundles definePlate for Cloudflare Workers without any renderer or Node built-in",
    async () => {
      const { build } = await import("esbuild");
      const { entry } = await indexBuild.build();
      const source = readFileSync(entry, "utf8");
      expect(source).not.toMatch(/\bnode:/);
      expect(source).not.toMatch(/\b(?:from|import)\s*\(?\s*["'](?:satori|@resvg|react|next|takumi-js)/);

      const consumer = `
        import { definePlate } from ${JSON.stringify(entry.replaceAll("\\", "/"))};
        const plate = definePlate({ alt: (copy) => copy.title, version: "copy", imagePath: "og.png" });
        export const metadata = plate.metadata("/", { title: "Workers" });
      `;
      const result = await build({
        stdin: { contents: consumer, resolveDir: root, sourcefile: "contract-consumer.js" },
        nodePaths: [path.join(root, "node_modules")],
        bundle: true,
        write: false,
        metafile: true,
        format: "esm",
        platform: "browser",
        conditions: ["workerd", "worker", "browser"],
        logLevel: "silent",
      });
      const inputs = Object.keys(result.metafile.inputs).map((input) => input.replaceAll("\\", "/"));
      expect(inputs.filter((input) => input.includes("node_modules/"))).toEqual([]);
      const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((entry) => entry.path));
      expect(imports).toEqual([]);
    },
    60_000,
  );

  it("reaches no renderer module from source", async () => {
    const { build } = await import("esbuild");
    const result = await build({
      entryPoints: [path.join(root, "src/index.ts")],
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "neutral",
      packages: "external",
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs).map((input) => input.replaceAll("\\", "/"));
    expect(inputs).toContain("src/metadata/plate-contract.ts");
    expect(inputs.filter((input) => input.startsWith("src/render/"))).toEqual([]);
    const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((entry) => entry.path));
    expect(imports).toEqual([]);
  });
});
