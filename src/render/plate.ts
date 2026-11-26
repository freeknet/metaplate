import { createImageSigner, signingSecrets, type ImageSigningKeys } from "../metadata/signing.js";

// The URL and metadata half of a plate lives in the renderer-free contract
// module, so `definePlate` in the root entry and every renderer adapter share
// one implementation. Re-exported here for the adapters' existing imports.
export {
  assertContractContentType,
  createPlateSocial,
  signPlateMetadata,
  type PlateContext,
  type PlateContractDefinition,
  type PlateMetadataOptions,
  type PlateUrlOptions,
  type PlateVariant,
  type PlateVariants,
  type PlateVersioning,
} from "../metadata/plate-contract.js";

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
