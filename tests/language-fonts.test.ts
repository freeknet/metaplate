import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { emojiLoader } from "../src/emoji.js";
import { fontLoader, languageFontLoader, type LanguageFontFace } from "../src/font-data.js";
import { fontsourceLanguageFontLoader } from "../src/fonts.js";
import { parseUnicodeRange, parseUnicodeRanges, selectSubsets } from "../src/language-fonts.js";
import { createNodeOg, type RenderedPixels } from "../src/node.js";
import { createSvgOg, type SatoriOptions } from "../src/render.js";
import { squareGlyphFont } from "./helpers/test-font.js";

const WOFF = Uint8Array.of(0x77, 0x4f, 0x46, 0x46, 0, 0, 0, 0);
const codepoints = (text: string) => Array.from(text, (character) => character.codePointAt(0)!);

describe("unicode-range parsing", () => {
  it("parses single code points, ranges, and wildcards, then sorts and merges them", () => {
    expect(parseUnicodeRange("x", "U+65E5, U+0041-005A,U+4??,u+0061-007a,U+0059-0060")).toEqual([
      0x41, 0x7a, 0x400, 0x4ff, 0x65e5, 0x65e5,
    ]);
    expect(parseUnicodeRange("x", "U+10FFFF")).toEqual([0x10ffff, 0x10ffff]);
    // A wildcard reaching past the last code point is clamped, as CSS does.
    expect(parseUnicodeRange("x", "U+??????")).toEqual([0, 0x10ffff]);
  });

  it.each(["U+", "U+XYZ", "U+0041-", "0041", "U+0050-0040", "U+4?1", "U+110000", "U+0041-0050-0060", "U+???????"])(
    "rejects %s",
    (value) => {
      expect(() => parseUnicodeRange("latin", value)).toThrow(/Invalid unicode-range for subset "latin"/);
    },
  );

  it("maps Fontsource's bracketed slice keys to their file subset ids", () => {
    const subsets = parseUnicodeRanges({ "[0]": "U+65E5", "[12]": "U+672C", "latin-ext": "U+0100-024F" });
    expect(subsets.map(({ id }) => id)).toEqual(["0", "12", "latin-ext"]);
    expect(() => parseUnicodeRanges({ "../escape": "U+0041" })).toThrow(/Invalid subset id/);
    expect(() => parseUnicodeRanges({ latin: 5 } as never)).toThrow(/must be a string/);
  });
});

describe("subset selection", () => {
  const subsets = parseUnicodeRanges({
    "[0]": "U+65E5,U+672C",
    "[1]": "U+672C,U+8A9E",
    "[2]": "U+306E",
    latin: "U+0000-00FF",
  });

  it("picks only the files that cover the segment, in declaration order", () => {
    const selection = selectSubsets(subsets, codepoints("の日本"));
    expect(selection.subsets.map(({ id }) => id)).toEqual(["0", "2"]);
    expect([...selection.covered].sort()).toEqual(codepoints("の日本").sort());
  });

  it("reuses an already picked file before adding another", () => {
    // 本 is in both [0] and [1]; [0] is already needed for 日.
    expect(selectSubsets(subsets, codepoints("日本")).subsets.map(({ id }) => id)).toEqual(["0"]);
    expect(selectSubsets(subsets, codepoints("語本")).subsets.map(({ id }) => id)).toEqual(["1"]);
  });

  it("leaves out code points no file covers", () => {
    const selection = selectSubsets(subsets, codepoints("한日"));
    expect(selection.subsets.map(({ id }) => id)).toEqual(["0"]);
    expect([...selection.covered]).toEqual(codepoints("日"));
  });
});

describe("languageFontLoader", () => {
  it("rejects language codes Satori never requests at definition time", () => {
    expect(() => languageFontLoader({ ja: { name: "JP", data: () => WOFF } } as never)).toThrow(
      /"ja" is not a language code Satori requests fonts for/,
    );
    expect(() => languageFontLoader({ "ja-JP": { name: "", data: () => WOFF } })).toThrow(/needs a name/);
  });

  it("answers unconfigured languages with no fonts and loads nothing", async () => {
    const data = vi.fn(() => WOFF);
    const load = languageFontLoader({ "ko-KR": { name: "KR", data } });
    expect(await load("th-TH", "สวัสดี")).toEqual([]);
    expect(await load("emoji", "😀")).toEqual([]);
    expect(await load("not-a-code", "x")).toEqual([]);
    expect(await load("ko-KR", "")).toEqual([]);
    expect(data).not.toHaveBeenCalled();
  });

  it("loads a whole face once, tagged with Satori's language, and reuses it", async () => {
    const data = vi.fn(() => WOFF);
    const load = languageFontLoader({ "he-IL": { name: "Noto Sans Hebrew", weight: 700, data } });
    const [first] = await load("he-IL", "שלום");
    expect(first).toMatchObject({ name: "Noto Sans Hebrew he-IL", weight: 700, style: "normal", lang: "he-IL" });
    expect((await load("he-IL", "עולם"))[0]).toBe(first);
    expect(data).toHaveBeenCalledTimes(1);
    expect(data).toHaveBeenCalledWith(undefined);
  });

  it("reads only the subset files a segment needs, each once", async () => {
    const data = vi.fn<(subset: string | undefined) => Uint8Array>(() => WOFF);
    const load = languageFontLoader({
      "ja-JP": { name: "Noto Sans JP", unicodeRanges: { "[0]": "U+65E5", "[1]": "U+672C", "[2]": "U+8A9E" }, data },
    });
    const fonts = await load("ja-JP|zh-CN|zh-TW|zh-HK", "日本");
    expect(fonts.map(({ name }) => name)).toEqual(["Noto Sans JP ja-JP 0", "Noto Sans JP ja-JP 1"]);
    await load("ja-JP", "本");
    expect(data.mock.calls.map(([subset]) => subset)).toEqual(["0", "1"]);
  });

  it("walks Satori's candidate languages in order until every character is covered", async () => {
    const japanese = vi.fn(() => WOFF);
    const chinese = vi.fn(() => WOFF);
    const load = languageFontLoader({
      "zh-CN": { name: "SC", unicodeRanges: { "[0]": "U+65E5,U+8BED" }, data: chinese },
      "ja-JP": { name: "JP", unicodeRanges: { "[0]": "U+65E5" }, data: japanese },
    });
    // 日 is covered by Japanese, Satori's first candidate; 语 only by Chinese.
    expect((await load("ja-JP|zh-CN|zh-TW|zh-HK", "日语")).map(({ lang }) => lang)).toEqual(["ja-JP", "zh-CN"]);
    // An element with lang="zh-CN" puts Chinese first, and it covers both.
    expect((await load("zh-CN|ja-JP|zh-TW|zh-HK", "日语")).map(({ lang }) => lang)).toEqual(["zh-CN"]);
    expect((await load("ja-JP|zh-CN|zh-TW|zh-HK", "日")).map(({ lang }) => lang)).toEqual(["ja-JP"]);
    expect(japanese).toHaveBeenCalledTimes(1);
    expect(chinese).toHaveBeenCalledTimes(1);
  });

  it("leaves the language tag off for Satori's unknown script, which it would reject", async () => {
    const [font] = await languageFontLoader({ unknown: { name: "Noto Sans", data: () => WOFF } })("unknown", "Ж");
    expect(font).not.toHaveProperty("lang");
    const [symbol] = await languageFontLoader({ symbol: { name: "Symbols", data: () => WOFF } })("symbol", "☖");
    expect(symbol?.lang).toBe("symbol");
  });

  it("loads one face per weight under a shared name so Satori picks the closest", async () => {
    const face = (weight: 400 | 700): LanguageFontFace => ({
      name: "Noto Sans Arabic",
      weight,
      unicodeRanges: { arabic: "U+0600-06FF" },
      data: () => WOFF,
    });
    const fonts = await languageFontLoader({ "ar-AR": [face(400), face(700)] })("ar-AR", "مرحبا");
    expect(fonts.map(({ name, weight }) => [name, weight])).toEqual([
      ["Noto Sans Arabic ar-AR arabic", 400],
      ["Noto Sans Arabic ar-AR arabic", 700],
    ]);
  });

  it("does not memoize a failed or non-font load, so the next render retries", async () => {
    let attempt = 0;
    const load = languageFontLoader({
      "th-TH": {
        name: "Noto Sans Thai",
        data: () => {
          attempt += 1;
          if (attempt === 1) throw new Error("network down");
          return attempt === 2 ? new TextEncoder().encode("<!doctype html>") : WOFF;
        },
      },
    });
    await expect(load("th-TH", "ไทย")).rejects.toThrow("network down");
    await expect(load("th-TH", "ไทย")).rejects.toThrow(/is not a TrueType, OpenType, WOFF, or WOFF2 file/);
    await expect(load("th-TH", "ไทย")).resolves.toHaveLength(1);
    expect(attempt).toBe(3);
  });
});

type FakeFontsource = {
  /** Subset id (file name part) to the characters its font draws. */
  files: Record<string, string>;
  /** unicode.json contents; defaults to one bracketed key per numbered file. */
  unicode?: Record<string, string>;
  weights?: number[];
};

/**
 * A Fontsource-shaped package of square-glyph fonts in a temporary
 * `node_modules`, so tests exercise real package resolution without
 * installing a multi-megabyte CJK family. The files hold TrueType bytes under
 * Fontsource's `.woff` names; the loader and Satori identify fonts by their
 * leading bytes, not the extension.
 */
async function fakeFontsource(root: string, id: string, family: string, fake: FakeFontsource) {
  const directory = path.join(root, "node_modules", "@fontsource", id);
  await mkdir(path.join(directory, "files"), { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: `@fontsource/${id}`, version: "5.0.0" }));
  const weights = fake.weights ?? [400, 700];
  await writeFile(
    path.join(directory, "metadata.json"),
    JSON.stringify({ id, family, subsets: ["latin"], weights, styles: ["normal"], defSubset: "latin" }),
  );
  const unicode =
    fake.unicode ??
    Object.fromEntries(
      Object.entries(fake.files).map(([subset, characters]) => [
        /^\d+$/.test(subset) ? `[${subset}]` : subset,
        codepoints(characters).map((codepoint) => `U+${codepoint.toString(16)}`).join(","),
      ]),
    );
  await writeFile(path.join(directory, "unicode.json"), JSON.stringify(unicode));
  for (const [subset, characters] of Object.entries(fake.files)) {
    for (const weight of weights) {
      await writeFile(
        path.join(directory, "files", `${id}-${subset}-${weight}-normal.woff`),
        squareGlyphFont(`${family} ${subset}`, characters),
      );
    }
  }
  return directory;
}

const tempRoot = () => mkdtemp(path.join(tmpdir(), "metaplate-language-"));

describe("fontsourceLanguageFontLoader", () => {
  it("reads only the subset files covering the segment from the installed package", async () => {
    const root = await tempRoot();
    await fakeFontsource(root, "noto-sans-jp", "Noto Sans JP", {
      files: { "0": "日", "1": "本の" },
      // [2] has no files on disk: reading it would fail the test.
      unicode: { "[0]": "U+65E5", "[1]": "U+672C,U+306E", "[2]": "U+8A9E" },
    });
    const load = fontsourceLanguageFontLoader({ "ja-JP": { font: "noto-sans-jp", weight: [400, 700] } }, { cwd: root });

    const fonts = await load("ja-JP|zh-CN|zh-TW|zh-HK", "日本");
    expect(fonts.map(({ name, weight, lang }) => [name, weight, lang])).toEqual([
      ["Noto Sans JP ja-JP 0", 400, "ja-JP"],
      ["Noto Sans JP ja-JP 1", 400, "ja-JP"],
      ["Noto Sans JP ja-JP 0", 700, "ja-JP"],
      ["Noto Sans JP ja-JP 1", 700, "ja-JP"],
    ]);
    // Memoized: the same bytes come back, so Satori reuses its parsed font.
    expect((await load("ja-JP", "の"))[0]).toBe(fonts[1]);
  });

  it("accepts a bare Fontsource id and a resolvePackage hook", async () => {
    const root = await tempRoot();
    const directory = await fakeFontsource(root, "noto-sans-kr", "Noto Sans KR", { files: { "0": "한국" } });
    const resolvePackage = vi.fn(() => directory);
    const fonts = await fontsourceLanguageFontLoader({ "ko-KR": "noto-sans-kr" }, { resolvePackage })("ko-KR", "한국");
    expect(fonts).toMatchObject([{ name: "Noto Sans KR ko-KR 0", weight: 400, lang: "ko-KR" }]);
    expect(resolvePackage).toHaveBeenCalledWith("@fontsource/noto-sans-kr");
  });

  it("validates ids and language codes at definition time", () => {
    expect(() => fontsourceLanguageFontLoader({ "ja-JP": "../noto" })).toThrow(/Invalid font package name/);
    expect(() => fontsourceLanguageFontLoader({ "ja-JP": "@other/noto-sans-jp" })).toThrow(/@fontsource scope/);
    expect(() => fontsourceLanguageFontLoader({ jp: "noto-sans-jp" } as never)).toThrow(/not a language code/);
  });

  it("fails the render while the package is missing, then recovers once it is installed", async () => {
    const root = await tempRoot();
    const load = fontsourceLanguageFontLoader({ "ja-JP": "noto-sans-jp" }, { cwd: root });
    await expect(load("ja-JP", "日")).rejects.toThrow(/Cannot find @fontsource\/noto-sans-jp/);
    await fakeFontsource(root, "noto-sans-jp", "Noto Sans JP", { files: { "0": "日" } });
    await expect(load("ja-JP", "日")).resolves.toHaveLength(1);
  });

  it("explains a missing weight or a package without unicode.json", async () => {
    const root = await tempRoot();
    const directory = await fakeFontsource(root, "noto-sans-thai", "Noto Sans Thai", {
      files: { thai: "ไทย" },
      weights: [400],
    });
    await expect(
      fontsourceLanguageFontLoader({ "th-TH": { font: "noto-sans-thai", weight: 900 } }, { cwd: root })("th-TH", "ไ"),
    ).rejects.toThrow("@fontsource/noto-sans-thai has no 900 normal face. Available weights: 400; styles: normal.");

    await rm(path.join(directory, "unicode.json"));
    await expect(
      fontsourceLanguageFontLoader({ "th-TH": "noto-sans-thai" }, { cwd: root })("th-TH", "ไ"),
    ).rejects.toThrow(/@fontsource\/noto-sans-thai has no readable unicode\.json/);
  });
});

const INTER = readFileSync(
  path.join(import.meta.dirname, "..", "node_modules", "@fontsource", "inter", "files", "inter-latin-700-normal.woff"),
);

/**
 * Satori caches its font list per set of plate font buffers and keeps the
 * fallback fonts `loadAdditionalAsset` added to it, so each plate gets its
 * own copy of Inter's bytes (`fontLoader` copies them) to keep renders in
 * these tests independent.
 */
const plate = () => ({
  alt: ({ title }: { title: string }) => title,
  fonts: fontLoader([{ name: "Inter", weight: 700, data: INTER }]),
  size: { width: 400, height: 120 },
  component: ({ title }: { title: string }) => ({
    type: "div",
    props: {
      style: { display: "flex", width: "100%", height: "100%", background: "#fff", color: "#f00", fontFamily: "Inter", fontSize: 64 },
      children: title,
    },
  }),
});

function countRed({ pixels }: RenderedPixels): number {
  let red = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset]! > 200 && pixels[offset + 1]! < 60 && pixels[offset + 2]! < 60) red += 1;
  }
  return red;
}

/** A square glyph at 64px: 0.9 em on each side. */
const GLYPH_SIDE = 0.9 * 64;
const GLYPH_AREA = GLYPH_SIDE ** 2;

/** Counts `M right bottom L left bottom L left top` outlines of a glyph-sized square. */
function squarePaths(svg: string): number {
  return [...svg.matchAll(/M([\d.]+) ([\d.]+)L([\d.]+) \2L\3 ([\d.]+)/g)].filter(
    ([, right, bottom, left, top]) =>
      Math.abs(Number(right) - Number(left) - GLYPH_SIDE) < 0.01 &&
      Math.abs(Number(bottom) - Number(top) - GLYPH_SIDE) < 0.01,
  ).length;
}

describe("rendering other scripts", () => {
  it(
    "draws a Japanese segment with the installed language font that the plate's font lacks",
    async () => {
      const root = await tempRoot();
      await fakeFontsource(root, "noto-sans-jp", "Noto Sans JP", {
        files: { "0": "日", "1": "本の", "2": "語" },
      });
      const copy = { title: "日本の" };
      const withFonts = createNodeOg({
        ...plate(),
        languageFonts: fontsourceLanguageFontLoader({ "ja-JP": { font: "noto-sans-jp", weight: 700 } }, { cwd: root }),
      });
      const without = createNodeOg(plate());

      // Glyph-path evidence: each character is drawn as the fixture's square.
      const svg = await withFonts.renderSvg(copy);
      expect(squarePaths(svg)).toBe(3);
      expect(squarePaths(await without.renderSvg(copy))).toBe(0);

      // Pixel evidence: three solid squares of red, about three times what
      // Inter's outlined missing-glyph boxes cover.
      const drawn = countRed(await withFonts.renderPixels(copy));
      const missing = countRed(await without.renderPixels(copy));
      expect(drawn).toBeGreaterThan(3 * GLYPH_AREA * 0.95);
      expect(missing).toBeLessThan(drawn / 2);
    },
    30_000,
  );

  it(
    "offers emoji, then language fonts, then the caller's loader, and stops at the first that resolves",
    async () => {
      const calls: [string, string][] = [];
      const loadAdditionalAsset: NonNullable<SatoriOptions["loadAdditionalAsset"]> = async (code, segment) => {
        calls.push([code, segment]);
        return [];
      };
      const japanese = vi.fn<(subset: string | undefined) => Uint8Array>(() => squareGlyphFont("JP", "日本"));
      const svgPlate = createSvgOg({
        ...plate(),
        satori: { loadAdditionalAsset },
        emoji: emojiLoader(({ grapheme }) => (grapheme === "😀" ? '<svg xmlns="http://www.w3.org/2000/svg"/>' : undefined)),
        languageFonts: languageFontLoader({
          "ja-JP": { name: "JP", unicodeRanges: { "[0]": "U+65E5,U+672C" }, data: japanese },
        }),
      });
      const svg = await svgPlate.renderSvg({ title: "😀🫨 日本 한" });
      expect(svg.match(/<image /g)).toHaveLength(1);
      expect(japanese).toHaveBeenCalledTimes(1);
      // Resolved requests never reach the caller; unresolved ones all do.
      expect(calls).toContainEqual(["emoji", "🫨"]);
      expect(calls).toContainEqual(["ko-KR", "한"]);
      expect(calls.some(([code]) => code.startsWith("ja-JP"))).toBe(false);
      expect(calls).not.toContainEqual(["emoji", "😀"]);
    },
    30_000,
  );
});
