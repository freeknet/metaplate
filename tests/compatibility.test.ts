import { describe, expect, it } from "vitest";
import { socialImageCompatibility, type SocialImageDescriptor } from "../src/index.js";

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
    const report = socialImageCompatibility(png, { targets: ["instagram"] });

    expect(report.compatible).toBe(true);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.severity).toBe("unknown");
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
