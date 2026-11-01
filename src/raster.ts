import { OG_CONTENT_TYPE } from "./core.js";
import { detectFormat, imageContentType, type ImageFormat, type OutputFormat } from "./image.js";
import { createPlateSocial } from "./plate.js";
import type { SvgOgDefinition } from "./render.js";
import { createSvgPlate, type SatoriRender } from "./svg-plate.js";

/**
 * Not an entry point: the renderer-independent half of `metaplate/node` and
 * `metaplate/edge`. Everything here is Web-platform only (no Node built-ins,
 * no `Buffer`), so the edge bundle can include it unchanged; the renderer
 * binding and the ETag digest are supplied by each entry.
 */

/** Raster formats whose bytes Metaplate can recognise after encoding. */
export type EncoderFormat = ImageFormat;

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  return value.constructor?.name ?? "an object";
}

function describeFormat(format: OutputFormat | undefined): string {
  return format ?? "unrecognized";
}

/** Raw RGBA output, ready for an encoder such as sharp or @jsquash/jpeg. */
export type RenderedPixels = {
  /** Row-major RGBA bytes, `width * height * 4` long. */
  pixels: Uint8Array;
  width: number;
  height: number;
};

/**
 * Resvg rendering controls mirrored structurally so importing
 * `metaplate/node` does not pull Resvg's Node-dependent declarations into a
 * consumer that has not installed the optional renderer peer yet.
 */
export type ResvgRenderOptions = {
  font?: {
    loadSystemFonts?: boolean;
    fontFiles?: string[];
    fontDirs?: string[];
    defaultFontSize?: number;
    defaultFontFamily?: string;
    serifFamily?: string;
    sansSerifFamily?: string;
    cursiveFamily?: string;
    fantasyFamily?: string;
    monospaceFamily?: string;
  };
  dpi?: number;
  languages?: string[];
  shapeRendering?: 0 | 1 | 2;
  textRendering?: 0 | 1 | 2;
  imageRendering?: 0 | 1;
  fitTo?:
    | { mode: "original" }
    | { mode: "width"; value: number }
    | { mode: "height"; value: number }
    | { mode: "zoom"; value: number };
  background?: string;
  crop?: {
    left: number;
    top: number;
    right?: number;
    bottom?: number;
  };
  logLevel?: "off" | "error" | "warn" | "info" | "debug" | "trace";
};

/**
 * Encodes something other than PNG. `format` names the bytes the encoder
 * produces; `contentType` always follows from it, and the encoded bytes are
 * signature-checked against it so a plate cannot report one format while
 * emitting another. For a format Metaplate does not recognize, keep
 * `contentType` and set `checkSignature: false`.
 */
export type OutputEncoder =
  | {
      /** Known format: derives `contentType` and enables the signature check. */
      format: EncoderFormat;
      encode: (image: RenderedPixels) => Promise<Uint8Array> | Uint8Array;
    }
  | {
      /** Media type of the encoded bytes for a format Metaplate does not know. */
      contentType: string;
      /** Skips the signature check that is impossible for unknown formats. */
      checkSignature: false;
      encode: (image: RenderedPixels) => Promise<Uint8Array> | Uint8Array;
    };

/** One rasterised frame, as both the native and the Wasm Resvg bindings expose it. */
export type RasterImage = {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  asPng(): Uint8Array;
};

/** The renderer-specific half an entry supplies. */
export type RasterBackend = {
  /** Loads the Satori function this backend lays plates out with. */
  satori: () => Promise<SatoriRender>;
  /**
   * Rasterises the SVG `source` produces and hands the frame to `read`. Peers
   * resolve before `source` is called, and `read` runs before any renderer
   * memory is released, so a backend that frees its frame stays safe.
   */
  rasterize: <T>(source: () => Promise<string>, read: (image: RasterImage) => T) => Promise<T>;
  /** Strong ETag over the final encoded bytes. */
  etag: (bytes: Uint8Array) => string | Promise<string>;
};

export type RasterPlateDefinition<Copy, Variant extends string = string> = SvgOgDefinition<Copy, Variant> & {
  resvg?: Pick<ResvgRenderOptions, "fitTo" | "crop">;
  headers?: HeadersInit;
  output?: OutputEncoder;
  etag?: boolean | "sha256";
};

function assertDimensionPreservingResvgOptions(
  options: Pick<ResvgRenderOptions, "fitTo" | "crop"> | undefined,
  size: { width: number; height: number },
): void {
  const fit = options?.fitTo;
  const preservesSize =
    fit === undefined ||
    fit.mode === "original" ||
    (fit.mode === "width" && fit.value === size.width) ||
    (fit.mode === "height" && fit.value === size.height) ||
    (fit.mode === "zoom" && fit.value === 1);
  if (!preservesSize) {
    throw new Error(
      `resvg.fitTo must preserve the plate's ${size.width}x${size.height} dimensions`,
    );
  }
  if (options?.crop) {
    throw new Error(
      "resvg.crop is not supported because rendered pixels and advertised metadata must have identical dimensions",
    );
  }
}

function outputContentType(output: OutputEncoder | undefined): string {
  if (!output) return OG_CONTENT_TYPE;
  return "format" in output ? imageContentType(output.format) : output.contentType;
}

function assertMediaType(value: string): void {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"\\\r\n]*"))*$/.test(value)) {
    throw new TypeError(`Invalid output contentType: ${value}`);
  }
}

const REPRESENTATION_HEADERS = new Set(["content-type", "content-length", "content-encoding"]);

function assertResponseHeaderConfiguration(
  input: HeadersInit | undefined,
  automaticEtag: boolean,
): void {
  const headers = new Headers(input);
  for (const name of REPRESENTATION_HEADERS) {
    if (headers.has(name)) {
      throw new TypeError(`The ${name} response header is owned by Metaplate and must not be configured`);
    }
  }
  if (automaticEtag && headers.has("etag")) {
    throw new TypeError("The ETag response header is owned by automatic Metaplate ETag generation and must not be configured");
  }
}

function createResponseHeaders(input: HeadersInit | undefined, contentType: string, byteLength: number, etag?: string): Headers {
  const headers = new Headers(input);
  headers.set("Content-Type", contentType);
  headers.set("Content-Length", String(byteLength));
  if (etag) headers.set("ETag", etag);
  return headers;
}

async function encodeOutput(output: OutputEncoder, image: RenderedPixels): Promise<Uint8Array> {
  const encoded = await output.encode(image);

  // Without this, a wrong return type surfaces further downstream as a
  // property access on undefined inside `response`, which reads as a bug in
  // Metaplate rather than in the encoder the consumer supplied.
  if (!(encoded instanceof Uint8Array)) {
    throw new TypeError(
      `output.encode must return a Uint8Array; received ${describe(encoded)}`,
    );
  }
  if (encoded.byteLength === 0) {
    throw new Error("output.encode must return non-empty image bytes");
  }

  // A JPEG encoder that returns WebP bytes makes every downstream consumer
  // serve one format while advertising another; the agreement is declared
  // here so the mismatch is reported where it is created.
  if ("format" in output && detectFormat(encoded) !== output.format) {
    throw new Error(
      `output.encode produced ${describeFormat(detectFormat(encoded))} bytes, not the declared ` +
        `${output.format} format`,
    );
  }

  return encoded;
}

/**
 * Builds the shared raster plate: SVG rendering, dimension checks, encoding,
 * artifacts, and Fetch API Responses with owned representation headers.
 * `view(name)` returns the surface for the default size (`undefined`) or one
 * declared variant; each entry wraps it in `createPlateViews` with its own
 * handlers.
 */
export function createRasterPlate<Copy, Variant extends string = string>(
  definition: RasterPlateDefinition<Copy, Variant>,
  backend: RasterBackend,
) {
  const svg = createSvgPlate(definition, backend.satori);
  // Every size the plate renders must survive Resvg unchanged, not only the
  // default: a `fitTo` width matching 1200 would rescale a 1080 square.
  for (const name of [undefined, ...svg.variants]) {
    assertDimensionPreservingResvgOptions(
      definition.resvg,
      name === undefined ? svg.size : svg.variant(name).size,
    );
  }
  assertResponseHeaderConfiguration(definition.headers, Boolean(definition.etag));
  const contentType = outputContentType(definition.output);
  assertMediaType(contentType);
  const social = createPlateSocial(definition, contentType, svg.size);

  async function etagFor(bytes: Uint8Array): Promise<string | undefined> {
    return definition.etag ? backend.etag(bytes) : undefined;
  }

  function view(name: Variant | undefined) {
    const svgView = name === undefined ? svg : svg.variant(name);
    const socialView = social.view(name);
    const { size } = socialView.context;

    function rasterize<T>(copy: Copy, read: (image: RasterImage) => T): Promise<T> {
      return backend.rasterize(
        () => svgView.renderSvg(copy),
        (image) => {
          if (image.width !== size.width || image.height !== size.height) {
            throw new Error(
              `Renderer dimension mismatch: expected ${size.width}x${size.height}, ` +
                `received ${image.width}x${image.height}`,
            );
          }
          return read(image);
        },
      );
    }

    /**
     * Renders raw RGBA bytes rather than PNG. A card compositing a photograph
     * encodes far smaller as JPEG or WebP, and returning the pixmap keeps an
     * image encoder out of this package.
     */
    function renderPixels(copy: Copy): Promise<RenderedPixels> {
      return rasterize(copy, (image) => ({
        pixels: image.pixels,
        width: image.width,
        height: image.height,
      }));
    }

    async function render(copy: Copy): Promise<Uint8Array> {
      if (!definition.output) return rasterize(copy, (image) => image.asPng());
      return encodeOutput(definition.output, await renderPixels(copy));
    }

    /** Bytes plus metadata describing exactly those bytes and this size. */
    async function artifact(route: string, copy: Copy) {
      const bytes = await render(copy);
      const format = definition.output && "format" in definition.output
        ? definition.output.format
        : detectFormat(bytes);
      const etag = await etagFor(bytes);
      return Object.freeze({
        bytes,
        byteLength: bytes.byteLength,
        contentType,
        format,
        size,
        image: Object.freeze({ width: size.width, height: size.height, format }),
        metadata: socialView.ownMetadata(route, copy),
        ...(etag === undefined ? {} : { etag }),
      });
    }

    async function response(copy: Copy) {
      const bytes = await render(copy);
      const etag = await etagFor(bytes);
      const headers = createResponseHeaders(definition.headers, contentType, bytes.byteLength, etag);
      const body = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      return new Response(body, { headers });
    }

    return {
      size,
      image: socialView.image,
      metadata: socialView.metadata,
      renderSvg: svgView.renderSvg,
      contentType,
      render,
      renderPixels,
      artifact,
      response,
    };
  }

  return Object.freeze({ variants: social.variants, view });
}
