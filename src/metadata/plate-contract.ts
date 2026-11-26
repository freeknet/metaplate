import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  assertImageSize,
  assertVariantName,
  socialImage,
  socialImageMetadata,
  socialImagePath,
  variantImagePath,
  type ImageSize,
  type SocialImageDescriptor,
  type SocialImageMetadata,
  type SocialImageOptions,
  type SocialImageVariantOptions,
  type XCard,
} from "../core/social-image.js";
import { socialImageVersion } from "./image-version.js";
import { isMediaType, type OpenGraphMediaOptions } from "./og-media.js";
import { createImageSigner, signingSecrets, type ImageSigningKeys } from "./signing.js";

/**
 * A plate's URL and metadata contract: everything that decides the image URLs
 * and metadata a page publishes, and nothing that renders. This module is
 * renderer-free (no Satori, Resvg, React, Next, or Takumi), so the root entry
 * can export `definePlate` and every renderer adapter delegates to the same
 * `createPlateSocial`.
 */

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
   * Names the design's current version, such as a release number or a hash
   * of the plate's source files. Bump it when the design changes in a way the
   * plate cannot see for itself, such as a helper the component imports or a
   * theme it closes over. It is part of `fingerprint()` on `metaplate/node`
   * and `metaplate/edge` plates, so a bump invalidates `cached()` entries and
   * `metaplate render --incremental` reuse; with `version: "copy"` it is also
   * folded into every derived URL version, so unchanged copy gets new URLs.
   * Valid with or without `version`.
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

/**
 * The options of a plate definition that decide its image URLs and metadata.
 * `definePlate` takes exactly these; every renderer's definition includes
 * them, so `createNodeOg({ ...plate, fonts, component })` publishes the same
 * URLs as the contract it was spread from.
 */
export type PlateContractDefinition<Copy, Variant extends string = string> = {
  /** Alternative text for the image, derived from the same copy. */
  alt: (copy: Copy) => string;
  /** The default canvas; `OG_SIZE` (1200x630) when omitted. */
  size?: ImageSize;
  /** Additional named sizes, listed in metadata after the default. */
  variants?: PlateVariants<Copy, Variant>;
  /** The file name under each route; `"og-image"` when omitted. */
  imagePath?: string;
  /** A deployment prefix for published URLs. File paths never include it. */
  basePath?: string;
  /** Scheme and host for absolute image URLs, such as `https://example.com`. */
  origin?: string;
  /**
   * The media type the plate's images are served as, published as
   * `og:image:type`. `definePlate` defaults it to `image/png`. A renderer
   * given a definition with `contentType` throws at definition unless it
   * produces exactly that type, so metadata built from the contract cannot
   * describe a format the renderer does not emit.
   */
  contentType?: string;
} & PlateVersioning;

/**
 * Fails a renderer whose output differs from the type its contract publishes.
 * Each adapter calls it once with the type it serves; `createPlateSocial`
 * cannot, because raster plates also build an SVG layout plate internally.
 */
export function assertContractContentType(declared: string | undefined, produced: string): void {
  if (declared === undefined || declared === produced) return;
  throw new TypeError(
    `The plate's contentType is ${declared}, but this renderer produces ${produced}. ` +
      `Set contentType: ${JSON.stringify(produced)} where the plate is defined (definePlate) ` +
      "so its metadata describes the bytes the renderer emits.",
  );
}

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
  definition: PlateContractDefinition<Copy, Variant>,
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

/**
 * `metadata` with every image URL signed for a signed dynamic route. Async
 * because Web Crypto is. Static files (`metaplate render`, `sitePath`) are
 * served unsigned, so pages pointing at them use `metadata` instead.
 */
function signedMetadataFor<Copy, Variant extends string, Metadata extends SocialImageMetadata<XCard>>(
  metadata: (route: string, copy: Copy, options?: PlateMetadataOptions<Variant>) => Metadata,
) {
  return (route: string, copy: Copy, keys: ImageSigningKeys, options?: PlateMetadataOptions<Variant>) =>
    signPlateMetadata(metadata(route, copy, options), keys);
}

/**
 * The size, path, and metadata contract: the one implementation behind
 * `definePlate` and every renderer adapter. `contentType` is the type the
 * caller serves; a definition that declares a different one is refused.
 */
export function createPlateSocial<Copy, Variant extends string = string>(
  definition: PlateContractDefinition<Copy, Variant>,
  contentType: string,
) {
  const size = Object.freeze({ ...(definition.size ?? OG_SIZE) });
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
  const defaultMetadata = (route: string, copy: Copy, metadataOptions?: PlateMetadataOptions<Variant>) => {
    const twitterVariant = metadataOptions?.twitter?.variant;
    return socialImageMetadata(route, definition.alt(copy), {
      ...options,
      ...variantOptions(copy),
      ...versionFor(copy, metadataOptions),
      ...(twitterVariant === undefined ? {} : { twitter: { variant: twitterVariant } }),
      ...mediaOption(metadataOptions),
    });
  };
  const defaultView = Object.freeze({
    context: defaultContext,
    image: (route: string, copy: Copy, urlOptions?: PlateUrlOptions) =>
      socialImage(route, definition.alt(copy), { ...options, ...versionFor(copy, urlOptions) }),
    metadata: defaultMetadata,
    signedMetadata: signedMetadataFor(defaultMetadata),
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
    const metadata = (route: string, copy: Copy, metadataOptions?: PlateMetadataOptions<Variant>) => {
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
    };
    return Object.freeze({
      context: variant.context,
      image: (route: string, copy: Copy, urlOptions?: PlateUrlOptions) =>
        socialImage(route, variant.alt(copy), { ...sizeOptions, ...versionFor(copy, urlOptions) }),
      metadata,
      signedMetadata: signedMetadataFor(metadata),
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

/**
 * Signs every image URL in plate metadata: the Open Graph images and the X
 * Card image (normally one of them, so each distinct URL is signed once).
 */
export async function signPlateMetadata<Metadata extends SocialImageMetadata<XCard>>(
  metadata: Metadata,
  keys: ImageSigningKeys,
): Promise<Metadata> {
  const signer = createImageSigner(signingSecrets(keys));
  const signed = new Map<string, Promise<string>>();
  const sign = async (image: SocialImageDescriptor): Promise<SocialImageDescriptor> => {
    let url = signed.get(image.url);
    if (url === undefined) {
      url = signer.sign(image.url);
      signed.set(image.url, url);
    }
    return { ...image, url: await url };
  };
  const [openGraphImages, twitterImages] = await Promise.all([
    Promise.all(metadata.openGraph.images.map(sign)),
    Promise.all(metadata.twitter.images.map(sign)),
  ]);
  return {
    ...metadata,
    openGraph: { ...metadata.openGraph, images: openGraphImages },
    twitter: { ...metadata.twitter, images: twitterImages },
  };
}

type SocialView<Copy, Variant extends string> = ReturnType<
  ReturnType<typeof createPlateSocial<Copy, Variant>>["view"]
>;

/**
 * One size of a plate contract: the URL and metadata surface a renderer's
 * plate has for the same size, with nothing that renders.
 */
export type PlateContractView<Copy, Variant extends string = string> = {
  /** The variant this view describes; `undefined` for the default size. */
  readonly variantName: Variant | undefined;
  /** This size's canvas. */
  readonly size: ImageSize;
  /** The media type published as `og:image:type`. */
  readonly contentType: string;
  /** This size's image descriptor (URL, size, type, alt). */
  readonly image: SocialView<Copy, Variant>["image"];
  /**
   * Open Graph and X Card metadata for `route`, identical to the `metadata`
   * of a renderer's plate built from the same contract.
   */
  readonly metadata: SocialView<Copy, Variant>["metadata"];
  /** `metadata` with every image URL signed; see docs/signed-routes.md. */
  readonly signedMetadata: SocialView<Copy, Variant>["signedMetadata"];
  /** The image path relative to the deployment root, without `basePath` or `origin`. */
  readonly sitePath: SocialView<Copy, Variant>["sitePath"];
};

/**
 * A plate's URL and metadata contract, from `definePlate`. Its own
 * enumerable properties are the contract options and nothing else, so
 * `{ ...plate, fonts, component }` is a renderer definition; the URL and
 * metadata methods are non-enumerable and stay behind.
 */
export type PlateContract<Copy, Variant extends string = string> = Readonly<
  PlateContractDefinition<Copy, Variant> & { size: ImageSize; contentType: string }
> &
  PlateContractView<Copy, Variant> & {
    /** The same contract bound to a declared variant's size, path, and alt. */
    readonly variant: (name: Variant) => PlateContractView<Copy, Variant>;
  };

const CONTRACT_KEYS = [
  "alt",
  "size",
  "variants",
  "imagePath",
  "basePath",
  "origin",
  "contentType",
  "version",
  "revision",
] as const satisfies readonly (keyof PlateContractDefinition<unknown>)[];

/**
 * Defines a plate's URL and metadata contract without a renderer: the options
 * that decide its image URLs (`imagePath`, `size`, `variants`, `basePath`,
 * `origin`, `version`, `revision`, `contentType`) and its `alt`. Pages import
 * the contract for `metadata` and `sitePath`; only the build imports a
 * renderer, and spreads the contract into it:
 *
 * ```ts
 * const og = createNodeOg({ ...plate, fonts, component });
 * ```
 *
 * Both run the same code, so `plate.metadata(route, copy, options)` equals
 * `og.metadata(route, copy, options)` for every option. Validated like a
 * renderer's plate, at definition.
 */
export function definePlate<Copy, Variant extends string = string>(
  definition: PlateContractDefinition<Copy, Variant>,
): PlateContract<Copy, Variant> {
  if (typeof definition.alt !== "function") {
    throw new TypeError("definePlate needs alt: (copy) => string");
  }
  const contentType = definition.contentType ?? OG_CONTENT_TYPE;
  if (typeof contentType !== "string" || !isMediaType(contentType)) {
    throw new TypeError(`Invalid contentType: ${String(contentType)}`);
  }
  const social = createPlateSocial(definition, contentType);

  const surface = (name: Variant | undefined): PlateContractView<Copy, Variant> => {
    const view = social.view(name);
    return {
      variantName: name,
      size: view.context.size,
      contentType,
      image: view.image,
      metadata: view.metadata,
      signedMetadata: view.signedMetadata,
      sitePath: view.sitePath,
    };
  };
  const views = new Map<Variant, PlateContractView<Copy, Variant>>();
  const variant = (name: Variant): PlateContractView<Copy, Variant> => {
    let view = views.get(name);
    if (view === undefined) {
      view = Object.freeze(surface(name));
      views.set(name, view);
    }
    return view;
  };

  // Only the contract options are enumerable, so spreading the contract into
  // a renderer carries exactly what decides the URLs. The defaulted size and
  // content type are written out, which pins them for the renderer too.
  const contract: Record<string, unknown> = {};
  for (const key of CONTRACT_KEYS) {
    if (definition[key] !== undefined) contract[key] = definition[key];
  }
  contract.size = social.size;
  contract.contentType = contentType;
  const methods = { ...surface(undefined), variant };
  for (const [key, value] of Object.entries(methods)) {
    if (key in contract) continue;
    Object.defineProperty(contract, key, { value, enumerable: false });
  }
  return Object.freeze(contract) as PlateContract<Copy, Variant>;
}
