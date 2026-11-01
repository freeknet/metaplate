import { readFile } from "node:fs/promises";
import type { Metadata } from "next";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  socialImageMetadata,
  socialMetaHtml,
  socialMetaTags,
  type OpenGraphAudio,
  type OpenGraphVideo,
  type SocialMetaInput,
  type SocialMetaTag,
} from "../src/index.js";
import { createNextOg } from "../src/next.js";
import { createSvgOg } from "../src/render.js";

const keyOf = (tag: SocialMetaTag) => (tag.property !== undefined ? tag.property : tag.name);
const keys = (tags: SocialMetaTag[]) => tags.map(keyOf);

const trailer: OpenGraphVideo = {
  url: "https://cdn.example.com/trailer.mp4",
  secureUrl: "https://cdn.example.com/trailer.mp4",
  type: "video/mp4",
  width: 1280,
  height: 720,
};
const teaser: OpenGraphVideo = { url: "https://cdn.example.com/teaser.webm", type: "video/webm" };
const theme: OpenGraphAudio = {
  url: "https://cdn.example.com/theme.mp3",
  secureUrl: "https://cdn.example.com/theme.mp3",
  type: "audio/mpeg",
};
const page = { title: "Launch", url: "https://example.com/launch" };

describe("socialMetaTags video and audio groups", () => {
  it("places video then audio after the image groups and before twitter and page tags", () => {
    const social = socialImageMetadata("/launch", "Launch card", {
      origin: "https://example.com",
      type: "image/png",
      media: { videos: [trailer], audio: [theme] },
    });
    expect(socialMetaTags(social, page)).toEqual([
      { property: "og:image", content: "https://example.com/launch/og-image" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:type", content: "image/png" },
      { property: "og:image:alt", content: "Launch card" },
      { property: "og:video", content: "https://cdn.example.com/trailer.mp4" },
      { property: "og:video:secure_url", content: "https://cdn.example.com/trailer.mp4" },
      { property: "og:video:type", content: "video/mp4" },
      { property: "og:video:width", content: "1280" },
      { property: "og:video:height", content: "720" },
      { property: "og:audio", content: "https://cdn.example.com/theme.mp3" },
      { property: "og:audio:secure_url", content: "https://cdn.example.com/theme.mp3" },
      { property: "og:audio:type", content: "audio/mpeg" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: "https://example.com/launch/og-image" },
      { name: "twitter:image:alt", content: "Launch card" },
      { property: "og:title", content: "Launch" },
      { property: "og:url", content: "https://example.com/launch" },
      { property: "og:type", content: "website" },
    ]);
  });

  it("repeats one group per video in caller order and drops repeated URLs", () => {
    const tags = socialMetaTags({
      openGraph: { videos: [trailer, teaser, { ...trailer, type: "video/quicktime" }] },
    });
    expect(keys(tags)).toEqual([
      "og:video",
      "og:video:secure_url",
      "og:video:type",
      "og:video:width",
      "og:video:height",
      "og:video",
      "og:video:type",
    ]);
    expect(tags.filter((tag) => keyOf(tag) === "og:video").map((tag) => tag.content)).toEqual([
      trailer.url,
      teaser.url,
    ]);
  });

  it("emits audio alone, with no image, video, or twitter tags", () => {
    const tags = socialMetaTags({ openGraph: { audio: [theme, { url: "https://cdn.example.com/b.ogg" }] } });
    expect(keys(tags)).toEqual([
      "og:audio",
      "og:audio:secure_url",
      "og:audio:type",
      "og:audio",
    ]);
  });

  it("never emits dimensions for audio, even from loosely typed input", () => {
    const loose = { url: "https://cdn.example.com/a.mp3", width: 10, height: 10 } as OpenGraphAudio;
    expect(keys(socialMetaTags({ openGraph: { audio: [loose] } }))).toEqual(["og:audio"]);
  });

  it("resolves relative URLs against the canonical url and dedupes by the resolved URL", () => {
    const input: SocialMetaInput = {
      openGraph: {
        videos: [
          { url: "media/clip.mp4" },
          { url: "https://example.com/blog/media/clip.mp4" },
          { url: "/media/other.mp4" },
        ],
        audio: [{ url: "../podcast.mp3" }],
      },
    };
    const tags = socialMetaTags(input, { url: "https://example.com/blog/post" });
    expect(tags.filter((tag) => keyOf(tag) === "og:video" || keyOf(tag) === "og:audio")).toEqual([
      { property: "og:video", content: "https://example.com/blog/media/clip.mp4" },
      { property: "og:video", content: "https://example.com/media/other.mp4" },
      { property: "og:audio", content: "https://example.com/podcast.mp3" },
    ]);
    // Without a canonical url, relative URLs are emitted exactly as given.
    expect(socialMetaTags(input)[0]).toEqual({ property: "og:video", content: "media/clip.mp4" });
  });

  it("omits empty optional fields and emits nothing for empty lists", () => {
    expect(socialMetaTags({ openGraph: { videos: [{ url: "/v.mp4", secureUrl: "", type: "" }] } })).toEqual([
      { property: "og:video", content: "/v.mp4" },
    ]);
    expect(socialMetaTags({ openGraph: { videos: [], audio: [] } })).toEqual([]);
  });

  it("escapes media values in socialMetaHtml", () => {
    const html = socialMetaHtml({
      openGraph: { videos: [{ url: "https://cdn.example.com/a.mp4?x=1&y=2", type: 'video/mp4; codecs="avc1"' }] },
    });
    expect(html).toBe(
      [
        '<meta property="og:video" content="https://cdn.example.com/a.mp4?x=1&amp;y=2">',
        '<meta property="og:video:type" content="video/mp4; codecs=&quot;avc1&quot;">',
      ].join("\n"),
    );
  });
});

describe("video and audio validation", () => {
  const metadata = (media: Parameters<typeof socialImageMetadata>[2]) =>
    socialImageMetadata("/", "card", media);

  it("requires secure_url to be an absolute https URL", () => {
    for (const secureUrl of ["http://cdn.example.com/a.mp4", "/a.mp4", "ftp://cdn.example.com/a.mp4"]) {
      expect(() => metadata({ media: { videos: [{ url: "https://cdn.example.com/a.mp4", secureUrl }] } })).toThrow(
        /Invalid Open Graph video secure_url: expected an absolute https URL/,
      );
      expect(() => socialMetaTags({ openGraph: { audio: [{ url: "/a.mp3", secureUrl }] } })).toThrow(
        /Invalid Open Graph audio secure_url/,
      );
    }
    expect(() =>
      metadata({ media: { videos: [{ url: "/a.mp4", secureUrl: "https://user:pw@cdn.example.com/a.mp4" }] } }),
    ).toThrow(/must not contain credentials/);
  });

  it("rejects empty, non-http(s), and credentialed URLs", () => {
    expect(() => metadata({ media: { videos: [{ url: "" }] } })).toThrow(/Open Graph video URL must not be empty/);
    expect(() => metadata({ media: { audio: [{ url: "javascript:alert(1)" }] } })).toThrow(
      /Invalid Open Graph audio URL: expected http\(s\) or a relative URL/,
    );
    expect(() => socialMetaTags({ openGraph: { videos: [{ url: "https://u:p@example.com/v.mp4" }] } })).toThrow(
      /must not contain credentials/,
    );
  });

  it("rejects a type that is not a media type", () => {
    for (const type of ["mp4", "video/", "video mp4", "video/mp4; codecs"]) {
      expect(() => metadata({ media: { videos: [{ url: "/v.mp4", type }] } })).toThrow(
        /Invalid Open Graph video type: expected a media type/,
      );
    }
    expect(() => socialMetaTags({ openGraph: { audio: [{ url: "/a.mp3", type: "audio" }] } })).toThrow(
      /Invalid Open Graph audio type/,
    );
  });

  it("rejects video dimensions outside the library's integer range", () => {
    for (const [axis, value] of [["width", 0], ["height", 65_536], ["width", 1.5], ["height", Number.NaN]] as const) {
      expect(() => metadata({ media: { videos: [{ url: "/v.mp4", [axis]: value }] } })).toThrow(
        new RegExp(`Invalid Open Graph video ${axis}: must be an integer from 1 to 65535`),
      );
    }
    expect(() => socialMetaTags({ openGraph: { videos: [{ url: "/v.mp4", height: -1 }] } })).toThrow(
      /Invalid Open Graph video height/,
    );
    expect(metadata({ media: { videos: [{ url: "/v.mp4", width: 1, height: 65_535 }] } }).openGraph.videos).toEqual([
      { url: "/v.mp4", width: 1, height: 65_535 },
    ]);
  });

  it("copies media so later caller mutation cannot change metadata", () => {
    const video: OpenGraphVideo = { url: "https://cdn.example.com/a.mp4" };
    const social = metadata({ media: { videos: [video] } });
    video.url = "https://cdn.example.com/changed.mp4";
    expect(social.openGraph.videos?.[0]?.url).toBe("https://cdn.example.com/a.mp4");
  });
});

describe("Next.js metadata mapping", () => {
  const plate = createNextOg<{ title: string }>({
    alt: (copy) => `${copy.title} card`,
    origin: "https://example.com",
    variants: { square: { size: { width: 1080, height: 1080 } } },
    component: (copy) => createElement("div", { style: { display: "flex" } }, copy.title),
  });

  it("carries videos and audio in Next's openGraph descriptor shape", () => {
    const social = plate.metadata("/launch", { title: "Launch" }, { media: { videos: [trailer], audio: [theme] } });
    // Checked by `tsc`: the plate's openGraph is assignable to Next's Metadata as-is.
    const metadata: Metadata = { openGraph: social.openGraph, twitter: social.twitter };
    expect(metadata.openGraph).toEqual({
      images: social.openGraph.images,
      videos: [
        {
          url: "https://cdn.example.com/trailer.mp4",
          secureUrl: "https://cdn.example.com/trailer.mp4",
          type: "video/mp4",
          width: 1280,
          height: 720,
        },
      ],
      audio: [
        { url: "https://cdn.example.com/theme.mp3", secureUrl: "https://cdn.example.com/theme.mp3", type: "audio/mpeg" },
      ],
    });
    expect(Object.keys(social.openGraph)).toEqual(["images", "videos", "audio"]);
  });

  it("passes media through a variant view too", () => {
    const social = plate.variant("square").metadata("/launch", { title: "Launch" }, { media: { audio: [theme] } });
    expect(social.openGraph.images.map((image) => image.width)).toEqual([1080]);
    expect(social.openGraph.audio).toEqual([theme]);
    expect(social.openGraph.videos).toBeUndefined();
  });

  it("rejects relative media URLs because Next.js emits them verbatim", () => {
    expect(() => plate.metadata("/launch", { title: "Launch" }, { media: { videos: [{ url: "/clip.mp4" }] } })).toThrow(
      /metaplate\/next requires absolute Open Graph video and audio URLs/,
    );
  });

  it("leaves the other plates' relative media for socialMetaTags to resolve", () => {
    const svg = createSvgOg<{ title: string }>({
      alt: (copy) => copy.title,
      fonts: () => [],
      component: (copy) => ({ type: "div", props: { children: copy.title } }),
    });
    const social = svg.metadata("/launch", { title: "Launch" }, { media: { videos: [{ url: "clip.mp4" }] } });
    expect(socialMetaTags(social, page).find((tag) => keyOf(tag) === "og:video")?.content).toBe(
      "https://example.com/clip.mp4",
    );
  });
});

const fixture = JSON.parse(
  await readFile(new URL("fixtures/single-size-metadata-0.8.0.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

describe("output without media is unchanged", () => {
  it("keeps single-image metadata byte-identical to the 0.8.0 fixture with or without empty media", () => {
    const options = { origin: "https://example.com", basePath: "/project", imagePath: "og-image.jpg", type: "image/jpeg" };
    const expected = JSON.stringify(fixture.core, null, 2);
    expect(JSON.stringify(socialImageMetadata("/docs", "Docs card", options), null, 2)).toBe(expected);
    expect(
      JSON.stringify(socialImageMetadata("/docs", "Docs card", { ...options, media: { videos: [], audio: [] } }), null, 2),
    ).toBe(expected);
    expect(JSON.stringify(socialImageMetadata("/", "card", { media: {} }), null, 2)).toBe(
      JSON.stringify(fixture.coreDefault, null, 2),
    );
  });

  it("emits identical tags for metadata without media", () => {
    const social = socialImageMetadata("/docs", "Docs card", { type: "image/png" });
    const withEmpty = socialImageMetadata("/docs", "Docs card", { type: "image/png", media: { videos: [] } });
    expect(socialMetaHtml(withEmpty, page)).toBe(socialMetaHtml(social, page));
    expect(keys(socialMetaTags(social, page)).some((key) => /og:(?:video|audio)/.test(key))).toBe(false);
  });
});
