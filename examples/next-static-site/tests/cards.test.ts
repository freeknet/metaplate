// tests/cards.test.ts
import { describe, expect, it } from "vitest";
import { verifySocialImage } from "metaplate";
import { ALL_CARDS, CARDS } from "../src/lib/og/cards";
import { pageMetadata } from "../src/lib/og/metadata";
import { og } from "../src/lib/og/plate";
import { SITE, STATIC_ROUTES } from "../src/lib/site";

describe("social cards", () => {
  it("has a card for every static route", () => {
    expect(Object.keys(CARDS).sort()).toEqual([...STATIC_ROUTES].sort());
  });

  // Rendering runs the plate's guards, so a title that stops fitting fails here
  // as well as in the build. The first render loads fonts and native code.
  for (const { route, copy } of ALL_CARDS) {
    it(`renders ${route}`, async () => {
      const bytes = await og.render(copy);
      const [image] = og.metadata(route, copy).openGraph.images;
      // Crawlers require HTTPS, so a build with a local origin skips the URL rule.
      const { url, ...rest } = image!;
      const descriptor = SITE.origin.startsWith("https://") ? image! : rest;
      const report = verifySocialImage(bytes, descriptor, {
        targets: ["universal", "facebook", "linkedin", "slack", "whatsapp", "x"],
      });
      expect(report.issues.filter((issue) => issue.severity === "error")).toEqual([]);
      expect(report.actual).toMatchObject({ width: 1200, height: 630, format: "png" });
    }, 30_000);
  }

  it("keeps the fields Next's shallow merge would otherwise drop", () => {
    const metadata = pageMetadata("/pricing/", { title: "Pricing", description: "Words." }, CARDS["/pricing/"]);
    expect(metadata.openGraph).toMatchObject({ siteName: "Fieldnotes", url: "/pricing/" });
    expect(JSON.stringify(metadata.openGraph?.images)).toMatch(/\/pricing\/og-image\.png\?v=/);
  });

  it("gives changed copy a new image URL", () => {
    const copy = CARDS["/pricing/"];
    const url = (title: string) => og.image("/pricing/", { ...copy, title }).url;
    expect(url(copy.title)).toBe(url(copy.title));
    expect(url(copy.title)).not.toBe(url("Something else"));
  });
});
