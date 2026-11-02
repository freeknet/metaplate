import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  emojiCodepoints,
  emojiKey,
  emojiLoader,
  twemojiName,
  type EmojiRequest,
} from "../src/emoji.js";
import { fontLoader } from "../src/font-data.js";
import { packageEmojiLoader } from "../src/fonts.js";
import { createNodeOg, type RenderedPixels } from "../src/node.js";
import { createSvgOg, type SatoriOptions } from "../src/render.js";

/** Original single-colour test images, not glyphs from any emoji set. */
const square = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" fill="${fill}"/></svg>`;
const RED = square("#ff0000");
const PNG_BYTES = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);

const decodeDataUri = (uri: string | undefined) =>
  new TextDecoder().decode(Uint8Array.from(atob(uri!.split(",")[1]!), (c) => c.charCodeAt(0)));

describe("grapheme to file name mapping", () => {
  const cases: [label: string, grapheme: string, twemoji: string, key: string][] = [
    ["single code point", "😀", "1f600", "1f600"],
    ["skin tone modifier", "👋🏽", "1f44b-1f3fd", "1f44b-1f3fd"],
    ["flag (regional indicators)", "🇺🇸", "1f1fa-1f1f8", "1f1fa-1f1f8"],
    ["subdivision flag (tag sequence)", "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "1f3f4-e0067-e0062-e0073-e0063-e0074-e007f", "1f3f4-e0067-e0062-e0073-e0063-e0074-e007f"],
    ["keycap: FE0F dropped, no zero padding", "#️⃣", "23-20e3", "23-20e3"],
    ["unqualified keycap", "#⃣", "23-20e3", "23-20e3"],
    ["text-default symbol with FE0F", "❤️", "2764", "2764"],
    ["ZWJ sequence keeps FE0F for Twemoji", "❤️‍🔥", "2764-fe0f-200d-1f525", "2764-200d-1f525"],
    ["ZWJ family", "👨‍👩‍👧", "1f468-200d-1f469-200d-1f467", "1f468-200d-1f469-200d-1f467"],
    ["ZWJ with skin tones", "🧑🏻‍❤️‍🧑🏼", "1f9d1-1f3fb-200d-2764-fe0f-200d-1f9d1-1f3fc", "1f9d1-1f3fb-200d-2764-200d-1f9d1-1f3fc"],
    ["copyright sign", "©️", "a9", "a9"],
  ];

  it.each(cases)("%s", (_label, grapheme, twemoji, key) => {
    expect(twemojiName(grapheme)).toBe(twemoji);
    expect(emojiKey(emojiCodepoints(grapheme))).toBe(key);
  });

  it("gives fully-qualified and unqualified forms the same key", () => {
    expect(emojiKey(emojiCodepoints("👁️‍🗨️"))).toBe(emojiKey(emojiCodepoints("👁‍🗨")));
    expect(emojiCodepoints("👁️‍🗨️")).toEqual([0x1f441, 0xfe0f, 0x200d, 0x1f5e8, 0xfe0f]);
  });
});

describe("emojiLoader", () => {
  it("memoizes each grapheme, including answers with no image", async () => {
    const source = vi.fn((emoji: EmojiRequest) => (emoji.grapheme === "😀" ? RED : undefined));
    const load = emojiLoader(source);

    const [first, second] = await Promise.all([load("😀"), load("😀")]);
    expect(first).toBe(second);
    expect(decodeDataUri(first)).toBe(RED);
    expect(await load("🫨")).toBeUndefined();
    expect(await load("🫨")).toBeUndefined();
    expect(source).toHaveBeenCalledTimes(2);
    expect(source).toHaveBeenCalledWith({ grapheme: "😀", codepoints: [0x1f600] });
  });

  it("never asks the source for graphemes that are not emoji", async () => {
    const source = vi.fn(() => RED);
    const load = emojiLoader(source);
    // Satori classifies whole words, so "hi🎉" can send its letters too.
    expect(await load("h")).toBeUndefined();
    expect(await load("😀".repeat(20))).toBeUndefined();
    expect(source).not.toHaveBeenCalled();
  });

  it("does not memoize a failing source", async () => {
    let calls = 0;
    const load = emojiLoader(() => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return RED;
    });
    await expect(load("😀")).rejects.toThrow("network down");
    expect(decodeDataUri(await load("😀"))).toBe(RED);
    expect(calls).toBe(2);
  });

  it("accepts SVG markup, SVG or PNG bytes, and existing data URIs", async () => {
    const images: Record<string, string | Uint8Array> = {
      "😀": `<?xml version="1.0"?>\n${RED}`,
      "😃": new TextEncoder().encode(RED),
      "😄": PNG_BYTES,
      "😁": "data:image/png;base64,AAAA",
    };
    const load = emojiLoader(({ grapheme }) => images[grapheme]);
    expect(await load("😀")).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(decodeDataUri(await load("😃"))).toBe(RED);
    expect(await load("😄")).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
    expect(await load("😁")).toBe("data:image/png;base64,AAAA");
  });

  it("rejects bytes that are neither SVG nor PNG instead of drawing nothing", async () => {
    const load = emojiLoader(() => "<!doctype html><title>404</title>");
    await expect(load("😀")).rejects.toThrow(/Emoji image for "😀" is not SVG or PNG/);
    await expect(emojiLoader(() => new Uint8Array())("😀")).rejects.toThrow(/0 bytes/);
  });
});

async function emojiPackage(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "metaplate-emoji-"));
  const directory = path.join(root, "node_modules", "@twemoji", "svg");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "@twemoji/svg" }));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(directory, name), contents);
  }
  return { root, directory };
}

describe("packageEmojiLoader", () => {
  it("finds files whatever their case, padding, or FE0F qualification", async () => {
    const { root, directory } = await emojiPackage({
      "1f600.svg": square("#000001"),
      "23-20e3.svg": square("#000002"),
      "1f441-200d-1f5e8.svg": square("#000003"),
      "2764-fe0f-200d-1f525.svg": square("#000004"),
      "README.md": "not an emoji",
    });
    const load = packageEmojiLoader("twemoji", { cwd: root });
    expect(decodeDataUri(await load("😀"))).toContain("#000001");
    expect(decodeDataUri(await load("#️⃣"))).toContain("#000002");
    // Twemoji names this ZWJ sequence without its FE0F selectors.
    expect(decodeDataUri(await load("👁️‍🗨️"))).toContain("#000003");
    expect(decodeDataUri(await load("❤‍🔥"))).toContain("#000004");
    expect(await load("🫨")).toBeUndefined();

    const custom = packageEmojiLoader({ package: "@twemoji/svg" }, { resolvePackage: () => directory });
    expect(decodeDataUri(await custom("😀"))).toContain("#000001");
  });

  it("reads OpenMoji's upper-case, zero-padded names from color/svg", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "metaplate-emoji-"));
    const directory = path.join(root, "color", "svg");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "0023-FE0F-20E3.svg"), square("#000005"));
    await writeFile(path.join(directory, "2764.svg"), square("#000006"));
    const load = packageEmojiLoader("openmoji", { resolvePackage: () => root });
    expect(decodeDataUri(await load("#⃣"))).toContain("#000005");
    expect(decodeDataUri(await load("❤️"))).toContain("#000006");
  });

  it("reads Noto Emoji's emoji_u-prefixed, underscore-joined names", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "metaplate-emoji-"));
    await writeFile(path.join(root, "emoji_u0023_20e3.svg"), square("#000007"));
    await writeFile(path.join(root, "emoji_u1f44b_1f3fd.png"), PNG_BYTES);
    const load = packageEmojiLoader({ package: "noto-emoji-copy" }, { resolvePackage: () => root });
    expect(decodeDataUri(await load("#️⃣"))).toContain("#000007");
    expect(await load("👋🏽")).toMatch(/^data:image\/png;base64,/);
  });

  it("fails the render with the searched paths when the package is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "metaplate-emoji-"));
    const load = packageEmojiLoader("openmoji", { cwd: root });
    await expect(load("😀")).rejects.toThrow(/Cannot find openmoji/);
    // Not memoized: installing the package fixes the next render.
    await expect(load("😀")).rejects.toThrow(/Cannot find openmoji/);
  });
});

const fonts = fontLoader([
  {
    name: "Inter",
    weight: 700,
    data: readFileSync(
      path.join(import.meta.dirname, "..", "node_modules", "@fontsource", "inter", "files", "inter-latin-700-normal.woff"),
    ),
  },
]);

const definition = {
  alt: (copy: { title: string }) => copy.title,
  fonts,
  size: { width: 400, height: 200 },
  component: (copy: { title: string }) => ({
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#ffffff",
        color: "#000000",
        fontFamily: "Inter",
        fontSize: 64,
      },
      children: copy.title,
    },
  }),
};

function redPixels({ pixels }: RenderedPixels): number {
  let count = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset]! > 200 && pixels[offset + 1]! < 50 && pixels[offset + 2]! < 50) count += 1;
  }
  return count;
}

describe("rendering emoji", () => {
  it(
    "draws an emoji image that the font-only render lacks",
    async () => {
      const emoji = emojiLoader(({ grapheme }) => (grapheme === "👋🏽" ? RED : undefined));
      const withEmoji = createNodeOg({ ...definition, emoji });
      const without = createNodeOg(definition);
      const copy = { title: "Hi 👋🏽" };

      const svg = await withEmoji.renderSvg(copy);
      expect(svg).toMatch(/<image [^>]*href="data:image\/svg\+xml;base64,/);
      expect(await without.renderSvg(copy)).not.toContain("<image");

      expect(redPixels(await withEmoji.renderPixels(copy))).toBeGreaterThan(1000);
      expect(redPixels(await without.renderPixels(copy))).toBe(0);
    },
    20_000,
  );

  it("falls back to the plate's fonts for an emoji without an image", async () => {
    const plate = createSvgOg({ ...definition, emoji: emojiLoader(() => undefined) });
    const svg = await plate.renderSvg({ title: "Hi 🫨" });
    expect(svg).not.toContain("<image");
    expect(svg).toBe(await createSvgOg(definition).renderSvg({ title: "Hi 🫨" }));
  });

  it("hands other scripts and image-less emoji to the caller's loadAdditionalAsset", async () => {
    const calls: [string, string][] = [];
    const loadAdditionalAsset: NonNullable<SatoriOptions["loadAdditionalAsset"]> = async (code, segment) => {
      calls.push([code, segment]);
      return code === "emoji" ? `data:image/svg+xml;base64,${btoa(square("#00ff00"))}` : [];
    };
    const plate = createSvgOg({
      ...definition,
      satori: { loadAdditionalAsset },
      emoji: emojiLoader(({ grapheme }) => (grapheme === "😀" ? RED : undefined)),
    });
    const svg = await plate.renderSvg({ title: "😀 🫨 你" });
    expect(svg.match(/<image /g)).toHaveLength(2);
    expect(calls).toContainEqual(["emoji", "🫨"]);
    expect(calls).not.toContainEqual(["emoji", "😀"]);
    expect(calls.some(([code]) => code !== "emoji")).toBe(true);
  });
});
