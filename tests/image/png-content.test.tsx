import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { parseVerifyInvocation, parseVerifyUrlInvocation } from "../../src/cli/args.js";
import { packageFontLoader } from "../../src/fonts.js";
import { createNodeOg } from "../../src/node.js";
import { pngUniformColor } from "../../src/image/png-content.js";
import { bundleCli } from "../helpers/cli-bundle.js";
import { closeLocalServers, localServer, routes, serveBytes } from "../helpers/http-fixtures.js";
import { fixture, pngChunk, uint32be } from "../helpers/image-fixtures.js";
import { encodePng, type PngSpec } from "../helpers/png-encoder.js";

const RENDER_TIMEOUT = 30_000;

// The CLI runs from a fresh bundle of src/cli/main.ts, built once for this file.
const bundled = bundleCli();

const rgba = (color: number[], odd?: { x: number; y: number; color: number[] }) =>
  (x: number, y: number) => (odd && odd.x === x && odd.y === y ? odd.color : color);

function png(spec: Omit<PngSpec, "pixel"> & { pixel?: PngSpec["pixel"] }): Uint8Array {
  return encodePng({ pixel: () => [0], ...spec });
}

describe("pngUniformColor", () => {
  it.each([0, 1, 2, 3, 4] as const)("decodes 8-bit RGBA through filter %i", (filter) => {
    const uniform = png({ width: 7, height: 5, colorType: 6, depth: 8, filter, pixel: rgba([17, 34, 51, 255]) });
    expect(pngUniformColor(uniform)).toEqual([17, 34, 51, 255]);
    const marked = png({
      width: 7, height: 5, colorType: 6, depth: 8, filter,
      pixel: rgba([17, 34, 51, 255], { x: 6, y: 4, color: [17, 34, 52, 255] }),
    });
    expect(pngUniformColor(marked)).toBeUndefined();
  });

  it("compares 16-bit samples at full precision and reports 8-bit channels", () => {
    expect(pngUniformColor(png({ width: 3, height: 3, colorType: 2, depth: 16, filter: 4, pixel: rgba([0xffff, 0x8080, 0]) })))
      .toEqual([255, 128, 0, 255]);
    expect(
      pngUniformColor(png({
        width: 3, height: 3, colorType: 2, depth: 16,
        pixel: rgba([0xffff, 0x8080, 0], { x: 1, y: 1, color: [0xffff, 0x8081, 0] }),
      })),
    ).toBeUndefined();
  });

  it("reads sub-byte grayscale without the row's padding bits", () => {
    // Nine 1-bit pixels per row leave seven padding bits in the last byte.
    expect(pngUniformColor(png({ width: 9, height: 2, colorType: 0, depth: 1, pixel: () => [1] }))).toEqual([255, 255, 255, 255]);
    expect(
      pngUniformColor(png({ width: 9, height: 2, colorType: 0, depth: 1, pixel: (x, y) => [x === 8 && y === 1 ? 0 : 1] })),
    ).toBeUndefined();
    expect(pngUniformColor(png({ width: 5, height: 1, colorType: 0, depth: 4, filter: 1, pixel: () => [5] }))).toEqual([85, 85, 85, 255]);
  });

  it("maps palette indices to colors, so two entries of one color are uniform", () => {
    const palette = [10, 20, 30, 10, 20, 30, 200, 0, 0];
    expect(
      pngUniformColor(png({ width: 6, height: 2, colorType: 3, depth: 2, palette, pixel: (x) => [x % 2] })),
    ).toEqual([10, 20, 30, 255]);
    expect(
      pngUniformColor(png({ width: 6, height: 2, colorType: 3, depth: 2, palette, pixel: (x) => [x === 5 ? 2 : 0] })),
    ).toBeUndefined();
    // tRNS gives index 1 alpha 0, so it differs from opaque index 0.
    expect(
      pngUniformColor(png({ width: 2, height: 1, colorType: 3, depth: 8, palette, transparency: [255, 0], pixel: (x) => [x] })),
    ).toBeUndefined();
  });

  it("treats fully transparent pixels as one color, including tRNS color keys", () => {
    expect(
      pngUniformColor(png({ width: 2, height: 2, colorType: 6, depth: 8, pixel: (x) => [x * 100, 5, 5, 0] })),
    ).toEqual([0, 0, 0, 0]);
    // Gray-and-alpha pixels with alpha 0 match whatever their gray value.
    expect(
      pngUniformColor(png({ width: 2, height: 1, colorType: 4, depth: 8, pixel: (x) => [x === 0 ? 7 : 9, 0] })),
    ).toEqual([0, 0, 0, 0]);
    expect(
      pngUniformColor(png({ width: 2, height: 1, colorType: 0, depth: 8, transparency: [0, 7], pixel: () => [7] })),
    ).toEqual([0, 0, 0, 0]);
    expect(
      pngUniformColor(png({ width: 2, height: 1, colorType: 0, depth: 8, transparency: [0, 7], pixel: (x) => [x === 0 ? 7 : 8] })),
    ).toBeUndefined();
    expect(
      pngUniformColor(png({
        width: 2, height: 1, colorType: 2, depth: 8, transparency: [0, 1, 0, 2, 0, 3],
        pixel: () => [1, 2, 3],
      })),
    ).toEqual([0, 0, 0, 0]);
  });

  it("decodes every Adam7 pass of an interlaced image", () => {
    const base = { width: 13, height: 9, colorType: 6, depth: 8, interlace: true, filter: 4 } as const;
    expect(pngUniformColor(png({ ...base, pixel: rgba([1, 2, 3, 255]) }))).toEqual([1, 2, 3, 255]);
    // (1, 0) is in pass 6 and (0, 1) in pass 7, the last two passes.
    for (const at of [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 12, y: 8 }]) {
      expect(pngUniformColor(png({ ...base, pixel: rgba([1, 2, 3, 255], { ...at, color: [1, 2, 3, 254] }) }))).toBeUndefined();
    }
    // A 1x1 interlaced image stores its pixel in the first pass only.
    expect(pngUniformColor(png({ ...base, width: 1, height: 1, pixel: rgba([9, 9, 9, 9]) }))).toEqual([9, 9, 9, 9]);
  });

  function withIdat(header: number[], idat: number[], extra: number[] = []): Uint8Array {
    return Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...pngChunk("IHDR", header),
      ...extra,
      ...pngChunk("IDAT", idat),
      ...pngChunk("IEND", []),
    ]);
  }
  const rgbaHeader = (width: number, height: number) => [...uint32be(width), ...uint32be(height), 8, 6, 0, 0, 0];

  it.each([
    { name: "a non-PNG", bytes: Uint8Array.from([1, 2, 3]), message: "not a PNG" },
    { name: "a missing IDAT", bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk("IHDR", rgbaHeader(1, 1)), ...pngChunk("IEND", [])]), message: "no IDAT" },
    { name: "a missing IHDR", bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk("IDAT", [0])]), message: "no IHDR" },
    { name: "an illegal bit depth", bytes: withIdat([...uint32be(1), ...uint32be(1), 4, 6, 0, 0, 0], [...deflateSync(Uint8Array.from([0, 0]))]), message: "unsupported color type 6 at bit depth 4" },
    { name: "an indexed image without PLTE", bytes: withIdat([...uint32be(1), ...uint32be(1), 8, 3, 0, 0, 0], [...deflateSync(Uint8Array.from([0, 0]))]), message: "without a PLTE" },
    { name: "an out-of-range palette index", bytes: withIdat([...uint32be(1), ...uint32be(1), 8, 3, 0, 0, 0], [...deflateSync(Uint8Array.from([0, 5]))], pngChunk("PLTE", [1, 2, 3])), message: "palette index 5" },
    { name: "short image data", bytes: withIdat(rgbaHeader(2, 2), [...deflateSync(Uint8Array.from([0, 1, 2, 3, 4]))]), message: "expected 18" },
    { name: "an unknown filter", bytes: withIdat(rgbaHeader(1, 1), [...deflateSync(Uint8Array.from([9, 1, 2, 3, 4]))]), message: "unknown scanline filter 9" },
    { name: "corrupt deflate data", bytes: withIdat(rgbaHeader(1, 1), [1, 2, 3, 4]), message: "does not inflate" },
    { name: "data that inflates past IHDR's size", bytes: withIdat(rgbaHeader(1, 1), [...deflateSync(new Uint8Array(1_000_000))]), message: "does not inflate to 5 bytes" },
    { name: "a truncated chunk", bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...uint32be(100), 0x49, 0x44, 0x41, 0x54, 1, 2]), message: "runs past the end" },
  ])("refuses $name rather than reporting content", ({ bytes, message }) => {
    expect(() => pngUniformColor(bytes)).toThrow(message);
  });
});

const fonts = packageFontLoader([
  { name: "Inter", package: "@fontsource/inter", file: "files/inter-latin-700-normal.woff", weight: 700 },
]);

/** A plate whose title is drawn, and one that draws it below the canvas. */
function plates() {
  const style = {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-end",
    background: "#111111",
    color: "#ffffff",
    fontFamily: "Inter",
    fontSize: 72,
    padding: 120,
  } as const;
  const plate = (boxSizing: "border-box" | "content-box") =>
    createNodeOg<{ title: string }>({
      alt: (copy) => copy.title,
      fonts,
      component: (copy) => <div style={{ ...style, boxSizing }}><div style={{ display: "flex" }}>{copy.title}</div></div>,
    });
  return { drawn: plate("border-box"), blank: plate("content-box") };
}

describe("--require-content", () => {
  afterEach(closeLocalServers);

  it("is an opt-in switch for verify and verify-url only", () => {
    expect(parseVerifyInvocation(["verify", "--size", "1x1", "a.png"])).not.toHaveProperty("requireContent");
    expect(parseVerifyInvocation(["verify", "--require-content", "--size", "1x1", "a.png"]).requireContent).toBe(true);
    expect(
      parseVerifyUrlInvocation(["verify-url", "--require-content", "--allow-private", "--size", "1x1", "http://127.0.0.1/a.png"]),
    ).toMatchObject({ requireContent: true, fetch: { allowPrivate: true } });
  });

  it(
    "decodes real renders: a drawn card has content and a blank one does not",
    async () => {
      const { drawn, blank } = plates();
      expect(pngUniformColor(await drawn.render({ title: "Here" }))).toBeUndefined();
      expect(pngUniformColor(await blank.render({ title: "Gone" }))).toEqual([17, 17, 17, 255]);
    },
    RENDER_TIMEOUT,
  );

  function run(args: string[]) {
    return bundled.then((bundle) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [bundle, ...args]);
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      }));
  }

  it(
    "fails blank and non-PNG files in metaplate verify, and passes drawn ones",
    async () => {
      const { drawn, blank } = plates();
      const dir = await mkdtemp(path.join(tmpdir(), "metaplate-content-"));
      const files = {
        drawn: path.join(dir, "drawn.png"),
        blank: path.join(dir, "blank.png"),
        jpeg: path.join(dir, "card.jpg"),
      };
      await writeFile(files.drawn, await drawn.render({ title: "Here" }));
      await writeFile(files.blank, await blank.render({ title: "Gone" }));
      await writeFile(files.jpeg, fixture("card.jpg"));

      // Without the flag the blank card passes, which is the gap it closes.
      const unchecked = await run(["verify", "--size", "1200x630", files.blank]);
      expect(unchecked.status).toBe(0);

      const result = await run(["verify", "--json", "--require-content", "--size", "1200x630", files.drawn, files.blank]);
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { files: { valid: boolean; globalIssues: { message: string }[] }[] };
      expect(report.files.map(({ valid }) => valid)).toEqual([true, false]);
      expect(report.files[1]?.globalIssues[0]?.message).toBe("image is blank: every pixel is rgba(17, 17, 17, 1)");

      const jpeg = await run(["verify", "--require-content", "--format", "jpeg", "--size", "1200x630", files.jpeg]);
      expect(jpeg.status).toBe(1);
      expect(jpeg.stderr).toContain("--require-content decodes PNG only; this image is jpeg");
    },
    RENDER_TIMEOUT,
  );

  it(
    "fails a blank card served at a URL in metaplate verify-url",
    async () => {
      const { blank } = plates();
      const bytes = await blank.render({ title: "Gone" });
      const server = await localServer(routes({ "/og.png": serveBytes(bytes, "image/png") }));
      const result = await run([
        "verify-url", "--require-content", "--allow-private", "--allow-port", String(server.port),
        "--size", "1200x630", `${server.origin}/og.png`,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("verification failed: image is blank: every pixel is rgba(17, 17, 17, 1)");
    },
    RENDER_TIMEOUT,
  );
});
