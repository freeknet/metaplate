import type { Metadata, Viewport } from "next";
import type { ReactElement } from "react";
import { OG_CONTENT_TYPE, type ImageSize, type XCardMetadata } from "./core.js";
import { assertAbsoluteMedia } from "./og-media.js";
import { optionalPeer } from "./optional-peer.js";
import type { ImageSigningKeys } from "./signing.js";
import { pageFields, type SocialMetaOptions } from "./page-tags.js";
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
  type PlateVersioning,
} from "./plate.js";

export type {
  PlateContext,
  PlateElement,
  PlateMetadataOptions,
  PlateRouteOptions,
  PlateUrlOptions,
  PlateVariant,
  PlateVariants,
  PlateVersioning,
  PlateView,
  SignedRouteOptions,
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
  /**
   * Not supported: `ImageResponse` exposes neither Satori's layout callbacks
   * nor the rendered pixels, so no render guard can run. Use `createNodeOg`
   * (for example in a route handler) when a card must be guarded.
   */
  guards?: never;
} & PlateVersioning;

/**
 * Defines one branded image system and returns the renderer, route handler,
 * and metadata helpers that consume it.
 */
export function createNextOg<Copy, Variant extends string = string>(
  definition: NextOgDefinition<Copy, Variant>,
) {
  if ((definition as { guards?: unknown }).guards !== undefined) {
    throw new TypeError(
      "metaplate/next cannot run render guards: next/og's ImageResponse exposes no layout " +
        "callbacks or pixels. Remove guards, or render through metaplate/node in a route handler.",
    );
  }
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
      /** `metadata` with every image URL signed for a `signed` route handler. */
      signedMetadata: async (
        route: string,
        copy: Copy,
        keys: ImageSigningKeys,
        options?: PlateMetadataOptions<Variant>,
      ) => {
        assertAbsoluteMedia(view.metadata(route, copy, options).openGraph, "metaplate/next");
        return view.signedMetadata(route, copy, keys, options);
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

type NextOpenGraph = NonNullable<Metadata["openGraph"]>;

/** The `og:type` values Next's `openGraph.type` accepts. */
export type NextOpenGraphType = Extract<NextOpenGraph, { type: string }>["type"];

/**
 * Next renders `og:type` from a closed switch and throws "Invalid OpenGraph
 * type" for anything else, so only these values can be mapped.
 */
export const NEXT_OPEN_GRAPH_TYPES = [
  "website",
  "article",
  "book",
  "profile",
  "music.song",
  "music.album",
  "music.playlist",
  "music.radio_station",
  "video.movie",
  "video.episode",
  "video.tv_show",
  "video.other",
] as const satisfies readonly NextOpenGraphType[];

function isNextOpenGraphType(type: string): type is NextOpenGraphType {
  return (NEXT_OPEN_GRAPH_TYPES as readonly string[]).includes(type);
}

/**
 * Maps the page-level fields `socialMetaTags` accepts onto Next's `Metadata`,
 * validated by the same rules: `title`, `description`, `url`, `siteName`,
 * `type`, `locale`, `alternateLocales` (as `alternateLocale`), and the
 * `article` fields go to `openGraph` under Next's names, and `pubdate`, which
 * Next has no field for, goes to `other` as `og:pubdate` (Next renders it with
 * a `name` attribute, which Discord reads). `openGraph` is omitted when no
 * field is set, so spreading the result never replaces a layout's
 * `openGraph` with an empty one. `themeColor` belongs to Next's `viewport`
 * export; see `nextPageViewport`.
 *
 * Next shallow-merges `openGraph`, so combine the result with the images in
 * one object: `openGraph: { ...page.openGraph, images: social.openGraph.images }`.
 *
 * @throws For the same inputs as `socialMetaTags`, or when `type` is not one
 *   of `NEXT_OPEN_GRAPH_TYPES`.
 */
export function nextPageMetadata(page: SocialMetaOptions): Pick<Metadata, "openGraph" | "other"> {
  const fields = pageFields(page);
  const { type, pubdate, alternateLocales } = fields;
  if (type !== undefined && !isNextOpenGraphType(type)) {
    throw new Error(
      `Next.js renders og:type only for ${NEXT_OPEN_GRAPH_TYPES.join(", ")}; received ${type}. Emit the tags with socialMetaTags instead.`,
    );
  }
  const openGraph: Record<string, unknown> = {};
  for (const key of ["title", "description", "url", "siteName", "type", "locale"] as const) {
    if (fields[key] !== undefined) openGraph[key] = fields[key];
  }
  if (alternateLocales !== undefined) openGraph.alternateLocale = alternateLocales;
  Object.assign(openGraph, fields.article);
  return {
    ...(Object.keys(openGraph).length > 0 ? { openGraph: openGraph as NextOpenGraph } : {}),
    ...(pubdate === undefined ? {} : { other: { "og:pubdate": pubdate } }),
  };
}

/**
 * Maps `themeColor` onto Next's `viewport` export, where Next 14 and later
 * expect it (`metadata.themeColor` is deprecated). Export the result as
 * `viewport`, or spread it into `generateViewport`'s return value.
 *
 * @throws For the same inputs as `socialMetaTags`.
 */
export function nextPageViewport(page: SocialMetaOptions): Pick<Viewport, "themeColor"> {
  const { themeColor } = pageFields(page);
  return themeColor === undefined ? {} : { themeColor };
}
