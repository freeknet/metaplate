import {
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
import { socialImageVersion } from "../metadata/image-version.js";
import type { OpenGraphMediaOptions } from "../metadata/og-media.js";
import { createImageSigner, signingSecrets, type ImageSigningKeys } from "../metadata/signing.js";

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
 * What a plate `component` returns: an element tree, or a promise of one so
 * the component can load per-page data (an avatar, a cover image) itself.
 */
export type PlateElement<Element> = Element | PromiseLike<Element>;

/**
 * True for a component result that must be awaited. Checking first lets a
 * synchronous component render without an extra microtask per card.
 */
export function isPendingElement<Element>(
  element: PlateElement<Element>,
): element is PromiseLike<Element> {
  return typeof (element as { then?: unknown } | null | undefined)?.then === "function";
}

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

/**
 * Verifies a signed image path before a resolver or renderer runs. `secret` or
 * `secrets` (newest first) are the HMAC keys `signedMetadata` signed with; see
 * docs/signed-routes.md.
 */
export type SignedRouteOptions<Arguments extends unknown[] = unknown[]> = ImageSigningKeys & {
  /**
   * Status for a missing or invalid signature: 403 (default) or 404 to avoid
   * revealing that the route exists. Either is sent with `Cache-Control:
   * no-store` and never with the plate's `headers`.
   */
  status?: 403 | 404;
  /**
   * The public URL (or pathname) the request was made for. Defaults to the
   * `url` of the first handler argument when it is a `Request`, or of its
   * `request` property (SvelteKit, Astro, React Router). Supply it when a
   * rewrite or proxy changes the path the handler sees.
   */
  url?: (...arguments_: Arguments) => string | URL;
};

/** Options for `handlerFrom` and `fetchableFrom`. */
export type PlateRouteOptions<Arguments extends unknown[] = unknown[]> = {
  /** Refuse to resolve or render unless the request path carries a valid signature. */
  signed?: SignedRouteOptions<Arguments>;
};

function isRequestLike(value: unknown): value is { url: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { url?: unknown }).url === "string" &&
    typeof (value as { method?: unknown }).method === "string"
  );
}

function requestUrl(arguments_: readonly unknown[]): string {
  const [first] = arguments_;
  if (isRequestLike(first)) return first.url;
  const request = (first as { request?: unknown } | null | undefined)?.request;
  if (isRequestLike(request)) return request.url;
  throw new TypeError(
    "A signed image route needs the request URL, but its first argument is neither a Request " +
      "nor an object with a request property; pass signed.url to supply it",
  );
}

/**
 * Builds the pre-render check for one route. Secrets are validated here, when
 * the route is defined, and imported as keys once, on the first request.
 */
export function signatureGate<Arguments extends unknown[]>(options: SignedRouteOptions<Arguments> | undefined) {
  if (options === undefined) return undefined;
  const signer = createImageSigner(signingSecrets(options));
  const status = options.status ?? 403;
  if (status !== 403 && status !== 404) {
    throw new TypeError(`signed.status must be 403 or 404; received ${String(status)}`);
  }
  const urlOf = options.url ?? ((...arguments_: Arguments) => requestUrl(arguments_));
  return async (arguments_: Arguments): Promise<Response | undefined> => {
    const verification = await signer.verify(urlOf(...arguments_));
    if (verification.valid) return undefined;
    return new Response(status === 404 ? "Not Found" : "Forbidden", {
      status,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  };
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

/** Shared fixed-copy, resolver, and Fetchable handlers for route adapters. */
export function createPlateHandlers<Copy, Result>(
  render: (copy: Copy) => Promise<Result>,
) {
  function route<Arguments extends unknown[]>(
    resolve: (...arguments_: Arguments) => Copy | Promise<Copy>,
    options: PlateRouteOptions<Arguments> | undefined,
  ) {
    const gate = signatureGate(options?.signed);
    if (gate === undefined) {
      return async (...arguments_: Arguments): Promise<Result | Response> =>
        render(await resolve(...arguments_));
    }
    return async (...arguments_: Arguments): Promise<Result | Response> =>
      (await gate(arguments_)) ?? render(await resolve(...arguments_));
  }

  return Object.freeze({
    handler: (copy: Copy) => () => render(copy),
    handlerFrom: <Arguments extends unknown[]>(
      resolve: (...arguments_: Arguments) => Copy | Promise<Copy>,
      options?: PlateRouteOptions<Arguments>,
    ) => route(resolve, options),
    fetchable: (copy: Copy) => ({
      fetch: () => render(copy),
    }),
    fetchableFrom: <Arguments extends unknown[]>(
      resolve: (...arguments_: Arguments) => Copy | Promise<Copy>,
      options?: PlateRouteOptions<Arguments>,
    ) => ({
      fetch: route(resolve, options),
    }),
  });
}
