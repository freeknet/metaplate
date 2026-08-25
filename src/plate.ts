import {
  OG_SIZE,
  assertImageSize,
  socialImage,
  socialImageMetadata,
  type ImageSize,
} from "./core.js";

type PlateSocialDefinition<Copy> = {
  alt: (copy: Copy) => string;
  size?: ImageSize;
  imagePath?: string;
  basePath?: string;
  origin?: string;
};

/** Shared size/path/metadata contract used by every renderer adapter. */
export function createPlateSocial<Copy>(
  definition: PlateSocialDefinition<Copy>,
  contentType: string,
  resolvedSize?: ImageSize,
) {
  const size = resolvedSize ?? Object.freeze({ ...(definition.size ?? OG_SIZE) });
  assertImageSize(size);
  const options = Object.freeze({
    size,
    imagePath: definition.imagePath ?? "og-image",
    basePath: definition.basePath ?? "",
    origin: definition.origin ?? "",
    type: contentType,
  });

  return Object.freeze({
    size,
    image: (route: string, copy: Copy) =>
      socialImage(route, definition.alt(copy), options),
    metadata: (route: string, copy: Copy) =>
      socialImageMetadata(route, definition.alt(copy), options),
  });
}

/** Shared fixed-copy and argument-resolver handlers used by route adapters. */
export type FetchableHandler<Result> = {
  fetch: (...arguments_: unknown[]) => Promise<Result>;
};

/** Shared fixed-copy, resolver, and Fetchable handlers for route adapters. */
export function createPlateHandlers<Copy, Result>(
  render: (copy: Copy) => Promise<Result>,
) {
  return Object.freeze({
    handler: (copy: Copy) => () => render(copy),
    handlerFrom: <Arguments extends unknown[]>(
      resolve: (...arguments_: Arguments) => Copy | Promise<Copy>,
    ) =>
      async (...arguments_: Arguments) => render(await resolve(...arguments_)),
    fetchable: (copy: Copy) => ({
      fetch: () => render(copy),
    }),
    fetchableFrom: <Arguments extends unknown[]>(
      resolve: (...arguments_: Arguments) => Copy | Promise<Copy>,
    ) => ({
      fetch: async (...arguments_: Arguments) => render(await resolve(...arguments_)),
    }),
  });
}
