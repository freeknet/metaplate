# Card recipes

Designs and data shapes that come up on real sites. Each recipe is a complete
plate you can adapt. The longer ones live in
[`examples/api`](https://github.com/freeknet/metaplate/tree/main/examples/api),
where they are type-checked.

- [Text beside a photograph](#text-beside-a-photograph)
- [Photos of any shape](#photos-of-any-shape)
- [Logos](#logos)
- [Long titles](#long-titles)
- [Several fonts](#several-fonts)
- [Brand colors](#brand-colors)
- [One card per record](#one-card-per-record)
- [A remote image that may be missing](#a-remote-image-that-may-be-missing)
- [Another size for another platform](#another-size-for-another-platform)

## Text beside a photograph

The most common card: copy on one side, a real picture on the other.

```tsx
// examples/api/photo-card.tsx
import { readImageAsset } from "metaplate/assets";
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

type Copy = { eyebrow: string; title: string; photo: string; alt: string };

const PHOTO_WIDTH = 520;

export const og = createNodeOg<Copy>({
  alt: (copy) => copy.alt,
  // The route folder or output path takes this name, so hosts infer the type.
  imagePath: "og-image.jpg",
  fonts: fontsourceFontLoader([
    { font: "inter", weight: 400 },
    { font: "inter", weight: 700 },
  ]),
  output: {
    format: "jpeg",
    // Imported here so a page that only builds metadata never loads sharp.
    encode: async ({ pixels, width, height }) => {
      const { default: sharp } = await import("sharp");
      return sharp(pixels, { raw: { width, height, channels: 4 } })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer();
    },
  },
  guards: {
    missingGlyphs: "error",
    overflow: "error",
    blank: "error",
    // Fails a card whose text runs under the element with this `key`.
    avoid: { level: "error", keys: ["photo"], gap: 24 },
  },
  component: async (copy, { size }) => {
    // Read per card, so name only photos you control, never request input.
    const photo = await readImageAsset(`assets/photos/${copy.photo}.jpg`);
    return (
      <div style={{ display: "flex", width: "100%", height: "100%", background: "#10201c" }}>
        <div
          style={{
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            width: size.width - PHOTO_WIDTH,
            height: "100%",
            padding: "56px 48px 56px 64px",
            color: "#f2efe6",
            fontFamily: "Inter",
          }}
        >
          <span style={{ fontSize: 22, fontWeight: 400, color: "#e8a33d" }}>{copy.eyebrow}</span>
          <span style={{ fontSize: 58, fontWeight: 700, lineHeight: 1.08, marginTop: 14 }}>
            {copy.title}
          </span>
        </div>
        <img
          key="photo"
          src={photo.src}
          width={PHOTO_WIDTH}
          height={size.height}
          style={{ objectFit: "cover" }}
        />
      </div>
    );
  },
});
```

Why it is built this way:

- **JPEG, because of the photo.** A photographic card can be several times larger
  as PNG, and WhatsApp's large preview stops at 600 KB. `format` makes Metaplate
  check that every render really is JPEG, and carries the type into the metadata.
- **`readImageAsset`, not a hand-built data URI.** It checks the file's format and
  size first, so a bad file fails naming the file, and the error is yours rather
  than an empty box.
- **The photo is embedded whole.** A large master is decoded for every card, and one
  above `maxBytes` (4 MiB by default) is refused. Resize masters to about the panel
  size first, as part of your image pipeline.
- **`sharp` is imported inside `encode`.** Pages import the plate for its metadata;
  this keeps them from loading an image library they never use. Install it
  yourself: `npm install sharp`.

In Next, `imagePath: "og-image.jpg"` and `serverExternalPackages` are all the wiring
this needs; see [Static Next.js sites](static-next-site.md).

## Photos of any shape

Give an `<img>` both a `width` and a `height`, then choose how the picture fills
them with `objectFit`. It works on JPEG and PNG sources:

| `objectFit` | Result | Use it for |
| --- | --- | --- |
| `"cover"` | Fills the box and crops the overflow, centered | Photos you chose, in a panel |
| `"contain"` | Fits inside the box, with the box's background showing around it | Photos of unknown shape, such as user uploads, where cropping could remove the subject |
| Not set | **Stretches** the image to the box | Only an image that already has the box's aspect ratio |

The default is the one that surprises people: a landscape photo in a square box comes
out distorted, with no error.

`"cover"` always crops around the center. For a subject that sits elsewhere, crop
before embedding, and pass the result to
[`imageAsset`](rendering.md#embedding-bytes-with-imageasset):

```ts
import sharp from "sharp";
import { imageAsset } from "metaplate/image";

const bytes = await sharp(file)
  .resize(520, 630, { fit: "cover", position: "attention" })
  .jpeg({ quality: 86 })
  .toBuffer();
const photo = imageAsset(bytes);
```

For uploads of unknown shape, put `"contain"` on a dark panel, so the letterbox reads
as a frame:

```tsx
<div style={{ display: "flex", width: 555, height: 630, alignItems: "center", justifyContent: "center", background: "#111" }}>
  <img src={photo.src} width={440} height={330} style={{ objectFit: "contain" }} />
</div>
```

`objectFit` does not apply to an SVG source: an SVG with `"cover"` renders the same
as one with no `objectFit` at all. Rasterize the SVG first, or give it a box of its
own aspect ratio.

## Logos

There are two good ways to draw a logo, and which to choose depends on whether you
own the drawing:

| | Inline JSX `<svg>` | `fileImageLoader` |
| --- | --- | --- |
| Best for | A simple mark, sharing geometry with your site's component | An exported logo file you do not edit |
| Colors | Passed as props, so it can follow the theme | Fixed by the file |
| Files | None | The file must exist wherever the plate renders |

Inline, with the geometry imported from the component your site already uses so the
two cannot drift apart:

```tsx
import { MARK_PATH, MARK_VIEWBOX } from "@/components/brand/Mark";

function Mark({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox={MARK_VIEWBOX}>
      <path d={MARK_PATH} fill={color} />
    </svg>
  );
}
```

From a file, loaded once at module scope and shared by every card:

```tsx
import { fileImageLoader } from "metaplate/assets";

const logo = fileImageLoader("public/brand/logo.svg");

// Inside an async component:
const mark = await logo();
return <img src={mark.src} width={mark.width} height={mark.height} />;
```

Leave any `<title>` out of an inline SVG when the plate uses `createNextOg`; see
[Plate constraints](rendering.md#plate-constraints).

## Long titles

A title that fits today may not fit after someone edits it. Combine three things:
step the size by length so most titles stay large, clamp what is left so the card
stays readable, and guard the layout so a mistake fails rather than ships.

```tsx
// examples/api/long-titles.tsx
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

type Copy = { title: string; alt: string };

/** Step the size down by length. Measured against this plate's font and width. */
const titleSize = (title: string) => (title.length > 72 ? 48 : title.length > 36 ? 60 : 76);

export const og = createNodeOg<Copy>({
  alt: (copy) => copy.alt,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  // The clamp keeps text on the card, so this catches layout mistakes, not long copy.
  guards: { overflow: "error" },
  component: (copy) => (
    <div
      style={{
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: 72,
        background: "#111",
        color: "#fff",
        fontFamily: "Inter",
      }}
    >
      {/* `lineClamp` needs `display: "block"`, and ends the last line with an ellipsis. */}
      <div
        style={{
          display: "block",
          lineClamp: 3,
          fontSize: titleSize(copy.title),
          fontWeight: 700,
          lineHeight: 1.1,
        }}
      >
        {copy.title}
      </div>
    </div>
  ),
});
```

Choose by who writes the copy:

- **You write it:** leave the clamp out, and let the `overflow` guard fail the build.
  A truncated headline is worse than a build error you can fix in a minute. The
  guard's message says when the text needs more room than its container has.
- **Someone else's data writes it:** keep the clamp, because one long row should not
  block the deploy.
- **One line only:** use `whiteSpace: "nowrap"`, `overflow: "hidden"`, and
  `textOverflow: "ellipsis"` with `display: "block"` and a width.

Prefer these to cutting the string yourself: `lineClamp` breaks where the text
actually wraps, whatever the font's widths are.

## Several fonts

Most designs use more than one face. Load each weight of each family, then select
them by name:

```tsx
import { fontsourceFontLoader } from "metaplate/fonts";

const fonts = fontsourceFontLoader([
  { font: "inter", weight: 400 },
  { font: "inter", weight: 700 },
  { font: "jetbrains-mono", weight: 500 },
]);

// In the component:
<span style={{ fontFamily: "Inter", fontWeight: 700 }}>{copy.title}</span>
<span style={{ fontFamily: "JetBrains Mono", fontWeight: 500 }}>{copy.eyebrow}</span>
```

`font` is the Fontsource id, the package name without `@fontsource/`. `fontFamily`
is the family's display name, read from the package. Install each one:
`npm install @fontsource/inter @fontsource/jetbrains-mono`.

No render guard catches a font mismatch, because the text is still drawn:

| You write | What happens |
| --- | --- |
| A `fontFamily` that was not loaded, such as `"jetbrains-mono"` | Silently falls back to another loaded face. |
| A `fontWeight` that was not loaded | Silently uses the nearest loaded weight. |
| Text no loaded font covers | Missing-glyph boxes. The `missingGlyphs` guard does catch this. |

So look at a card after changing fonts; [`metaplate preview`](preview.md) is the
quickest way. `fontsourceFontLoader` reads only the `@fontsource` scope and refuses
`@fontsource-variable/*`, so install the static package of the same family, even if
your site uses the variable one. Other sources, including `next/font`, are covered
in the [fonts guide](fonts.md).

## Brand colors

Satori has no stylesheet, so `var(--brand)` does nothing. It raises no error: text
keeps its inherited color, and a background is simply not drawn. Keep the values in
a module that both the site and the plate can read:

```ts
// src/lib/brand.ts
export const BRAND = { ground: "#10201c", text: "#f2efe6", accent: "#e8a33d" } as const;
```

If the site's CSS holds the source of truth, add a small test that reads the
stylesheet and compares, so the card cannot drift from the site.

## One card per record

For camps, products, or articles from a CMS: thousands of cards, from data you did
not write. The render module's default export can be an async function, so it can
read anything:

```ts
// examples/api/listing-cards.ts
import { readFile } from "node:fs/promises";
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg, type RenderJob, type RenderModule } from "metaplate/node";

type Listing = { id: string; name: string; address?: string };
type Copy = { name: string; line: string; alt: string };

const el = (type: string, style: Record<string, unknown>, children: unknown) => ({
  type,
  props: { style, children },
});

export const og = createNodeOg<Copy>({
  alt: (copy) => copy.alt,
  imagePath: "og-image.png",
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  // With data you did not write, a guard is what stops one bad row shipping.
  guards: { missingGlyphs: "error", overflow: "error" },
  component: (copy) =>
    el(
      "div",
      {
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: 72,
        background: "#111",
        color: "#fff",
        fontFamily: "Inter",
      },
      [
        el("div", { display: "block", lineClamp: 2, fontSize: 64 }, copy.name),
        el("div", { fontSize: 30, marginTop: 24 }, copy.line),
      ],
    ),
});

/** The default export may be a function, so the pages can come from anywhere. */
const listingCards: RenderModule = async () => {
  const listings: Listing[] = JSON.parse(await readFile("data/listings.json", "utf8"));
  const pages = listings.map((listing) => ({
    route: `/listings/${listing.id}/`,
    copy: {
      name: listing.name,
      line: listing.address ?? "Address to be announced",
      alt: listing.address ? `${listing.name}, ${listing.address}` : listing.name,
    },
  }));
  return { plate: og, pages } satisfies RenderJob<Copy>;
};

export default listingCards;
```

`metaplate render` already renders concurrently, reports every failure, and exits
`1` if any card failed, so a build script does not need its own queue. It does two
things you may want to add for a large, changing set. It does not delete the card of
a record that has gone away, and files written before a failure stay in place. So
render into a scratch directory and swap it in only when the whole run succeeds:

```ts
// examples/api/render-listings.mts
import { rename, rm } from "node:fs/promises";
import { runCli } from "metaplate/cli";

const SCRATCH = ".listing-cards";
const LIVE = "public/listings";

// Start empty, so a listing that has gone away leaves no card behind.
await rm(SCRATCH, { recursive: true, force: true });

const code = await runCli(["render", "--out", SCRATCH, "--concurrency", "8", "listing-cards.ts"]);

// A failed run exits 1 with every failure reported, and the live cards stay as
// they were. `metaplate-manifest.json` stays in the scratch directory, unpublished.
if (code === 0) {
  await rm(LIVE, { recursive: true, force: true });
  await rename(`${SCRATCH}/listings`, LIVE);
  await rm(SCRATCH, { recursive: true, force: true });
}
process.exit(code);
```

Keep the scratch directory on the same drive as `public/`, because `rename` cannot
cross file systems.

Some things to decide for a set this size:

- **Should one bad row block the deploy?** As written, yes: an emoji with no emoji
  loader fails the whole run, and the old cards stay live. To tolerate it, add the
  [`emoji`](emoji.md) option, or remove that guard.
- **Does the record already have a picture?** Pointing its tags straight at that
  picture can save most of the disk space, at the cost of a card with no text. Skip
  those records in `pages`, and give the page's metadata the picture's URL.
- **Rebuilds often?** [`--incremental`](render-cli.md#incremental-builds) skips cards
  whose copy and plate are unchanged, but it needs the previous files and manifest on
  disk, so use it instead of the scratch directory, in place. It cannot see a file the
  plate reads for itself, so raise `revision` when one changes.
- **Privacy.** A card puts text in a public image that crawlers keep. Filter anything
  embargoed out of `copy`, not just out of the page.

## A remote image that may be missing

For an avatar or a cover hosted elsewhere, `remoteImageLoader` fetches under an
allowlist with a byte cap and a timeout. Decide what a failure should do. Usually a
missing avatar should not stop a build, while a wrong allowlist should:

```tsx
// examples/api/remote-avatar.tsx
import { RemoteImageError, remoteImageLoader } from "metaplate/assets";
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

type Copy = { name: string; avatar: string; alt: string };

const avatars = remoteImageLoader({ origins: ["https://avatars.example.com"] });

/** A missing avatar should not fail the build. A wrong allowlist should. */
async function avatarOrNothing(url: string) {
  try {
    return await avatars(url);
  } catch (error) {
    if (error instanceof RemoteImageError && error.code !== "origin") {
      console.warn(`No avatar for this card: ${error.message}`);
      return undefined;
    }
    throw error;
  }
}

export const og = createNodeOg<Copy>({
  alt: (copy) => copy.alt,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  component: async (copy) => {
    const avatar = await avatarOrNothing(copy.avatar);
    return (
      <div
        style={{
          boxSizing: "border-box",
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          gap: 40,
          padding: 72,
          background: "#111",
          color: "#fff",
          fontFamily: "Inter",
          fontSize: 64,
        }}
      >
        {avatar ? (
          <img src={avatar.src} width={160} height={160} style={{ borderRadius: 80 }} />
        ) : (
          <div style={{ display: "flex", width: 160, height: 160, borderRadius: 80, background: "#345" }} />
        )}
        {copy.name}
      </div>
    );
  },
});
```

`remoteImageLoader` keeps its results in a cache and shares one request between
renders, so define it once at module scope. See
[Remote images](rendering.md#remote-images-with-an-origin-allowlist) for the full
fetch policy.

## Another size for another platform

A plate renders exactly one size per view, so another size is a declared
[variant](variants.md), not a render option. This also covers assets beyond social
cards, such as GitHub's 1280x640 repository preview:

```tsx
export const og = createNodeOg<Copy, "github">({
  alt: (copy) => copy.alt,
  fonts,
  imagePath: "og-image.png",
  variants: { github: { size: { width: 1280, height: 640 }, imagePath: "github-preview.png" } },
  component: (copy, { size }) => <Card copy={copy} width={size.width} height={size.height} />,
});

const banner = await og.variant("github").render(copy);
```

`metaplate render` writes every declared variant. Every variant also appears in the
page's `og:image` tags, in order after the default, so a size that is not meant for
crawlers should be a separate plate that shares the same component.
