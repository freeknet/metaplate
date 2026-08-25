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

export function loadedFont(font: FontFace, data: FontBytes): LoadedFont {
  return {
    name: font.name,
    data: toArrayBuffer(data),
    weight: font.weight,
    style: font.style ?? "normal",
    ...(font.lang === undefined ? {} : { lang: font.lang }),
  };
}

export function memoizedFontLoader(load: () => Promise<LoadedFont[]>) {
  let loaded: Promise<LoadedFont[]> | undefined;
  return () => {
    loaded ??= load().catch((error: unknown) => {
      loaded = undefined;
      throw error;
    });
    return loaded;
  };
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
