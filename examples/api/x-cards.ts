import type { Metadata } from "next";
import { socialImageMetadata, socialMetaHtml } from "metaplate";
import { nextTwitterMetadata } from "metaplate/next";

// A player card: X embeds the HTTPS iframe and can play the raw stream inline.
// The social image is still emitted as `twitter:image`, the fallback X shows
// where the player cannot run.
export const trailer = socialImageMetadata("/trailer", "Trailer card", {
  origin: "https://example.com",
  imagePath: "og-image.png",
  twitter: {
    card: "player",
    site: "@example",
    player: {
      url: "https://example.com/embed/trailer",
      width: 1280,
      height: 720,
      stream: "https://cdn.example.com/trailer.mp4",
    },
  },
});

// An app card: at least one store listing is required; names and URLs are
// optional per platform.
export const install = socialImageMetadata("/app", "App card", {
  origin: "https://example.com",
  twitter: {
    card: "app",
    site: "@example",
    description: "Track launches from your phone.",
    app: {
      iphone: { id: "307234931", name: "Example", url: "example://home" },
      googleplay: { id: "com.example.app", name: "Example", url: "example://home" },
    },
  },
});

// Pages that write their own `<head>`.
export const trailerHead = socialMetaHtml(trailer, { title: "Trailer", url: "https://example.com/trailer" });

// Next.js: `nextTwitterMetadata` maps onto `Metadata.twitter` (`players` and
// `app`), and throws for anything Next cannot render exactly.
export const metadata: Metadata = {
  openGraph: { images: install.openGraph.images },
  twitter: nextTwitterMetadata(install.twitter),
};
