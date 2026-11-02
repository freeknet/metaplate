import { memoizeLoad } from "./bytes.js";

export type FontWeight =
  | 100
  | 200
  | 300
  | 400
  | 500
  | 600
  | 700
  | 800
  | 900;

export type FontFace = {
  name: string;
  weight: FontWeight;
  style?: "normal" | "italic";
  /** Optional BCP 47 language tag passed through to Satori's font selection. */
  lang?: string;
};

export type FontBytes = ArrayBuffer | ArrayBufferView;

export type DataFont = FontFace & {
  /** Existing bytes, or a lazy framework/application loader for those bytes. */
  data: FontBytes | (() => FontBytes | Promise<FontBytes>);
};

export type LoadedFont = {
  name: string;
  data: ArrayBuffer;
  weight: FontWeight;
  style: "normal" | "italic";
  /** Optional BCP 47 language tag passed through to Satori's font selection. */
  lang?: string;
};

function toArrayBuffer(bytes: FontBytes): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint8Array.from(view).buffer;
}

/**
 * Leading bytes of the font containers Satori can read: TrueType (0x00010000
 * or "true"), OpenType with CFF outlines ("OTTO"), WOFF ("wOFF"), and WOFF2
 * ("wOF2").
 */
const FONT_SIGNATURES: readonly (readonly number[])[] = [
  [0x00, 0x01, 0x00, 0x00],
  [0x74, 0x72, 0x75, 0x65],
  [0x4f, 0x54, 0x54, 0x4f],
  [0x77, 0x4f, 0x46, 0x46],
  [0x77, 0x4f, 0x46, 0x32],
];

function describeLeadingBytes(view: Uint8Array): string {
  const head = view.subarray(0, 16);
  const hex = [...head.subarray(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
  const text = String.fromCharCode(...head).replace(/[^ -~]/g, ".");
  return `${view.byteLength} bytes starting ${hex || "(empty)"} (${JSON.stringify(text)})`;
}

/**
 * Rejects bytes that are not a TrueType, OpenType, WOFF, or WOFF2 font. Satori
 * renders text set in an unreadable font as nothing at all, so without this a
 * failed font fetch (an HTML error page, a placeholder, an empty body) would
 * produce a blank card that a CDN could cache, instead of an error.
 */
function assertFontBytes(font: FontFace, view: Uint8Array): void {
  const recognized = FONT_SIGNATURES.some(
    (signature) => view.byteLength >= 4 && signature.every((byte, index) => view[index] === byte),
  );
  if (!recognized) {
    throw new TypeError(
      `Font "${font.name}" (weight ${font.weight}) is not a TrueType, OpenType, WOFF, or WOFF2 file: ` +
        `received ${describeLeadingBytes(view)}`,
    );
  }
}

export function loadedFont(font: FontFace, data: FontBytes): LoadedFont {
  const buffer = toArrayBuffer(data);
  assertFontBytes(font, new Uint8Array(buffer));
  return {
    name: font.name,
    data: buffer,
    weight: font.weight,
    style: font.style ?? "normal",
    ...(font.lang === undefined ? {} : { lang: font.lang }),
  };
}

export function memoizedFontLoader(load: () => Promise<LoadedFont[]>) {
  return memoizeLoad(load);
}

/** Normalizes existing application/framework font bytes for Satori and Next. */
export async function loadFonts(fonts: readonly DataFont[]): Promise<LoadedFont[]> {
  return Promise.all(
    fonts.map(async (font) => {
      const source = typeof font.data === "function" ? font.data() : font.data;
      return loadedFont(font, await source);
    }),
  );
}

/** Memoizes application/framework-provided font bytes across renders. */
export function fontLoader(fonts: readonly DataFont[]): () => Promise<LoadedFont[]> {
  return memoizedFontLoader(() => loadFonts(fonts));
}
