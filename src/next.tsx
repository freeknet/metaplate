import type { ReactElement } from "react";
import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  assertImageSize,
  socialImage,
  socialImageMetadata,
  type ImageSize,
} from "./core.js";
import { optionalPeer } from "./optional-peer.js";

type ImageResponseConstructor = typeof import("next/og").ImageResponse;
type ImageResponseOptions = NonNullable<
  ConstructorParameters<ImageResponseConstructor>[1]
>;
type ImageResponseFont = NonNullable<ImageResponseOptions["fonts"]>[number];

const loadImageResponse = optionalPeer(
  { package: "next", entries: "metaplate/next" },
  async (): Promise<ImageResponseConstructor> => (await import("next/og")).ImageResponse,
);

export type FontLoader = () =>
  | Promise<readonly ImageResponseFont[]>
  | readonly ImageResponseFont[];

export type NextOgDefinition<Copy> = {
  /** Satori-compatible JSX. Every element with multiple children should use flex. */
  component: (copy: Copy) => ReactElement;
  /** Derives accessible alternative text from the same page-owned copy. */
  alt: (copy: Copy) => string;
  /** One plate renders one size; `plate.size` is the size every render uses. */
  size?: ImageSize;
  imagePath?: string;
  basePath?: string;
  /** Scheme and host for absolute image URLs, such as `https://example.com`. */
  origin?: string;
  fonts?: FontLoader;
  response?: Omit<ImageResponseOptions, "width" | "height" | "fonts">;
};

/**
 * Defines one branded image system and returns the renderer, route handler,
 * and metadata helpers that consume it.
 */
export function createNextOg<Copy>(definition: NextOgDefinition<Copy>) {
  const size = Object.freeze({ ...(definition.size ?? OG_SIZE) });
  assertImageSize(size);
  const imagePath = definition.imagePath ?? "og-image";
  const basePath = definition.basePath ?? "";
  const origin = definition.origin ?? "";

  async function render(copy: Copy) {
    const fonts = definition.fonts ? await definition.fonts() : undefined;
    const responseOptions: ImageResponseOptions = {
      ...definition.response,
      width: size.width,
      height: size.height,
      ...(fonts ? { fonts: [...fonts] } : {}),
    };

    const ImageResponse = await loadImageResponse();
    return new ImageResponse(definition.component(copy), responseOptions);
  }

  return Object.freeze({
    size,
    contentType: OG_CONTENT_TYPE,
    render,
    handler: (copy: Copy) => () => render(copy),
    image: (route: string, copy: Copy) =>
      socialImage(route, definition.alt(copy), {
        size,
        imagePath,
        basePath,
        origin,
        type: OG_CONTENT_TYPE,
      }),
    metadata: (route: string, copy: Copy) =>
      socialImageMetadata(route, definition.alt(copy), {
        size,
        imagePath,
        basePath,
        origin,
        type: OG_CONTENT_TYPE,
      }),
  });
}