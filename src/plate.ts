import {
  OG_SIZE,
  assertImageSize,
  assertVariantName,
  socialImage,
  socialImageMetadata,
  socialImagePath,
  variantImagePath,
  type ImageSize,
  type SocialImageOptions,
  type SocialImageVariantOptions,
} from "./core.js";
import { socialImageVersion } from "./image-version.js";
import type { OpenGraphMediaOptions } from "./og-media.js";

/**
 * The second argument every plate `component` receives. `variant` is
 * `undefined` for the default size and the variant's name otherwise; `size`
 * is the exact canvas the render uses, so a layout can reflow per size rather
 * than being cropped or scaled after the fact.
 */
export type PlateContext<Variant extends string = string> = Readonly<{
  variant: Variant | undefined;
  size: ImageSize;
}>;

/**
 * One additional size a plate renders from the same copy. `imagePath`
 * defaults to the plate's `imagePath` with `-<name>` inserted before the
 * extension (`og-image.png` becomes `og-image-square.png`).
 */
export type PlateVariant<Copy> = {
  size: ImageSize;
  imagePath?: string;
  /** Alternative text for this size; defaults to the plate's `alt`. */
  alt?: (copy: Copy) => string;
};

/** Named size variants, in the order their `og:image` entries are emitted. */
export type PlateVariants<Copy, Variant extends string = string> = {
  readonly [Name in Variant]: PlateVariant<Copy>;
};

/**
 * Per-call image URL options for a plate's `image`, `metadata`, and
 * `artifact`.
 */
export type PlateUrlOptions = {
  /**
   * An explicit cache-busting token for this call's image URLs, emitted as
   * `?v=<version>`. Overrides a token the plate's `version: "copy"` would
   * derive. 1 to 64 characters from `A-Z a-z 0-9 . _ ~ -`.
   */
  version?: string;
};

/**
 * Plate-level cache busting. With `version: "copy"`, every image URL the
 * plate publishes in metadata gains `?v=<token>`, where the token is
 * `socialImageVersion(copy, revision)`: a short hash of the card's copy and
 * the plate's `revision`. File paths (`sitePath`, `metaplate render`
 * output) never carry it.
 */
export type PlateVersioning = {
  /** `"copy"` derives each card's URL version from its copy and `revision`. */
  version?: "copy";
  /**
   * The design's revision, folded into every derived version. Bump it when
   * the component changes how existing copy looks, so unchanged copy still
   * gets new URLs. Requires `version: "copy"`.
   */
  revision?: string;
};

/** Per-call metadata options for a plate. */
export type PlateMetadataOptions<Variant extends string = string> = PlateUrlOptions & {
  /**
   * Open Graph video and audio for this page, carried onto
   * `metadata.openGraph.videos` and `.audio` (see `OpenGraphMediaOptions`).
   */
  media?: OpenGraphMediaOptions;
  /** Selects a declared variant as the X Card image instead of the default. */
  twitter?: { variant?: Variant };
};

type PlateSocialDefinition<Copy, Variant extends string> = {
  alt: (copy: Copy) => string;
  size?: ImageSize;
  imagePath?: string;
  basePath?: string;
  origin?: string;
  variants?: PlateVariants<Copy, Variant>;
} & PlateVersioning;

/**
 * Validates plate-level versioning once, at definition, and returns the
 * per-call resolver: an explicit `version` wins, then a copy-derived one.
 */
function plateVersion<Copy>(definition: PlateVersioning) {
  const { version: mode, revision } = definition;
  if (mode !== undefined && mode !== "copy") {
    throw new Error(`Invalid version: a plate's version must be "copy"; received ${JSON.stringify(mode)}`);
  }
  if (revision !== undefined) {
    if (typeof revision !== "string" || revision === "") {
      throw new Error(`Invalid revision: expected a non-empty string; received ${JSON.stringify(revision)}`);
    }
    if (mode !== "copy") throw new Error('revision requires version: "copy"');
  }
  return (copy: Copy, options: PlateUrlOptions | undefined): Pick<SocialImageOptions, "version"> => {
    const version = options?.version ?? (mode === "copy" ? socialImageVersion(copy, revision) : undefined);
    return version === undefined ? {} : { version };
  };
}

/** Forwards per-call media only when supplied, keeping media-free output unchanged. */
function mediaOption(options: PlateMetadataOptions | undefined): Pick<SocialImageOptions, "media"> {
  return options?.media === undefined ? {} : { media: options.media };
}

type ResolvedVariant<Copy, Variant extends string> = Readonly<{
  context: PlateContext<Variant>;
  imagePath: string;
  alt: (copy: Copy) => string;
}>;

/**
 * Resolves and validates every declared variant at plate creation, so a bad
 * name, size, path, or URL collision fails at definition rather than on the
 * first crawler request.
 */
function resolveVariants<Copy, Variant extends string>(
  definition: PlateSocialDefinition<Copy, Variant>,
  imagePath: string,
): ReadonlyMap<Variant, ResolvedVariant<Copy, Variant>> {
  const resolved = new Map<Variant, ResolvedVariant<Copy, Variant>>();
  const paths = new Set([socialImagePath("/", imagePath)]);
  const entries = Object.entries(definition.variants ?? {}) as [Variant, PlateVariant<Copy>][];
  for (const [name, variant] of entries) {
    assertVariantName(name);
    const size = Object.freeze({ width: variant.size.width, height: variant.size.height });
    assertImageSize(size);
    const path = variant.imagePath ?? variantImagePath(imagePath, name);
    const normalized = socialImagePath("/", path);
    if (paths.has(normalized)) {
      throw new Error(`Variant "${name}" imagePath ${path} is already used by another size`);
    }
    paths.add(normalized);
    resolved.set(name, Object.freeze({
      context: Object.freeze({ variant: name, size }),
      imagePath: path,
      alt: variant.alt ?? definition.alt,
    }));
  }
  return resolved;
}

/** Shared size/path/metadata contract used by every renderer adapter. */
export function createPlateSocial<Copy, Variant extends string = string>(
  definition: PlateSocialDefinition<Copy, Variant>,
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
  const variants = resolveVariants(definition, options.imagePath);
  const versionFor = plateVersion<Copy>(definition);
  const defaultContext: PlateContext<Variant> = Object.freeze({ variant: undefined, size });

  /**
   * Where a size's image lives relative to the deployment root: `route`
   * joined with that size's `imagePath`, without `basePath` or `origin`, and
   * without a leading slash. It is the path a static build writes the file
   * to, so the metadata URL resolves to it once the output is deployed under
   * `basePath`.
   */
  const sitePathFor = (path: string) => (route: string) => socialImagePath(route, path).slice(1);

  function variantOptions(copy: Copy): Pick<SocialImageOptions, "variants"> {
    if (variants.size === 0) return {};
    const entries: [string, SocialImageVariantOptions][] = [];
    for (const [name, variant] of variants) {
      entries.push([name, {
        size: variant.context.size,
        imagePath: variant.imagePath,
        alt: variant.alt(copy),
      }]);
    }
    return { variants: Object.fromEntries(entries) };
  }

  /** The default size: page metadata lists every variant after it. */
  const defaultView = Object.freeze({
    context: defaultContext,
    image: (route: string, copy: Copy, urlOptions?: PlateUrlOptions) =>
      socialImage(route, definition.alt(copy), { ...options, ...versionFor(copy, urlOptions) }),
    metadata: (route: string, copy: Copy, metadataOptions?: PlateMetadataOptions<Variant>) => {
      const twitterVariant = metadataOptions?.twitter?.variant;
      return socialImageMetadata(route, definition.alt(copy), {
        ...options,
        ...variantOptions(copy),
        ...versionFor(copy, metadataOptions),
        ...(twitterVariant === undefined ? {} : { twitter: { variant: twitterVariant } }),
        ...mediaOption(metadataOptions),
      });
    },
    /** Metadata describing only this size, as an artifact's bytes do. */
    ownMetadata: (route: string, copy: Copy, urlOptions?: PlateUrlOptions) =>
      socialImageMetadata(route, definition.alt(copy), { ...options, ...versionFor(copy, urlOptions) }),
    sitePath: sitePathFor(options.imagePath),
  });

  function variantView(name: Variant) {
    const variant = variants.get(name);
    if (!variant) {
      const declared = [...variants.keys()].join(", ") || "none";
      throw new Error(`Unknown plate variant: ${name} (declared: ${declared})`);
    }
    const sizeOptions = Object.freeze({
      ...options,
      size: variant.context.size,
      imagePath: variant.imagePath,
    });
    const ownMetadata = (route: string, copy: Copy, urlOptions?: PlateUrlOptions) =>
      socialImageMetadata(route, variant.alt(copy), { ...sizeOptions, ...versionFor(copy, urlOptions) });
    return Object.freeze({
      context: variant.context,
      image: (route: string, copy: Copy, urlOptions?: PlateUrlOptions) =>
        socialImage(route, variant.alt(copy), { ...sizeOptions, ...versionFor(copy, urlOptions) }),
      metadata: (route: string, copy: Copy, metadataOptions?: PlateMetadataOptions<Variant>) => {
        const twitterVariant = metadataOptions?.twitter?.variant;
        if (twitterVariant !== undefined && twitterVariant !== name) {
          throw new Error(
            `plate.variant("${name}") describes only its own size; select twitter.variant on the default plate`,
          );
        }
        return socialImageMetadata(route, variant.alt(copy), {
          ...sizeOptions,
          ...versionFor(copy, metadataOptions),
          ...mediaOption(metadataOptions),
        });
      },
      ownMetadata,
      sitePath: sitePathFor(variant.imagePath),
    });
  }

  return Object.freeze({
    size,
    variants: Object.freeze([...variants.keys()]),
    view: (name: Variant | undefined) =>
      name === undefined ? defaultView : variantView(name),
  });
}

/** The surface every size of a plate shares, plus navigation between sizes. */
export type PlateView<Surface, Variant extends string> = Readonly<Surface> & {
  /** The variant this view renders; `undefined` for the default size. */
  readonly variantName: Variant | undefined;
  /** Declared variant names, in declaration order (the default is unnamed). */
  readonly variants: readonly Variant[];
  /** The same plate bound to a declared variant's size, path, and alt. */
  readonly variant: (name: Variant) => PlateView<Surface, Variant>;
};

/**
 * Builds the default view and memoized variant views from one surface
 * factory, so every adapter exposes an identical surface for every size.
 */
export function createPlateViews<Surface extends object, Variant extends string>(
  names: readonly Variant[],
  build: (variant: Variant | undefined) => Surface,
): PlateView<Surface, Variant> {
  const views = new Map<Variant, PlateView<Surface, Variant>>();
  const variant = (name: Variant): PlateView<Surface, Variant> => {
    const existing = views.get(name);
    if (existing) return existing;
    const view = decorate(build(name), name);
    views.set(name, view);
    return view;
  };
  const decorate = (surface: Surface, name: Variant | undefined) =>
    Object.freeze({ ...surface, variantName: name, variants: names, variant });
  return decorate(build(undefined), undefined);
}

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
