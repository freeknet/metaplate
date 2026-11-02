import { describe, expect, it } from "vitest";
import { socialImageCompatibility, type SocialImageDescriptor } from "../../src/index.js";

const png: SocialImageDescriptor = {
  url: "https://example.com/card.png",
  width: 1200,
  height: 630,
  alt: "Card",
  type: "image/png",
};

describe("socialImageCompatibility", () => {
  it("accepts a crawler-ready universal raster image", () => {
    expect(socialImageCompatibility(png)).toEqual({ compatible: true, issues: [] });
  });

  it("rejects relative SVG delivery for universal targets", () => {
    const report = socialImageCompatibility({
      ...png,
      url: "/card.svg",
      type: "image/svg+xml",
    });

    expect(report.compatible).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual(["url", "format"]);
  });

  it("keeps the universal profile to PNG and JPEG", () => {
    const report = socialImageCompatibility({ ...png, type: "image/gif" });
    expect(report.compatible).toBe(false);
    expect(report.issues[0]?.code).toBe("format");
  });

  it("requires a declared media type for universal compatibility", () => {
    const withoutType = { ...png };
    delete withoutType.type;
    const report = socialImageCompatibility(withoutType);
    expect(report.compatible).toBe(false);
    expect(report.issues[0]?.severity).toBe("error");
  });

  it("rejects credentials and missing alt text in crawler metadata", () => {
    const report = socialImageCompatibility({
      ...png,
      url: "https://user:secret@example.com/card.png",
      alt: "",
    });
    expect(report.compatible).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual(["url", "contract"]);
  });

  it("applies LinkedIn dimensions and file-size limits", () => {
    const report = socialImageCompatibility(
      { ...png, width: 400, height: 400 },
      { targets: ["linkedin"], fileSize: 5_000_001 },
    );

    expect(report.compatible).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual(["dimensions", "file-size"]);
  });

  it("labels undocumented platform behavior as unknown rather than supported", () => {
    for (const target of ["instagram", "telegram", "threads", "pinterest"] as const) {
      const report = socialImageCompatibility(
        { ...png, url: "/card.svg", type: "image/svg+xml", width: 1, height: 1 },
        { targets: [target], fileSize: 100_000_000 },
      );

      expect(report.compatible).toBe(true);
      expect(report.issues).toEqual([
        expect.objectContaining({ target, severity: "unknown", code: "contract" }),
      ]);
    }
  });

  it("applies WhatsApp's documented large-preview image requirements", () => {
    // https://developers.facebook.com/documentation/business-messaging/whatsapp/link-previews/
    const whatsapp = (image: Partial<SocialImageDescriptor>, fileSize = 599_999) =>
      socialImageCompatibility({ ...png, ...image }, { targets: ["whatsapp"], fileSize });

    // At every limit; WhatsApp publishes no format or HTTPS rule, so SVG over HTTP passes.
    expect(whatsapp({ width: 300, height: 75 })).toEqual({ compatible: true, issues: [] });
    expect(whatsapp({ url: "http://example.com/card.svg", type: "image/svg+xml" }).issues).toEqual([]);

    const rejected = [
      [whatsapp({ url: "/card.png" }), "url", /absolute URL/],
      [whatsapp({ width: 299, height: 200 }), "dimensions", /300px wide/],
      [whatsapp({ width: 1201, height: 300 }), "dimensions", /4:1.*Received 1201x300/],
      [whatsapp({}, 600_000), "file-size", /under 600KB/],
    ] as const;
    for (const [report, code, message] of rejected) {
      expect(report.compatible).toBe(false);
      expect(report.issues).toEqual([
        expect.objectContaining({ target: "whatsapp", severity: "error", code, message: expect.stringMatching(message) }),
      ]);
    }
  });

  it("applies X's documented Card image requirements", () => {
    // Archived Summary and Summary with Large Image Card references.
    const x = (image: Partial<SocialImageDescriptor>, fileSize = 4_999_999) =>
      socialImageCompatibility({ ...png, ...image }, { targets: ["x"], fileSize });

    // At every limit, in each supported format.
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(x({ type })).toEqual({ compatible: true, issues: [] });
    }
    expect(x({ width: 4096, height: 4096, alt: "a".repeat(420) })).toEqual({ compatible: true, issues: [] });
    // 144x144 suits a summary card, so it is only a warning for the large card.
    expect(x({ width: 144, height: 144 })).toEqual({
      compatible: true,
      issues: [expect.objectContaining({ severity: "warning", code: "dimensions", message: expect.stringMatching(/300x157/) })],
    });
    expect(x({ type: undefined }).issues).toEqual([
      expect.objectContaining({ severity: "warning", code: "format" }),
    ]);

    const rejected = [
      [x({ url: "https://example.com/card.svg", type: "image/svg+xml" }), "format", /not SVG/],
      [x({ width: 143, height: 200 }), "dimensions", /at least 144x144/],
      [x({ width: 4097, height: 2000 }), "dimensions", /at most 4096x4096.*Received 4097x2000/],
      [x({}, 5_000_000), "file-size", /less than 5MB/],
      // Alt text is counted in characters, not UTF-16 code units.
      [x({ alt: "😀".repeat(421) }), "contract", /420 characters\. Received 421/],
    ] as const;
    for (const [report, code, message] of rejected) {
      expect(report.compatible).toBe(false);
      expect(report.issues).toEqual([
        expect.objectContaining({ target: "x", severity: "error", code, message: expect.stringMatching(message) }),
      ]);
    }
    expect(x({ alt: "😀".repeat(420) }).compatible).toBe(true);
  });

  it("warns when an image exceeds Bluesky's card thumbnail blob limit", () => {
    // https://bsky.network/docs/about-bluesky-content/posts#website-card-embeds
    const bluesky = (fileSize: number) =>
      socialImageCompatibility(
        { ...png, url: "/card.svg", type: "image/svg+xml" },
        { targets: ["bluesky"], fileSize },
      );

    // No URL, format, or dimension rule is published beyond the 1,000,000-byte blob.
    expect(bluesky(1_000_000)).toEqual({ compatible: true, issues: [] });

    const oversized = bluesky(1_000_001);
    expect(oversized.compatible).toBe(true);
    expect(oversized.issues).toEqual([
      expect.objectContaining({ target: "bluesky", severity: "warning", code: "file-size" }),
    ]);
  });

  it("checks Discord's documented link-preview formats", () => {
    // https://docs.discord.com/developers/link-previews/overview
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]) {
      const report = socialImageCompatibility({ ...png, type }, { targets: ["discord"] });
      expect(report.compatible).toBe(true);
      expect(report.issues).toEqual([]);
    }

    const svg = socialImageCompatibility({ ...png, type: "image/svg+xml" }, { targets: ["discord"] });
    expect(svg.compatible).toBe(false);
    expect(svg.issues[0]).toMatchObject({ target: "discord", code: "format" });

    // Discord accepts root-relative image URLs, so it does not demand crawler-ready ones.
    const relative = socialImageCompatibility({ ...png, url: "/card.png" }, { targets: ["discord"] });
    expect(relative.compatible).toBe(true);
  });

  it("can opt generic Open Graph checks into crawler-ready URLs", () => {
    const report = socialImageCompatibility(
      { ...png, url: "/card.png" },
      { targets: ["openGraph"], crawlerReady: true },
    );

    expect(report.compatible).toBe(false);
    expect(report.issues[0]?.code).toBe("url");
  });

  it("rejects invalid byte counts", () => {
    expect(() => socialImageCompatibility(png, { fileSize: -1 })).toThrow(/fileSize/);
  });

  it("rejects unknown profiles at the JavaScript boundary", () => {
    expect(() =>
      socialImageCompatibility(png, {
        targets: ["made-up" as never],
      }),
    ).toThrow(/Unknown social target/);
  });
});
