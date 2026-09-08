import { describe, expect, it } from "vitest";
import { socialImageCompatibility } from "../src/compatibility.js";
import { imageDimensions } from "../src/image.js";
import { verifySocialImage } from "../src/social-verification.js";
import { completePng } from "./helpers/image-fixtures.js";

const pngDescriptor = {
  url: "https://example.com/og.png",
  width: 1200,
  height: 630,
  alt: "Project card",
  type: "image/png",
};

describe("verifySocialImage", () => {
  it("accepts bytes and metadata that agree", () => {
    const report = verifySocialImage(completePng(1200, 630), pngDescriptor, {
      targets: ["universal"],
    });
    expect(report.compatible).toBe(true);
    expect(report.actual).toMatchObject({ format: "png", width: 1200, height: 630 });
  });

  it("allows descriptors without optional dimensions or media type", () => {
    const report = verifySocialImage(completePng(1200, 630), {
      url: "https://example.com/og.png",
      alt: "Project card",
    });
    expect(report.compatible).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual(["format"]);
  });

  it("rejects partially specified descriptor dimensions", () => {
    expect(() => verifySocialImage(completePng(1200, 630), {
      url: "https://example.com/og.png",
      alt: "Project card",
      width: 1200,
    })).toThrow("width and height must be provided together");
  });

  it("reports format and dimension disagreement without throwing", () => {
    const report = verifySocialImage(completePng(512, 512), {
      ...pngDescriptor,
      width: 1200,
      height: 630,
      type: "image/jpeg",
    });
    expect(report.compatible).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual(["dimensions", "format"]);
  });

  it("uses actual bytes for platform limits and application limits", () => {
    const bytes = completePng(1200, 630);
    const report = verifySocialImage(bytes, pngDescriptor, {
      targets: ["linkedin"],
      maxFileSize: bytes.byteLength - 1,
    });
    expect(report.actual.byteLength).toBe(bytes.byteLength);
    expect(report.issues.some(({ code }) => code === "file-size")).toBe(true);
  });

  it("does not expose compatibility fileSize as a caller option", () => {
    const options: Parameters<typeof verifySocialImage>[2] = {
      targets: ["universal"],
      // @ts-expect-error fileSize is derived from encoded bytes
      fileSize: 1,
    };
    expect(options).toBeDefined();
  });

  it("reports target-specific aspect-ratio guidance as a warning", () => {
    const report = socialImageCompatibility(
      { ...pngDescriptor, width: 1300, height: 627 },
      { targets: ["linkedin"] },
    );
    expect(report.issues.some(({ code, severity }) => code === "dimensions" && severity === "warning")).toBe(true);
  });
});

describe("GIF structural verification", () => {
  it("walks a minimal GIF89a image", () => {
    const gif = Uint8Array.from([
      ...new TextEncoder().encode("GIF89a"),
      0x10, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00,
      0x2c,
      0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x10, 0x00, 0x00,
      0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
    ]);
    expect(imageDimensions(gif)).toEqual({ width: 16, height: 16, format: "gif" });
  });

  it("walks extensions, a local color table, and a global color table", () => {
    const gif = Uint8Array.from([
      ...new TextEncoder().encode("GIF89a"),
      0x10, 0x00, 0x10, 0x00,
      0x80, 0x00, 0x00, // global color table with 2 entries (6 bytes)
      0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
      0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, // graphic control extension
      0x21, 0xfe, 0x03, 0x61, 0x62, 0x63, 0x00, // comment extension
      0x21, 0xff, 0x0b, ...new TextEncoder().encode("NETSCAPE2.0"), 0x03, 0x01, 0x00, 0x00, 0x00,
      0x2c,
      0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x10, 0x00,
      0x80, // local color table with 2 entries
      0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
      0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
    ]);
    expect(imageDimensions(gif)).toEqual({ width: 16, height: 16, format: "gif" });
  });

  it.each([
    {
      reason: "an image descriptor outside the logical screen",
      bytes: [0x2c, 0x08, 0x00, 0x00, 0x00, 0x10, 0x00, 0x10, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b],
      message: /exceeds the logical screen/,
    },
    {
      reason: "an invalid LZW minimum code size",
      bytes: [0x2c, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x10, 0x00, 0x00, 0x09, 0x02, 0x44, 0x01, 0x00, 0x3b],
      message: /LZW minimum code size/,
    },
    {
      reason: "a trailer before any image",
      bytes: [0x3b],
      message: /no image descriptor/,
    },
    {
      reason: "bytes after the trailer",
      bytes: [0x2c, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x10, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b, 0x00],
      message: /trailing data/,
    },
    {
      reason: "an unknown block introducer",
      bytes: [0x7f],
      message: /unknown block 0x7f/,
    },
    {
      reason: "a malformed graphic control extension",
      bytes: [0x21, 0xf9, 0x03, 0x00, 0x00, 0x00, 0x00],
      message: /graphic control extension/,
    },
    {
      reason: "a missing trailer",
      bytes: [0x2c, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x10, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00],
      message: /missing trailer/,
    },
  ])("rejects $reason", ({ bytes, message }) => {
    const gif = Uint8Array.from([
      ...new TextEncoder().encode("GIF89a"),
      0x10, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00,
      ...bytes,
    ]);
    expect(() => imageDimensions(gif)).toThrow(message);
  });

  it("rejects a zero logical screen and a non-GIF signature length", () => {
    const zero = Uint8Array.from([...new TextEncoder().encode("GIF89a"), 0, 0, 0x10, 0, 0, 0, 0, 0x3b]);
    expect(() => imageDimensions(zero)).toThrow(/nonzero/);
    expect(() => imageDimensions(new TextEncoder().encode("GIF89a"))).toThrow(/too short/);
  });

  it("rejects a truncated GIF image data block", () => {
    const gif = Uint8Array.from([
      ...new TextEncoder().encode("GIF87a"),
      0x10, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00,
      0x2c,
      0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x10, 0x00, 0x00,
      0x02, 0x02, 0x44,
    ]);
    expect(() => imageDimensions(gif)).toThrow(/sub-block|terminator|trailer/);
  });
});
