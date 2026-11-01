import { loadPeerPair } from "./optional-peer.js";
import { createPlateHandlers, createPlateViews } from "./plate.js";
import {
  loadEdgeSatori,
  loadResvgWasm,
  loadSatoriStandalone,
} from "./peers.js";
import {
  createRasterPlate,
  type ResvgRenderOptions,
} from "./raster.js";
import type { SvgOgDefinition } from "./render.js";
import type { SatoriRender } from "./svg-plate.js";

export type { RenderedPixels } from "./raster.js";

export type {
  PlateContext,
  PlateMetadataOptions,
  PlateVariant,
  PlateVariants,
  PlateView,
} from "./plate.js";

/**
 * A compiled or compilable WebAssembly module: the module a Workers
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
   * Satori's Yoga layout engine (`satori/layout.wasm`). Required where the
   * runtime forbids compiling WebAssembly from bytes, as Cloudflare Workers
   * does; elsewhere Satori's default build compiles its embedded copy.
   */
  layout?: { wasm: EdgeWasmSource };
  /** Headers added to Web Responses returned by `response` and `fetchable`. */
  headers?: HeadersInit;
  /** Adds a strong SHA-256 ETag, computed with Web Crypto, to responses. */
  etag?: boolean | "sha256";
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
 * first source supplied for each wins and later ones are ignored.
 */
type WasmSlot = { source?: EdgeWasmSource; ready?: Promise<void> | undefined };

const resvgSlot: WasmSlot = {};
const layoutSlot: WasmSlot = {};

function provide(slot: WasmSlot, source: EdgeWasmSource | undefined): void {
  if (source !== undefined) slot.source ??= source;
}

async function resolveWasm(source: EdgeWasmSource): Promise<EdgeWasmModule> {
  return typeof source === "function" ? source() : source;
}

/** Initialises a slot once; a failed attempt is discarded so a later render can retry. */
function initialise(
  slot: WasmSlot,
  init: (module: EdgeWasmModule) => Promise<void> | void,
): Promise<void> {
  const { source } = slot;
  if (source === undefined) return Promise.resolve();
  slot.ready ??= resolveWasm(source)
    .then(init)
    .catch((error: unknown) => {
      slot.ready = undefined;
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
  return initialise(layoutSlot, (module) =>
    satori.init(module as Parameters<SatoriStandalone["init"]>[0]),
  );
}

/** Satori's standalone build once a layout module is known, its default build otherwise. */
async function loadSatori(): Promise<SatoriRender> {
  if (layoutSlot.source === undefined) return loadEdgeSatori();
  const satori = await loadSatoriStandalone();
  await initialiseLayout(satori);
  return satori.default as unknown as SatoriRender;
}

function missingWasmError(cause: unknown): Error {
  return new Error(
    "metaplate/edge has no @resvg/resvg-wasm module to render with. Pass it as " +
      "resvg.wasm to createEdgeOg or call initEdgeRenderer(wasm) first; in Cloudflare " +
      'Workers, import wasm from "@resvg/resvg-wasm/index_bg.wasm".',
    { cause },
  );
}

/**
 * Supplies the Wasm modules once for every edge plate, for example at the top
 * of a Worker module. Resolves when both renderers are ready.
 */
export async function initEdgeRenderer(
  wasm: EdgeWasmSource,
  options: { layout?: EdgeWasmSource } = {},
): Promise<void> {
  provide(resvgSlot, wasm);
  provide(layoutSlot, options.layout);
  const resvg = await loadResvgWasm();
  await initialiseResvg(resvg);
  if (layoutSlot.source !== undefined) await initialiseLayout(await loadSatoriStandalone());
}

/**
 * Defines a PNG renderer for Workers, Deno, and other Fetch-shaped runtimes,
 * rasterising through `@resvg/resvg-wasm` rather than native Resvg. It uses no
 * Node built-ins; fonts arrive as bytes, typically through
 * `metaplate/font-data`.
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
        const [, resvg] = await loadPeerPair(loadSatori, loadResvgWasm, "metaplate/edge");
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
      etag: async (bytes) => {
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
        return `"${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
      },
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
    };
  });
}
