import { loadPeerPair } from "./optional-peer.js";
import { createPlateHandlers, createPlateViews } from "./plate.js";
import { loadResvgWasm, loadSatoriStandalone } from "./peers.js";
import {
  createRasterPlate,
  type ResvgRenderOptions,
} from "./raster.js";
import type { RasterRenderGuards } from "./guards.js";
import type { RenderCacheOptions } from "./render-cache.js";
import type { SvgOgDefinition } from "./render.js";
import { toHex } from "./stable-hash.js";
import type { SatoriRender } from "./svg-plate.js";

export type { RenderedPixels } from "./raster.js";

export {
  MEMORY_RENDER_CACHE_DEFAULTS,
  memoryRenderCache,
  type CachedPlate,
  type MemoryRenderCache,
  type MemoryRenderCacheOptions,
  type RenderCacheEntry,
  type RenderCacheOptions,
  type RenderCacheStore,
} from "./render-cache.js";

export {
  RenderGuardError,
  type RasterRenderGuards,
  type RenderGuardBox,
  type RenderGuardIssue,
  type RenderGuardLevel,
  type RenderGuardName,
  type RenderGuards,
} from "./guards.js";

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

/**
 * A compiled or compilable WebAssembly module: the module a bundler's
 * `import wasm from "…/index_bg.wasm"` yields, its bytes, a `Response` from
 * `fetch`, or a URL the runtime can `fetch`.
 */
export type EdgeWasmModule =
  | WebAssembly.Module
  | ArrayBuffer
  | ArrayBufferView
  | Response
  | URL;

/** A Wasm module, a promise of one, or a function that produces one on first render. */
export type EdgeWasmSource =
  | EdgeWasmModule
  | Promise<EdgeWasmModule>
  | (() => EdgeWasmModule | Promise<EdgeWasmModule>);

/**
 * Resvg controls for `@resvg/resvg-wasm`. `font` is absent because Satori
 * outlines text into paths before Resvg runs, and Resvg's font options name
 * file paths and system fonts that edge runtimes do not have.
 */
export type EdgeResvgOptions = Omit<ResvgRenderOptions, "font" | "logLevel"> & {
  /**
   * `@resvg/resvg-wasm/index_bg.wasm`. Edge runtimes cannot locate a package's
   * Wasm on their own, so the caller supplies it here or through
   * `initEdgeRenderer`.
   */
  wasm?: EdgeWasmSource;
};

export type EdgeOgDefinition<Copy, Variant extends string = string> = SvgOgDefinition<Copy, Variant> & {
  /** Resvg rendering controls and the `@resvg/resvg-wasm` module. */
  resvg?: EdgeResvgOptions;
  /**
   * Satori's Yoga layout engine, `satori/layout.wasm`. `metaplate/edge` lays
   * out through `satori/standalone` only, so every edge bundle carries one
   * Satori build, and that build needs this module from the caller here or
   * through `initEdgeRenderer`.
   */
  layout?: { wasm?: EdgeWasmSource };
  /** Headers added to Web Responses returned by `response` and `fetchable`. */
  headers?: HeadersInit;
  /** Adds a strong SHA-256 ETag, computed with Web Crypto, to responses. */
  etag?: boolean | "sha256";
  /**
   * Render guards, plus `blank`, which fails or reports a rasterised image
   * whose every pixel is one color. All off by default.
   */
  guards?: RasterRenderGuards;
  /**
   * Not supported: `metaplate/edge` emits PNG only, because
   * `@resvg/resvg-wasm` has no JPEG or WebP encoder. Use `renderPixels` with
   * a Wasm encoder, or `metaplate/node` and its `output` encoders.
   */
  output?: never;
};

type ResvgWasm = Awaited<ReturnType<typeof loadResvgWasm>>;
type SatoriStandalone = Awaited<ReturnType<typeof loadSatoriStandalone>>;

/**
 * Both Wasm modules are process-wide singletons inside their packages, so the
 * first source supplied for each wins and later ones are ignored, unless that
 * source failed to initialise: then the next source supplied replaces it, so
 * a corrected module takes effect without restarting the isolate. Until one
 * arrives, renders retry the failed source, which recovers a transient fetch.
 */
type WasmSlot = { source?: EdgeWasmSource; ready?: Promise<void> | undefined; failed?: boolean };

const resvgSlot: WasmSlot = {};
const layoutSlot: WasmSlot = {};

function provide(slot: WasmSlot, source: EdgeWasmSource | undefined): void {
  if (source === undefined) return;
  if (slot.source === undefined || slot.failed) {
    slot.source = source;
    slot.failed = false;
  }
}

async function resolveWasm(source: EdgeWasmSource): Promise<EdgeWasmModule> {
  return typeof source === "function" ? source() : source;
}

/**
 * Initialises a slot once; a failed attempt is discarded so a later render can
 * retry. A slot with no source resolves, or rejects with `missing` when the
 * entry cannot render without it.
 */
function initialise(
  slot: WasmSlot,
  init: (module: EdgeWasmModule) => Promise<void> | void,
  missing?: () => Error,
): Promise<void> {
  const { source } = slot;
  if (source === undefined) return missing ? Promise.reject(missing()) : Promise.resolve();
  slot.ready ??= resolveWasm(source)
    .then(init)
    .catch((error: unknown) => {
      slot.ready = undefined;
      slot.failed = true;
      throw error;
    });
  return slot.ready;
}

const ALREADY_INITIALISED = /already initialized/i;
const NOT_INITIALISED = /has not been initialized/i;

function initialiseResvg(resvg: ResvgWasm): Promise<void> {
  return initialise(resvgSlot, async (module) => {
    try {
      await resvg.initWasm(module as Parameters<ResvgWasm["initWasm"]>[0]);
    } catch (error) {
      // The application initialised @resvg/resvg-wasm itself; that module is
      // the one this entry renders with, so there is nothing left to do.
      if (!(error instanceof Error && ALREADY_INITIALISED.test(error.message))) throw error;
    }
  });
}

function initialiseLayout(satori: SatoriStandalone): Promise<void> {
  return initialise(
    layoutSlot,
    (module) => satori.init(module as Parameters<SatoriStandalone["init"]>[0]),
    missingLayoutError,
  );
}

/**
 * Satori's standalone build with the caller's Yoga module. The entry never
 * imports Satori's default build, which embeds its own copy of Yoga, so edge
 * bundlers that follow dynamic imports ship one Satori build, not two.
 */
async function loadSatori(): Promise<SatoriRender> {
  const satori = await loadSatoriStandalone();
  await initialiseLayout(satori);
  const render = satori.default as unknown as SatoriRender;
  return (async (...args: Parameters<SatoriRender>) => {
    try {
      return await render(...args);
    } catch (error) {
      throw explainHarfBuzzRuntime(error);
    }
  }) as SatoriRender;
}

const EDGE_RUNTIMES_DOC = "https://github.com/lnorton89/metaplate/blob/main/docs/edge.md#edge-runtimes-with-metaplateedge";

/**
 * Satori's standalone build shapes text with a bundled HarfBuzz Emscripten
 * build. In a worker-shaped isolate it reads `self.location.href`, which
 * Cloudflare Workers do not define, and it compiles HarfBuzz from embedded
 * bytes, which Workers refuse ("Wasm code generation disallowed by
 * embedder"). Satori takes no precompiled HarfBuzz module, so neither failure
 * can be fixed by the caller; this names the cause instead of the symptom.
 * Every other error is returned unchanged.
 */
function explainHarfBuzzRuntime(error: unknown): unknown {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const missingLocation =
    message.includes("reading 'href'") &&
    typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined" &&
    typeof (globalThis as { location?: unknown }).location === "undefined";
  if (!missingLocation && !message.includes("Wasm code generation disallowed")) return error;
  return new Error(
    "metaplate/edge cannot render text in this runtime: Satori's bundled HarfBuzz text shaper " +
      "compiles WebAssembly at runtime and expects self.location, which this runtime forbids " +
      "(Cloudflare Workers and other V8 isolates that disallow Wasm code generation). " +
      "metaplate/edge runs on edge runtimes that allow it, such as Deno and Netlify Edge " +
      `Functions. See ${EDGE_RUNTIMES_DOC}`,
    { cause: error },
  );
}

function missingLayoutError(): Error {
  return new Error(
    "metaplate/edge has no satori/layout.wasm module to lay out with. Pass it as " +
      "layout.wasm to createEdgeOg or to initEdgeRenderer(wasm, { layout }), for example as " +
      "bytes fetched from a static copy of satori/layout.wasm.",
  );
}

function missingWasmError(cause: unknown): Error {
  return new Error(
    "metaplate/edge has no @resvg/resvg-wasm module to render with. Pass it as " +
      "resvg.wasm to createEdgeOg or to initEdgeRenderer(wasm, { layout }), for example as " +
      "bytes fetched from a static copy of @resvg/resvg-wasm/index_bg.wasm.",
    { cause },
  );
}

/**
 * Supplies both Wasm modules once for every edge plate, for example at the top
 * of an edge function module: `@resvg/resvg-wasm/index_bg.wasm` and Satori's
 * `satori/layout.wasm`. Resolves when both renderers are ready.
 */
export async function initEdgeRenderer(
  wasm: EdgeWasmSource,
  options: { layout: EdgeWasmSource },
): Promise<void> {
  provide(resvgSlot, wasm);
  provide(layoutSlot, (options as { layout?: EdgeWasmSource } | undefined)?.layout);
  const [satori, resvg] = await loadPeerPair(loadSatoriStandalone, loadResvgWasm, "metaplate/edge");
  await Promise.all([initialiseResvg(resvg), initialiseLayout(satori)]);
}

/**
 * Defines a PNG renderer for Deno-based edges (such as Netlify Edge
 * Functions) and other Fetch-shaped runtimes that allow WebAssembly
 * compilation at run time, rasterising through `@resvg/resvg-wasm` rather than
 * native Resvg. It uses no Node built-ins; fonts arrive as bytes, typically
 * through `metaplate/font-data`. Cloudflare Workers are not supported: Satori's
 * bundled HarfBuzz cannot start there.
 */
export function createEdgeOg<Copy, Variant extends string = string>(
  definition: EdgeOgDefinition<Copy, Variant>,
) {
  if ((definition as { output?: unknown }).output !== undefined) {
    throw new TypeError(
      "metaplate/edge renders PNG only: @resvg/resvg-wasm has no JPEG or WebP encoder. " +
        "Remove output, encode renderPixels() with a Wasm encoder, or use metaplate/node.",
    );
  }
  const { wasm, ...resvgOptions } = definition.resvg ?? {};
  provide(resvgSlot, wasm);
  provide(layoutSlot, definition.layout?.wasm);

  const raster = createRasterPlate(
    { ...definition, resvg: resvgOptions },
    {
      satori: loadSatori,
      async rasterize(source, read) {
        // Both peers resolve before either Wasm module is required, so a
        // missing package is reported as an install command first.
        const [, resvg] = await loadPeerPair(loadSatoriStandalone, loadResvgWasm, "metaplate/edge");
        await initialiseResvg(resvg);
        const svg = await source();

        let renderer: InstanceType<ResvgWasm["Resvg"]>;
        try {
          renderer = new resvg.Resvg(svg, resvgOptions);
        } catch (error) {
          if (error instanceof Error && NOT_INITIALISED.test(error.message)) {
            throw missingWasmError(error);
          }
          throw error;
        }
        // Wasm memory is not garbage collected promptly, so a long-lived
        // isolate rendering many cards releases each frame explicitly.
        try {
          const image = renderer.render();
          try {
            return read(image);
          } finally {
            image.free();
          }
        } finally {
          renderer.free();
        }
      },
      sha256: async (bytes) =>
        toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))),
      renderer: "edge",
    },
  );

  return createPlateViews(raster.variants, (name) => {
    const view = raster.view(name);
    // Edge runtimes are Fetch-shaped, so the Fetchable forms are the primary
    // API; the copy-bound `handler` stays a `metaplate/node` convenience.
    const { handlerFrom, fetchable, fetchableFrom } = createPlateHandlers(view.response);
    return {
      ...view,
      contentType: "image/png" as const,
      handlerFrom,
      fetchable,
      fetchableFrom,
      /** This size with a render cache in front: Fetch-shaped, like the plate. */
      cached: (options?: RenderCacheOptions) => {
        const cache = view.cached(options);
        return Object.freeze({
          store: cache.store,
          key: cache.key,
          entry: cache.entry,
          render: cache.render,
          response: cache.response,
          handlerFrom: cache.handlerFrom,
          fetchable: cache.fetchable,
          fetchableFrom: cache.fetchableFrom,
        });
      },
    };
  });
}
