import { createHash } from "node:crypto";
import { loadPeerPair } from "./optional-peer.js";
import { createPlateHandlers } from "./plate.js";
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

export type NodeOgDefinition<Copy> = SvgOgDefinition<Copy> & {
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
export function createNodeOg<Copy>(definition: NodeOgDefinition<Copy>) {
  const plate = createRasterPlate(definition, {
    satori: loadSatori,
    async rasterize(source, read) {
      // Both peers resolve before rendering so an install missing both is told
      // to add both, rather than reporting them one run at a time.
      const [, Resvg] = await loadPeerPair(loadSatori, loadResvg, "metaplate/node");
      return read(new Resvg(await source(), definition.resvg).render());
    },
    etag: strongEtag,
  });

  return Object.freeze({
    ...plate,
    ...createPlateHandlers(plate.response),
  });
}
