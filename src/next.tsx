import type { Metadata } from "next";
import type { ReactElement } from "react";
import { OG_CONTENT_TYPE, type ImageSize, type XCardMetadata } from "./core.js";
import { assertAbsoluteMedia } from "./og-media.js";
import { optionalPeer } from "./optional-peer.js";
import { nextTwitterShape } from "./x-cards.js";
import {
  createPlateHandlers,
  createPlateSocial,
  createPlateViews,
  isPendingElement,
  type PlateContext,
  type PlateElement,
  type PlateMetadataOptions,
  type PlateVariants,
} from "./plate.js";

export type {
  PlateContext,
  PlateElement,
  PlateMetadataOptions,
  PlateVariant,
  PlateVariants,
  PlateView,
} from "./plate.js";

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

export type NextOgDefinition<Copy, Variant extends string = string> = {
  /**
   * Satori-compatible JSX. Every element with multiple children should use
   * flex. The second argument names the variant and size being rendered. An
   * `async` component may load per-page data before returning its element.
   */
  component: (copy: Copy, context: PlateContext<Variant>) => PlateElement<ReactElement>;
  /** Derives accessible alternative text from the same page-owned copy. */
  alt: (copy: Copy) => string;
  /**
   * The default size. Each view of a plate renders one size: `plate.size`
   * for the default, `plate.variant(name).size` for a declared variant.
   */
  size?: ImageSize;
  /** Additional named sizes rendered from the same copy and component. */
  variants?: PlateVariants<Copy, Variant>;
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
export function createNextOg<Copy, Variant extends string = string>(
  definition: NextOgDefinition<Copy, Variant>,
) {
  const social = createPlateSocial(definition, OG_CONTENT_TYPE);

  return createPlateViews(social.variants, (name) => {
    const view = social.view(name);
    const { size } = view.context;

    async function render(copy: Copy) {
      const fonts = definition.fonts ? await definition.fonts() : undefined;
      const responseOptions: ImageResponseOptions = {
        ...definition.response,
        width: size.width,
        height: size.height,
        ...(fonts ? { fonts: [...fonts] } : {}),
      };

      const ImageResponse = await loadImageResponse();
      const rendered = definition.component(copy, view.context);
      const element = isPendingElement(rendered) ? await rendered : rendered;
      return new ImageResponse(element, responseOptions);
    }

    return {
      size,
      image: view.image,
      /**
       * Next-ready metadata: pass `openGraph` and `twitter` to Next's
       * `Metadata`. Video and audio URLs must be absolute, because Next.js
       * emits them without resolving `metadataBase`.
       */
      metadata: (route: string, copy: Copy, options?: PlateMetadataOptions<Variant>) => {
        const metadata = view.metadata(route, copy, options);
        assertAbsoluteMedia(metadata.openGraph, "metaplate/next");
        return metadata;
      },
      /** The image path relative to the deployment root, without `basePath` or `origin`. */
      sitePath: view.sitePath,
      contentType: OG_CONTENT_TYPE,
      render,
      ...createPlateHandlers(render),
    };
  });
}

/**
 * Maps `socialImageMetadata(...).twitter` onto Next's `Metadata.twitter` for
 * every X Card: summary cards pass through, a player card becomes `players`,
 * and an app card becomes `app` plus `description`. Throws instead of
 * dropping what Next cannot express: a player without `stream`, an app with
 * `country`, or per-platform app names that differ.
 */
export function nextTwitterMetadata(
  twitter: XCardMetadata,
): NonNullable<Metadata["twitter"]> {
  return nextTwitterShape(twitter);
}
