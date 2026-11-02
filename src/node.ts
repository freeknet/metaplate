import { createHash } from "node:crypto";
import { loadPeerPair } from "./optional-peer.js";
import { createPlateHandlers, createPlateViews } from "./plate.js";
import { loadResvg, loadSatori } from "./peers.js";
import {
  createRasterPlate,
  type OutputEncoder,
  type ResvgRenderOptions,
} from "./raster.js";
import type { SvgOgDefinition } from "./render.js";

export type {
  EncoderFormat,
  OutputEncoder,
  RenderedPixels,
  ResvgRenderOptions,
} from "./raster.js";

export type {
  PlateContext,
  PlateMetadataOptions,
  PlateUrlOptions,
  PlateVariant,
  PlateVariants,
  PlateVersioning,
  PlateView,
} from "./plate.js";

/** The render-module contract `metaplate render` loads; see docs/render-cli.md. */
export type {
  RenderablePlate,
  RenderFileArtifact,
  RenderJob,
  RenderModule,
  RenderPage,
} from "./render-files.js";

export type NodeOgDefinition<Copy, Variant extends string = string> = SvgOgDefinition<Copy, Variant> & {
  /** Resvg rendering controls such as background and font configuration. */
  resvg?: ResvgRenderOptions;
  /** Headers added to Web Responses returned by `response` and `handler`. */
  headers?: HeadersInit;
  /** Encodes something other than PNG, and declares what that something is. */
  output?: OutputEncoder;
  /** Adds a strong ETag derived from the final encoded bytes to responses. */
  etag?: boolean | "sha256";
};

function strongEtag(bytes: Uint8Array): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

/**
 * Defines a Node renderer that emits image bytes and Fetch API Responses for
 * Astro, SvelteKit, Remix, Express adapters, build scripts, and other runtimes.
 */
export function createNodeOg<Copy, Variant extends string = string>(
  definition: NodeOgDefinition<Copy, Variant>,
) {
  const raster = createRasterPlate(definition, {
    satori: loadSatori,
    async rasterize(source, read) {
      // Both peers resolve before rendering so an install missing both is told
      // to add both, rather than reporting them one run at a time.
      const [, Resvg] = await loadPeerPair(loadSatori, loadResvg, "metaplate/node");
      return read(new Resvg(await source(), definition.resvg).render());
    },
    etag: strongEtag,
  });

  return createPlateViews(raster.variants, (name) => {
    const view = raster.view(name);
    return { ...view, ...createPlateHandlers(view.response) };
  });
}

export {
  REMOTE_FETCH_DEFAULTS,
  REMOTE_USER_AGENT,
  RemoteImageError,
  fetchRemoteImage,
  verifyRemoteImage,
  type RemoteAddress,
  type RemoteFetchOptions,
  type RemoteImage,
  type RemoteImageErrorCode,
  type RemoteImageExpectation,
  type RemoteImageVerification,
  type RemoteResolver,
} from "./remote.js";

export {
  REMOTE_PAGE_DEFAULTS,
  verifyRemotePage,
  type RemotePageDeclaredImage,
  type RemotePageImageIssueCode,
  type RemotePageImageReport,
  type RemotePageImageSource,
  type RemotePageIssue,
  type RemotePageIssueCode,
  type RemotePageIssueSeverity,
  type RemotePageOptions,
  type RemotePageTargetReport,
  type RemotePageVerification,
} from "./page-verification.js";

export {
  extractPageSocialMetadata,
  type PageJsonLdImage,
  type PageMetadataIssue,
  type PageMetadataIssueCode,
  type PageOpenGraphImage,
  type PageSocialMetadata,
} from "./html-metadata.js";
