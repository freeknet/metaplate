import { describe, expect, it } from "vitest";
import { jpegUniformColor } from "../../src/image/jpeg-content.js";
import { completeJpeg, fixture } from "../helpers/image-fixtures.js";

// Pillow (libjpeg 8) output. Each "flat" file is one color; each "dot" file
// is the same image with one pixel changed, placed so the change lands in the
// last block, in a padded edge block, or behind progressive refinement scans.
const jpeg = (name: string) => fixture(`jpeg-content/${name}`);

describe("jpegUniformColor", () => {
  it.each([
    ["flat-baseline-420.jpg", [17, 34, 51, 255]],
    ["flat-progressive-444.jpg", [17, 34, 51, 255]],
    ["flat-gray-restart.jpg", [200, 200, 200, 255]],
    ["flat-cmyk.jpg", [255, 0, 0, 255]],
  ])("reports the one color of %s", (name, color) => {
    const found = jpegUniformColor(jpeg(name));
    expect(found).toBeDefined();
    // The flat sample is computed before a decoder's rounding, so allow one step.
    found!.forEach((channel, index) => expect(Math.abs(channel - color[index]!)).toBeLessThanOrEqual(1));
  });

  it.each([
    "dot-baseline-420.jpg",
    "dot-progressive-444.jpg",
    "dot-gray-restart.jpg",
    "gradient-progressive-420.jpg",
  ])("finds content in %s", (name) => {
    expect(jpegUniformColor(jpeg(name))).toBeUndefined();
  });

  it("reports the shared fixture card.jpg, a 1200x630 flat card, as blank", () => {
    expect(jpegUniformColor(fixture("card.jpg"))).toEqual([17, 17, 17, 255]);
  });

  it("refuses bytes it cannot decode instead of reporting content", () => {
    const flat = jpeg("flat-baseline-420.jpg");
    expect(() => jpegUniformColor(flat.subarray(0, flat.length - 40))).toThrow(/Cannot decode JPEG pixels/);
    // A structurally valid header with no Huffman tables or scan data.
    expect(() => jpegUniformColor(completeJpeg(16, 16))).toThrow(/Cannot decode JPEG pixels/);
    expect(() => jpegUniformColor(fixture("card.png"))).toThrow("Cannot decode JPEG pixels: not a JPEG");
  });

  it("refuses arithmetic-coded frames", () => {
    const arithmetic = Uint8Array.from(jpeg("flat-baseline-420.jpg"));
    const sof = arithmetic.findIndex((byte, index) => byte === 0xff && arithmetic[index + 1] === 0xc0);
    arithmetic[sof + 1] = 0xc9;
    expect(() => jpegUniformColor(arithmetic)).toThrow("arithmetic-coded");
  });
});
