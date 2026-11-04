import { describe, expect, it } from "vitest";
import { compareImages, decodeImagePixels, JPEG_COMPARE_THRESHOLD } from "../../src/node.js";
import { decodeJpegPixels } from "../../src/image/jpeg-content.js";
import { decodePngPixels } from "../../src/image/png-content.js";
import { fixture } from "../helpers/image-fixtures.js";
import { encodePng } from "../helpers/png-encoder.js";

// Pillow output: card.png is a 240x126 gradient card with a box and text;
// card-changed.png adds a 21x21 green square; the JPEGs encode card.png, and
// each *.libjpeg.png is libjpeg's own decode of the JPEG beside it.
const card = (name: string) => fixture(`compare/${name}`);

describe("decodeJpegPixels", () => {
  it.each(["card-420", "card-progressive-422"])("decodes %s within a few levels of libjpeg", (name) => {
    const comparison = compareImages(card(`${name}.libjpeg.png`), card(`${name}.jpg`), { threshold: 0 });
    expect(comparison.sameSize).toBe(true);
    expect(comparison.maxDifference).toBeLessThanOrEqual(6);
    expect(comparison.meanDifference).toBeLessThan(1 / 255);
  });

  it("decodes a flat JPEG to its one color everywhere", () => {
    const { width, height, data } = decodeJpegPixels(fixture("jpeg-content/flat-baseline-420.jpg"));
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      expect(Math.abs(data[pixel * 4]! - 17)).toBeLessThanOrEqual(1);
      expect(data[pixel * 4 + 3]).toBe(255);
    }
  });

  it("refuses an image larger than the pixel limit", () => {
    expect(() => decodeJpegPixels(card("card-420.jpg"), 100)).toThrow("240x126 is more than 100 pixels");
  });
});

describe("decodePngPixels", () => {
  const spec = {
    width: 13,
    height: 9,
    colorType: 6 as const,
    depth: 16 as const,
    pixel: (x: number, y: number) => [x * 5000, y * 7000, (x * y * 300) % 65_536, 65_535 - x * 100],
  };

  it("places Adam7 passes where a sequential decode puts them, scaled to 8 bits", () => {
    const sequential = decodePngPixels(encodePng(spec));
    const interlaced = decodePngPixels(encodePng({ ...spec, interlace: true }));
    expect(interlaced).toEqual(sequential);
    const at = (3 * 13 + 4) * 4;
    expect([...sequential.data.subarray(at, at + 4)]).toEqual(
      spec.pixel(4, 3).map((value) => Math.round((value * 255) / 65_535)),
    );
  });

  it("refuses an image larger than the pixel limit", () => {
    expect(() => decodePngPixels(card("card.png"), 100)).toThrow("is more than 100 pixels");
  });
});

describe("compareImages", () => {
  it("finds no change between an image and itself", () => {
    const comparison = compareImages(card("card.png"), card("card.png"));
    expect(comparison).toMatchObject({ sameSize: true, threshold: 0, changedPixels: 0, changedRatio: 0, maxDifference: 0 });
    expect(comparison.totalPixels).toBe(240 * 126);
    expect(comparison.diffImage).toBeUndefined();
  });

  it("counts the changed pixels and draws them in the diff image", () => {
    const comparison = compareImages(card("card.png"), card("card-changed.png"), { diffImage: true });
    expect(comparison.changedPixels).toBe(21 * 21);
    expect(comparison.changedRatio).toBeCloseTo((21 * 21) / (240 * 126));
    const diff = decodePngPixels(comparison.diffImage!);
    expect(diff.width).toBe(240 * 3 + 16);
    expect(diff.height).toBe(126);
    const pixel = (x: number, y: number) => [...diff.data.subarray((y * diff.width + x) * 4, (y * diff.width + x) * 4 + 3)];
    const highlight = (240 + 8) * 2;
    expect(pixel(highlight + 160, 100)).toEqual([230, 0, 60]);
    // Unchanged pixels are a faded gray, never the highlight color.
    const [r, g, b] = pixel(highlight + 5, 5);
    expect(r).toBe(g);
    expect(g).toBe(b);
    // The left two panels are the baseline and the current image.
    expect(pixel(160, 100)).not.toEqual(pixel(240 + 8 + 160, 100));
  });

  it("tolerates JPEG re-encoding by default, and reports it with a threshold of 0", () => {
    const reencoded = compareImages(card("card-420.jpg"), card("card-reencoded-420.jpg"));
    expect(reencoded.threshold).toBe(JPEG_COMPARE_THRESHOLD);
    // Saw-tooth stripes and text are the worst case for re-encoding noise.
    expect(reencoded.changedRatio).toBeLessThan(0.01);
    expect(compareImages(card("card-420.jpg"), card("card-reencoded-420.jpg"), { threshold: 0 }).changedPixels).toBeGreaterThan(0);
    // A PNG baseline against its JPEG encoding uses the JPEG tolerance too.
    expect(compareImages(card("card.png"), card("card-420.jpg")).threshold).toBe(JPEG_COMPARE_THRESHOLD);
  });

  it("treats fully transparent pixels as equal whatever their color", () => {
    const transparent = (red: number) =>
      encodePng({ width: 2, height: 2, colorType: 6, depth: 8, pixel: () => [red, 0, 0, 0] });
    expect(compareImages(transparent(0), transparent(255)).changedPixels).toBe(0);
  });

  it("counts every pixel as changed when the sizes differ", () => {
    const small = encodePng({ width: 10, height: 10, colorType: 2, depth: 8, pixel: () => [1, 2, 3] });
    const comparison = compareImages(card("card.png"), small, { diffImage: true });
    expect(comparison).toMatchObject({
      sameSize: false,
      baseline: { width: 240, height: 126 },
      current: { width: 10, height: 10 },
      changedRatio: 1,
      changedPixels: 240 * 126,
    });
    expect(comparison.diffImage).toBeUndefined();
  });

  it("refuses formats it cannot decode and thresholds out of range", () => {
    expect(() => compareImages(fixture("card-lossy.webp"), card("card.png"))).toThrow("Cannot compare webp images");
    expect(() => decodeImagePixels(new Uint8Array([1, 2, 3]))).toThrow("Cannot compare unrecognized images");
    expect(() => compareImages(card("card.png"), card("card.png"), { threshold: 256 })).toThrow(RangeError);
  });
});
