/**
 * Runtime-neutral per-language font fallback for Satori. No peers and no Node
 * built-ins, so `metaplate/font-data` and `metaplate/edge` bundle it
 * unchanged; the Fontsource package reader lives in `metaplate/fonts`.
 *
 * Satori calls `loadAdditionalAsset(languageCode, segment)` once per render
 * for each script its fonts cannot draw. `languageCode` is one of the codes
 * Satori's `detectLanguageCode` returns, or several joined by `|` when a
 * character belongs to more than one script (Han is `ja-JP|zh-CN|zh-TW|zh-HK`),
 * in Satori's preference order; `segment` is every distinct grapheme of that
 * script in the copy. The fonts returned are added to Satori's fallback list.
 */
import { loadedFont, memoizedFontLoader as memoize, type FontBytes, type FontWeight, type LoadedFont } from "./loader.js";

/**
 * The language codes Satori passes to `loadAdditionalAsset` for text (its
 * `language.ts`, unchanged from Satori 0.38.2 through 0.63). `emoji` is
 * handled by the plate's `emoji` option instead.
 */
export const LANGUAGE_CODES = [
  "ja-JP",
  "ko-KR",
  "zh-CN",
  "zh-TW",
  "zh-HK",
  "th-TH",
  "bn-IN",
  "ar-AR",
  "ta-IN",
  "ml-IN",
  "he-IL",
  "te-IN",
  "devanagari",
  "kannada",
  "symbol",
  "math",
  "unknown",
] as const;

export type LanguageCode = (typeof LANGUAGE_CODES)[number];

/**
 * Subset id to CSS `unicode-range` value: the shape of a Fontsource
 * package's `unicode.json`, such as `{ "[12]": "U+4E00-4E8C,U+65E5", "latin":
 * "U+0000-00FF" }`. A bracketed key names a numbered slice (`[12]` is the
 * file subset `12`); any other key is the subset id itself.
 */
export type UnicodeRanges = Readonly<Record<string, string>>;

/** One face Satori may fall back to for a language. */
export type LanguageFontFace = {
  /** Family name; Metaplate suffixes the language and subset to keep each file distinct. */
  name: string;
  /** Defaults to 400. List one face per weight to let Satori pick the closest. */
  weight?: FontWeight;
  /** Defaults to `"normal"`. */
  style?: "normal" | "italic";
  /**
   * The face's subset files and the code points each covers. When given,
   * `data` is called with the id of each subset file the segment needs and
   * no other; without it, `data` is called once with `undefined` for a
   * single file that is assumed to cover the whole segment.
   */
  unicodeRanges?: UnicodeRanges;
  /**
   * The bytes of one file of the face (TTF, OTF, or WOFF; WOFF2 only with
   * Satori 0.55.0 or later). Called lazily, at most once per subset while it
   * succeeds; a throw fails the render and is retried by the next one.
   */
  data: (subset: string | undefined) => FontBytes | Promise<FontBytes>;
};

/** Faces per Satori language code; list several faces for several weights. */
export type LanguageFonts = Partial<
  Record<LanguageCode, LanguageFontFace | readonly LanguageFontFace[]>
>;

/**
 * Resolves one `loadAdditionalAsset` request to the fallback fonts that
 * cover it. An empty list means no configured language covers any of the
 * segment, so the request falls through to the next loader.
 */
export type LanguageFontLoader = (languageCode: string, segment: string) => Promise<LoadedFont[]>;

const SUBSET_ID = /^[a-z0-9][a-z0-9._~-]*$/i;
const NUMBERED_SLICE = /^\[(\d+)\]$/;
const RANGE = /^U\+([0-9a-f]{1,6})(?:-([0-9a-f]{1,6}))?$/i;
const WILDCARD_RANGE = /^U\+([0-9a-f]{0,5})(\?{1,6})$/i;
const MAX_CODEPOINT = 0x10ffff;

type Subset = {
  id: string;
  /** Sorted, merged, inclusive `[start, end]` pairs, flattened. */
  ranges: number[];
};

/** A face after validation: what the selection and loading below work on. */
export type ResolvedLanguageFace = {
  name: string;
  weight: FontWeight;
  style: "normal" | "italic";
  /** `undefined` for a single file assumed to cover every character. */
  subsets: readonly Subset[] | undefined;
  load: (subset: string | undefined) => FontBytes | Promise<FontBytes>;
};

function parseRange(subset: string, part: string): [number, number] {
  const range = RANGE.exec(part);
  const wildcard = range ? undefined : WILDCARD_RANGE.exec(part);
  let start: number;
  let end: number;
  if (range) {
    start = Number.parseInt(range[1]!, 16);
    end = range[2] === undefined ? start : Number.parseInt(range[2], 16);
  } else if (wildcard && wildcard[1]!.length + wildcard[2]!.length <= 6) {
    start = Number.parseInt(`${wildcard[1]}${"0".repeat(wildcard[2]!.length)}`, 16);
    end = Number.parseInt(`${wildcard[1]}${"f".repeat(wildcard[2]!.length)}`, 16);
  } else {
    throw new TypeError(`Invalid unicode-range for subset "${subset}": ${JSON.stringify(part)}`);
  }
  if (start > end || start > MAX_CODEPOINT) {
    throw new TypeError(`Invalid unicode-range for subset "${subset}": ${JSON.stringify(part)}`);
  }
  return [start, Math.min(end, MAX_CODEPOINT)];
}

/** Parses a CSS `unicode-range` list into sorted, merged, disjoint ranges. */
export function parseUnicodeRange(subset: string, value: string): number[] {
  const ranges = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => parseRange(subset, part))
    .sort((a, b) => a[0] - b[0]);
  const merged: number[] = [];
  for (const [start, end] of ranges) {
    const last = merged.length - 1;
    if (merged.length > 0 && start <= merged[last]! + 1) {
      merged[last] = Math.max(merged[last]!, end);
    } else {
      merged.push(start, end);
    }
  }
  return merged;
}

/** Validates a `unicode.json`-shaped record into subsets, in declaration order. */
export function parseUnicodeRanges(ranges: UnicodeRanges): Subset[] {
  if (typeof ranges !== "object" || ranges === null || Array.isArray(ranges)) {
    throw new TypeError("unicodeRanges must map subset ids to unicode-range strings.");
  }
  return Object.entries(ranges).map(([key, value]) => {
    const id = NUMBERED_SLICE.exec(key)?.[1] ?? key;
    if (!SUBSET_ID.test(id)) throw new TypeError(`Invalid subset id: ${JSON.stringify(key)}`);
    if (typeof value !== "string") {
      throw new TypeError(`unicode-range for subset "${key}" must be a string.`);
    }
    return { id, ranges: parseUnicodeRange(key, value) };
  });
}

function covers({ ranges }: Subset, codepoint: number): boolean {
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (codepoint < ranges[middle * 2]!) high = middle - 1;
    else if (codepoint > ranges[middle * 2 + 1]!) low = middle + 1;
    else return true;
  }
  return false;
}

/**
 * Picks the subset files that cover `codepoints`: each code point not
 * already covered by a picked file takes the first file, in declaration
 * order, whose range includes it. Returns the picks in declaration order and
 * the code points they cover; code points no file covers are left out.
 */
export function selectSubsets(
  subsets: readonly Subset[],
  codepoints: Iterable<number>,
): { subsets: Subset[]; covered: Set<number> } {
  const picked = new Set<Subset>();
  const covered = new Set<number>();
  for (const codepoint of codepoints) {
    let found = [...picked].some((subset) => covers(subset, codepoint));
    if (!found) {
      const subset = subsets.find((candidate) => covers(candidate, codepoint));
      if (subset) {
        picked.add(subset);
        found = true;
      }
    }
    if (found) covered.add(codepoint);
  }
  return { subsets: subsets.filter((subset) => picked.has(subset)), covered };
}

function assertLanguageCode(code: string): asserts code is LanguageCode {
  if (!(LANGUAGE_CODES as readonly string[]).includes(code)) {
    throw new TypeError(
      `${JSON.stringify(code)} is not a language code Satori requests fonts for. ` +
        `Use one of: ${LANGUAGE_CODES.join(", ")}.`,
    );
  }
}

/** The configured languages, validated at definition time. */
export function languageCodes(fonts: object): LanguageCode[] {
  const codes = Object.keys(fonts);
  for (const code of codes) assertLanguageCode(code);
  return codes as LanguageCode[];
}

/**
 * The shared engine behind `languageFontLoader` and the Fontsource loader in
 * `metaplate/fonts`: `resolve` lists a language's faces (called on that
 * language's first request, memoized while it succeeds), and each subset
 * file is loaded once and reused across renders, so Satori also reuses its
 * parsed copy.
 */
export function createLanguageFontLoader(
  codes: readonly LanguageCode[],
  resolve: (code: LanguageCode) => Promise<readonly ResolvedLanguageFace[]>,
): LanguageFontLoader {
  const faces = new Map(codes.map((code) => [code, memoize(() => resolve(code))] as const));
  const files = new Map<string, () => Promise<LoadedFont>>();

  const file = (code: LanguageCode, index: number, face: ResolvedLanguageFace, subset: string | undefined) => {
    const key = `${code}\0${index}\0${subset ?? ""}`;
    let load = files.get(key);
    if (!load) {
      load = memoize(async () =>
        loadedFont(
          {
            name: subset === undefined ? `${face.name} ${code}` : `${face.name} ${code} ${subset}`,
            weight: face.weight,
            style: face.style,
            // Satori rejects `lang` values it does not know; "unknown" is
            // not one, and a font without `lang` is a plain fallback.
            ...(code === "unknown" ? {} : { lang: code }),
          },
          await face.load(subset),
        ),
      );
      files.set(key, load);
    }
    return load();
  };

  return async (languageCode, segment) => {
    let remaining = new Set(Array.from(segment, (character) => character.codePointAt(0)!));
    const pending: Promise<LoadedFont>[] = [];

    for (const code of languageCode.split("|")) {
      if (remaining.size === 0) break;
      const resolveFaces = faces.get(code as LanguageCode);
      if (!resolveFaces) continue;

      const claimed = new Set<number>();
      (await resolveFaces()).forEach((face, index) => {
        if (face.subsets === undefined) {
          for (const codepoint of remaining) claimed.add(codepoint);
          pending.push(file(code as LanguageCode, index, face, undefined));
          return;
        }
        const selection = selectSubsets(face.subsets, remaining);
        for (const codepoint of selection.covered) claimed.add(codepoint);
        for (const subset of selection.subsets) {
          pending.push(file(code as LanguageCode, index, face, subset.id));
        }
      });
      remaining = new Set([...remaining].filter((codepoint) => !claimed.has(codepoint)));
    }

    return Promise.all(pending);
  };
}

function resolveFace(code: LanguageCode, face: LanguageFontFace): ResolvedLanguageFace {
  if (typeof face?.name !== "string" || face.name.length === 0 || typeof face.data !== "function") {
    throw new TypeError(`The ${code} font needs a name and a data function.`);
  }
  return {
    name: face.name,
    weight: face.weight ?? 400,
    style: face.style ?? "normal",
    subsets: face.unicodeRanges === undefined ? undefined : parseUnicodeRanges(face.unicodeRanges),
    load: face.data,
  };
}

/**
 * Supplies fonts for scripts the plate's fonts do not cover, from bytes the
 * application provides: bundled, imported, or fetched from its own origin.
 * Pass the result as a plate's `languageFonts` option. Works on every
 * runtime; on Node, `fontsourceLanguageFontLoader` from `metaplate/fonts`
 * reads installed Fontsource packages instead.
 */
export function languageFontLoader(fonts: LanguageFonts): LanguageFontLoader {
  const codes = languageCodes(fonts);
  const resolved = new Map(
    codes.map((code) => {
      const faces = fonts[code]!;
      const list = (Array.isArray(faces) ? faces : [faces]) as readonly LanguageFontFace[];
      return [code, list.map((face) => resolveFace(code, face))] as const;
    }),
  );
  return createLanguageFontLoader(codes, async (code) => resolved.get(code)!);
}
