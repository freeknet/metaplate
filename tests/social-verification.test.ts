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
    } as never);
    expect(report.compatible).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual(["format"]);
  });

  it("rejects partially specified descriptor dimensions", () => {
    expect(() => verifySocialImage(completePng(1200, 630), {
      url: "https://example.com/og.png",
      alt: "Project card",
      width: 1200,
    } as never)).toThrow("width and height must be provided together");
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
