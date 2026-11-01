import type { Metadata } from "next";
import { socialImageMetadata, socialMetaHtml, type OpenGraphVideo } from "metaplate";

// Open Graph video and audio: https://ogp.me/#structured
const trailer: OpenGraphVideo = {
  url: "https://cdn.example.com/launch/trailer.mp4",
  secureUrl: "https://cdn.example.com/launch/trailer.mp4",
  type: "video/mp4",
  width: 1280,
  height: 720,
};

const social = socialImageMetadata("/launch", "Launch card", {
  origin: "https://example.com",
  type: "image/png",
  media: {
    videos: [trailer],
    audio: [{ url: "https://cdn.example.com/launch/theme.mp3", type: "audio/mpeg" }],
  },
});

/**
 * A hand-written `<head>`: the `og:video` and `og:audio` groups follow the
 * `og:image` group and precede the `twitter:*` tags.
 */
export const head = socialMetaHtml(social, {
  title: "Launch",
  url: "https://example.com/launch",
  indent: "  ",
});

/**
 * Next.js: `social.openGraph` already uses Next's `videos` and `audio`
 * descriptor fields (`url`, `secureUrl`, `type`, `width`, `height`). Next emits
 * video and audio URLs verbatim, so they are absolute here.
 */
export const metadata: Metadata = {
  title: "Launch",
  openGraph: social.openGraph,
  twitter: social.twitter,
};
