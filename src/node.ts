import { createHash } from "node:crypto";
import { OG_CONTENT_TYPE } from "./core.js";
import { detectFormat, imageContentType, type ImageFormat, type OutputFormat } from "./image.js";
import { loadPeerPair } from "./optional-peer.js";
import { createPlateHandlers, createPlateSocial } from "./plate.js";
import { loadResvg, loadSatori } from "./peers.js";
import {
  createSvgOg,
  type SvgOgDefinition,
} from "./render.js";

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

function assertDimensionPreservingResvgOptions(
  options: ResvgRenderOptions | undefined,
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

function createResponseHeaders(definition: NodeOgDefinition<unknown>, contentType: string, byteLength: number, etag?: string): Headers {
  const headers = new Headers(definition.headers);
  headers.set("Content-Type", contentType);
  headers.set("Content-Length", String(byteLength));
  if (etag) headers.set("ETag", etag);
  return headers;
}

function strongEtag(bytes: Uint8Array): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

/**
 * Defines a Node renderer that emits image bytes and Fetch API Responses for
 * Astro, SvelteKit, Remix, Express adapters, build scripts, and other runtimes.
 */
export function createNodeOg<Copy>(definition: NodeOgDefinition<Copy>) {
  const svg = createSvgOg(definition);
  assertDimensionPreservingResvgOptions(definition.resvg, svg.size);
  assertResponseHeaderConfiguration(definition.headers, Boolean(definition.etag));
  const contentType = outputContentType(definition.output);
  assertMediaType(contentType);
  const social = createPlateSocial(definition, contentType, svg.size);

  async function rasterize(copy: Copy) {
    // Both peers resolve before rendering so an install missing both is told
    // to add both, rather than reporting them one run at a time.
    const [, Resvg] = await loadPeerPair(loadSatori, loadResvg, "metaplate/node");
    const source = await svg.renderSvg(copy);
    const image = new Resvg(source, definition.resvg).render();
    if (image.width !== svg.size.width || image.height !== svg.size.height) {
      throw new Error(
        `Renderer dimension mismatch: expected ${svg.size.width}x${svg.size.height}, ` +
          `received ${image.width}x${image.height}`,
      );
    }
    return image;
  }

  async function encode(image: Awaited<ReturnType<typeof rasterize>>) {
    if (!definition.output) return image.asPng();

    const encoded = await definition.output.encode({
      pixels: image.pixels,
      width: image.width,
      height: image.height,
    });

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
    if ("format" in definition.output && detectFormat(encoded) !== definition.output.format) {
      throw new Error(
        `output.encode produced ${describeFormat(detectFormat(encoded))} bytes, not the declared ` +
          `${definition.output.format} format`,
      );
    }

    return encoded;
  }

  async function render(copy: Copy): Promise<Uint8Array> {
    const image = await rasterize(copy);
    return encode(image);
  }

  /**
   * Renders raw RGBA bytes rather than PNG. A card compositing a photograph
   * encodes far smaller as JPEG or WebP, and returning the pixmap keeps an
   * image encoder out of this package.
   */
  async function renderPixels(copy: Copy): Promise<RenderedPixels> {
    const image = await rasterize(copy);
    return { pixels: image.pixels, width: image.width, height: image.height };
  }

  async function artifact(route: string, copy: Copy) {
    const bytes = await render(copy);
    const format = definition.output && "format" in definition.output
      ? definition.output.format
      : detectFormat(bytes);
    return Object.freeze({
      bytes,
      byteLength: bytes.byteLength,
      contentType,
      format,
      size: svg.size,
      image: Object.freeze({ width: svg.size.width, height: svg.size.height, format }),
      metadata: social.metadata(route, copy),
      ...(definition.etag ? { etag: strongEtag(bytes) } : {}),
    });
  }

  async function response(copy: Copy) {
    const bytes = await render(copy);
    const etag = definition.etag ? strongEtag(bytes) : undefined;
    const headers = createResponseHeaders(definition as NodeOgDefinition<unknown>, contentType, bytes.byteLength, etag);
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(body, { headers });
  }

  return Object.freeze({
    ...svg,
    ...social,
    contentType,
    render,
    renderPixels,
    artifact,
    response,
    ...createPlateHandlers(response),
  });
}
