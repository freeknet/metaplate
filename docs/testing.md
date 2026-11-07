# Testing your cards

A social card fails quietly. The build stays green and the page looks fine, and you
find out when someone shares a link. Each check below catches something the others
cannot, so most projects want more than one.

| Check | When it runs | What it catches | Network |
| --- | --- | --- | --- |
| [Render guards](#fail-the-render) | Every render | Text off the card, missing glyphs, a blank image | No |
| [`metaplate render` / `verify`](#verify-the-files) | Build | Wrong size or format, a truncated file | No |
| [Unit tests](#test-the-plate) | Test run | A route with no card, a title that stops fitting, platform limits | No |
| [Export audit](#audit-the-whole-export) | After the build | A page pointing at a missing or mismatched file | No |
| [Browser tests](#in-a-browser-test) | E2E run | The same, through the server you test against, plus response headers | Local |
| [`verify-page`](#after-the-deploy) | After the deploy | Everything a crawler meets: redirects, robots.txt, real responses | Yes |
| [Baselines](#catch-visual-changes) | After an upgrade | Any visible change, with no failure to report | No |

The examples are from
[`examples/next-static-site`](https://github.com/freeknet/metaplate/tree/main/examples/next-static-site),
but only the audit depends on Next.

## Fail the render

[Guards](rendering.md#render-guards) are off by default. Turn them on, because they
cover what no check on the finished file can: a card with its title drawn off the
canvas still has the right size and format.

```ts
export const og = createNodeOg<Copy>({
  // ...
  guards: { missingGlyphs: "error", overflow: "error", safeArea: "error", blank: "error" },
});
```

Guards run on every render, so all the later checks inherit them. They need
`createNodeOg` or `createEdgeOg`: `next/og` exposes nothing they can run on, so
`createNextOg` rejects them.

## Verify the files

`metaplate render` verifies every file it writes. To check files from anywhere else,
or to apply platform rules:

```sh
npx metaplate verify --require-content --target whatsapp --target linkedin --size 1200x630 "out/**/og-image.png"
```

Quote the glob: Metaplate expands it, so it works on Windows too. `--size` is
required. `--require-content` also decodes PNG and JPEG and fails an image that is a
single color.

## Test the plate

Rendering in a test runs the plate's guards, so a title that stops fitting fails
where you will see it first. This also proves the registry is complete, and that the
metadata keeps the fields [Next's shallow merge](nextjs.md#nextjs-adapter) would drop:

```ts
// tests/cards.test.ts
import { describe, expect, it } from "vitest";
import { verifySocialImage } from "metaplate";
import { ALL_CARDS, CARDS } from "../src/lib/og/cards";
import { pageMetadata } from "../src/lib/og/metadata";
import { og } from "../src/lib/og/plate";
import { STATIC_ROUTES } from "../src/lib/site";

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
      const report = verifySocialImage(bytes, image!, {
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
```

Give render tests a generous timeout: the first render in a process loads fonts and
the native renderer, which takes a while on a cold CI runner.

### Check bytes against the descriptor

`verifySocialImage` takes the encoded bytes and the descriptor the plate publishes,
and reports where they disagree. Its URL check is the one that catches people out.
Most targets require an absolute HTTPS URL, because that is what crawlers need, but
a plate's URLs are relative unless you set `origin`:

```ts
const og = createNodeOg<Copy>({ imagePath: "og.png", /* no origin */ ... });

const [image] = og.metadata("/", copy).openGraph.images; // url: "/og.png"
verifySocialImage(bytes, image!, { targets: ["universal"] });
// compatible: false. "Crawler-ready social images require an absolute HTTPS URL."
```

The card is fine; the descriptor is not finished. Use one of these:

- **Set `origin` on the plate**, as the example does. URLs are then absolute
  everywhere, and the check runs on what you really publish.
- **Keep relative URLs**, because Next's `metadataBase` resolves them, and make the
  descriptor absolute for the test:

  ```ts
  verifySocialImage(bytes, { ...image!, url: `https://example.com${image!.url}` }, { targets });
  ```

- **Check bytes only**, leaving `url` out of the descriptor. Without one, the URL rule
  is skipped:

  ```ts
  verifySocialImage(bytes, { width: 1200, height: 630, type: "image/png" }, { targets });
  ```

`report.compatible` is false only when an issue has `severity: "error"`. Warnings,
such as LinkedIn's on an image that is not 1.91:1, are also in `report.issues`, so
filter them as your project needs. `report.actual` holds the
measured `width`, `height`, `format`, `contentType`, and `byteLength`.

## Audit the whole export

The checks above test the cards. They do not test whether each page's HTML names
the right card, which is the thing that breaks when a route is renamed. This script
walks a static export and checks the two against each other, with no server:

```ts
// scripts/audit-export.mts
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { verifySocialImage } from "metaplate";
import { extractPageSocialMetadata } from "metaplate/node";
import { SITE } from "../src/lib/site";

/*
 * Checks every exported page offline: reads the `og:image` the HTML names, finds
 * that file in `out/`, and verifies its bytes against the tags. A page whose card
 * is missing or wrong fails the build. Network checks come after the deploy, with
 * `metaplate verify-page`.
 */
const OUT = path.resolve("out");
const TARGETS = ["universal", "facebook", "linkedin", "slack", "whatsapp", "x"] as const;

const entries = await readdir(OUT, { recursive: true, withFileTypes: true });
const pages = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
  .map((entry) => path.join(entry.parentPath, entry.name))
  .filter((file) => !/[\\/]_next[\\/]|[\\/](404|_not-found)[\\/.]/.test(file));

const failures: string[] = [];

for (const file of pages) {
  const page = path.relative(OUT, file);
  const documentUrl = new URL(page.replaceAll("\\", "/"), `${SITE.origin}/`).href;
  const { openGraph } = extractPageSocialMetadata(await readFile(file, "utf8"), documentUrl);
  const [image] = openGraph.images;
  if (!image?.url) {
    failures.push(`${page}: no og:image`);
    continue;
  }

  // `?v=` is a cache-busting token on the URL; the file on disk does not carry it.
  const card = path.join(OUT, new URL(image.url).pathname);
  const bytes = await readFile(card).catch(() => undefined);
  if (!bytes) {
    failures.push(`${page}: ${image.url} is not in the export`);
    continue;
  }

  // Tag values are strings as written, and the descriptor compares numbers.
  const report = verifySocialImage(
    bytes,
    {
      url: image.url,
      ...(image.alt ? { alt: image.alt } : {}),
      ...(image.type ? { type: image.type } : {}),
      width: Number(image.width),
      height: Number(image.height),
    },
    { targets: TARGETS },
  );
  for (const issue of report.issues) {
    if (issue.severity === "error") failures.push(`${page}: ${issue.target ?? ""} ${issue.message}`);
  }
}

if (failures.length > 0) {
  console.error(`Social card audit failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`Social card audit: ${pages.length} pages verified`);
```

`extractPageSocialMetadata` is the parser `verify-page` uses, so it reads tags the
way the deployed check will, instead of relying on the order of attributes as a
regular expression would. It returns values as written, so convert the numbers. Run
the script from `postbuild`, and adjust the page filter if your site has other pages
with no card. Under a `basePath`, remove the prefix from `pathname` before joining it
to `out/`.

## In a browser test

If you already run Playwright against the built site, one test per route adds a check
of the responses themselves, including `Content-Type`. This uses only the `request`
fixture, so it needs no browser:

```ts
// e2e/cards.spec.ts
import { expect, test } from "@playwright/test";
import { verifySocialImage } from "metaplate";

for (const route of ["/", "/pricing/", "/guides/first-survey/"]) {
  test(`${route} advertises a card that exists`, async ({ request }) => {
    const html = await (await request.get(route)).text();
    const tag = (property: string) =>
      html.match(new RegExp(`<meta property="${property}" content="([^"]*)"`))?.[1];
    const url = tag("og:image");
    expect(url, "og:image").toBeTruthy();

    // The tag names the production origin; fetch the same path from the test server.
    const card = await request.get(new URL(url!).pathname);
    expect(card.status(), url).toBe(200);
    expect(card.headers()["content-type"]).toBe("image/png");

    const report = verifySocialImage(new Uint8Array(await card.body()), {
      url: url!,
      alt: tag("og:image:alt") ?? "",
      type: tag("og:image:type") ?? "",
      width: Number(tag("og:image:width")),
      height: Number(tag("og:image:height")),
    }, { targets: ["universal", "linkedin", "slack"] });
    expect(report.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });
}
```

Fetching the tag's URL directly would test production rather than your build. That is
why the test takes only its `pathname`.

## After the deploy

Run this against the real site. It is the only check here that behaves like a
crawler: it follows redirects, reads robots.txt, and fetches each image the tags
name under a hardened fetch policy.

```sh
npx metaplate verify-page --target linkedin --target slack --target whatsapp https://example.com/pricing/
```

It takes several URLs, so a deploy job can pass a handful of representative pages.
See the [page audit guide](verify-page.md) for its options and JSON report.

## Catch visual changes

A change to a font, Satori, or Resvg can move every card by a few pixels. Nothing
fails, because nothing is wrong. `--baseline` compares each card with a recorded copy:

```sh
# Once: record the cards you are happy with, and commit or cache the directory.
npx metaplate verify --baseline og-baseline --update-baseline --size 1200x630 "out/**/og-image.png"

# Later: fail any card that changed, and write a picture of each change.
npx metaplate verify --baseline og-baseline --write-diff og-diff --size 1200x630 "out/**/og-image.png"
```

Run it whenever you upgrade; see [Upgrading](upgrading.md). A baseline fails on any
intended design change too, so rerun with `--update-baseline` after one. The
[verification guide](verification.md#compare-against-a-baseline) covers
`--max-diff` and `--threshold`.
