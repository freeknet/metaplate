import { createHash } from "node:crypto";
import { loadPeerPair } from "../core/optional-peer.js";
import { createPlateHandlers, createPlateViews } from "./plate.js";
import { loadResvg, loadSatori } from "../core/peers.js";
import {
  createRasterPlate,
  type OutputEncoder,
  type ResvgRenderOptions,
} from "./raster.js";
import type { RasterRenderGuards } from "./guards.js";
import type { SvgOgDefinition } from "./svg.js";

export {
  RenderGuardError,
  type RasterRenderGuards,
  type RenderGuardBox,
  type RenderGuardIssue,
  type RenderGuardLevel,
  type RenderGuardName,
  type RenderGuards,
  type AvoidGuard,
  type SafeAreaGuard,
} from "./guards.js";

export type {
  EncoderFormat,
  OutputEncoder,
  RenderedPixels,
  ResvgRenderOptions,
} from "./raster.js";

/**
 * Metaplate's `satori` option and what it hands `onNodeDetected`. Type a
 * plate's `satori` with these, not Satori's own `SatoriOptions`, which also
 * requires the width, height, and fonts that Metaplate sets.
 */
export type { SatoriFont, SatoriLayoutNode, SatoriNode, SatoriOptions } from "./svg.js";

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

export {
  MEMORY_RENDER_CACHE_DEFAULTS,
  memoryRenderCache,
  type CachedPlate,
  type MemoryRenderCache,
  type MemoryRenderCacheOptions,
  type RenderCacheEntry,
  type RenderCacheOptions,
  type RenderCacheStore,
} from "./cache.js";

/** The render-module contract `metaplate render` loads; see docs/render-cli.md. */
export type {
  RenderablePlate,
  RenderFileArtifact,
  RenderJob,
  RenderModule,
  RenderPage,
} from "./files.js";

export type NodeOgDefinition<Copy, Variant extends string = string> = SvgOgDefinition<Copy, Variant> & {
  /** Resvg rendering controls such as background and font configuration. */
  resvg?: ResvgRenderOptions;
  /** Headers added to Web Responses returned by `response` and `handler`. */
  headers?: HeadersInit;
  /** Encodes something other than PNG, and declares what that something is. */
  output?: OutputEncoder;
  /** Adds a strong ETag derived from the final encoded bytes to responses. */
  etag?: boolean | "sha256";
  /**
   * Render guards, plus `blank`, which fails or reports a rasterised image
   * whose every pixel is one color. All off by default.
   */
  guards?: RasterRenderGuards;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
    sha256,
    renderer: "node",
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
} from "../verify/remote.js";

export {
  CRAWLER_HTML_LIMITS,
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
} from "../verify/page-verification.js";

export {
  REMOTE_ROBOTS_DEFAULTS,
  type RemotePageCrawlerCheck,
  type RemotePageCrawlerReport,
  type RemotePageRobotsFile,
  type RemotePageRobotsReport,
  type RemotePageRobotsStatus,
  type RobotsIssueCode,
} from "../verify/page-crawlers.js";

export {
  evaluateRobots,
  isRobotsProductToken,
  parseRobotsTxt,
  type RobotsDecision,
  type RobotsGroup,
  type RobotsGroupMatch,
  type RobotsRule,
  type RobotsTxt,
} from "../verify/robots.js";

export {
  SOCIAL_CRAWLERS,
  findSocialCrawler,
  type SocialCrawler,
  type SocialCrawlerRobotsPolicy,
} from "../verify/social-crawlers.js";

export {
  extractPageSocialMetadata,
  type PageJsonLdImage,
  type PageMetadataIssue,
  type PageMetadataIssueCode,
  type PageOpenGraphImage,
  type PageSocialMetadata,
} from "../verify/html-metadata.js";
