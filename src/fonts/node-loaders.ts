import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { emojiKey, emojiLoader, type EmojiLoader } from "./emoji.js";
import {
  loadedFont,
  memoizedFontLoader,
  type FontFace,
  type FontWeight,
  type LoadedFont,
} from "./loader.js";
import {
  createLanguageFontLoader,
  languageCodes,
  parseUnicodeRanges,
  type LanguageCode,
  type LanguageFontLoader,
} from "./language-fonts.js";
import { projectFilePath } from "../core/project-path.js";

export { fontLoader, loadFonts } from "./loader.js";
export { languageFontLoader } from "./language-fonts.js";
export type { EmojiLoader } from "./emoji.js";
export type { DataFont, FontBytes, FontFace, FontWeight, LoadedFont } from "./loader.js";
export type {
  LanguageCode,
  LanguageFontFace,
  LanguageFontLoader,
  LanguageFonts,
  UnicodeRanges,
} from "./language-fonts.js";

export type FileFont = FontFace & {
  /** Absolute/relative project path or a co-located `file:` URL. */
  file: string | URL;
};

export type PackageFont = FontFace & {
  package: string;
  /** Path relative to the package directory, such as `files/font-latin-700-normal.woff`. */
  file: string;
};

export type FontsourceFont = Omit<FontFace, "name" | "weight"> & {
  /** Fontsource id (`inter`) or installed package name (`@fontsource/inter`). */
  font: string;
  /** Defaults to the family name declared by the installed Fontsource package. */
  name?: string;
  /** Defaults to 400. */
  weight?: FontWeight;
  /** Defaults to the package's declared default subset (normally `latin`). */
  subset?: string;
};

export type PackageFontOptions = {
  cwd?: string;
  /**
   * Resolves a font package to a readable directory. Needed for installs
   * that do not lay out ancestor `node_modules` directories, such as Yarn
   * Plug'n'Play: return the package location (unplugged path, or a
   * zipfs-backed read hook's view of it) and Metaplate reads the font from
   * there. Return `undefined` to fall back to the default resolution.
   */
  resolvePackage?: (packageName: string) => string | undefined;
};

export type FileFontOptions = {
  /** Base directory for relative project font paths. Defaults to `process.cwd()`. */
  cwd?: string;
};

const PACKAGE_SEGMENT = /^[a-z0-9][a-z0-9._~-]*$/i;

function assertPackageName(packageName: string): void {
  const segments = packageName.split("/");
  const valid = packageName.startsWith("@")
    ? segments.length === 2 &&
      PACKAGE_SEGMENT.test(segments[0]!.slice(1)) &&
      PACKAGE_SEGMENT.test(segments[1]!)
    : segments.length === 1 && PACKAGE_SEGMENT.test(segments[0]!);
  if (!valid) {
    throw new Error(`Invalid font package name: ${packageName}`);
  }
}

function resolveFontFile(packageDirectory: string, file: string, label = "Font file"): string {
  const root = path.resolve(packageDirectory);
  if (!file || path.isAbsolute(file)) {
    throw new Error(`${label} must stay within its package directory: ${file}`);
  }
  const target = path.resolve(root, file);
  const relative = path.relative(root, target);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must stay within its package directory: ${file}`);
  }
  return target;
}

/** Loads co-located or otherwise project-managed font files. */
export async function loadFileFonts(
  fonts: readonly FileFont[],
  options: FileFontOptions = {},
): Promise<LoadedFont[]> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return Promise.all(
    fonts.map(async (font) => loadedFont(font, await readFile(projectFilePath(font.file, cwd, "font")))),
  );
}

/** Memoizes project-managed font files across renders. */
export function fileFontLoader(
  fonts: readonly FileFont[],
  options: FileFontOptions = {},
): () => Promise<LoadedFont[]> {
  return memoizedFontLoader(() => loadFileFonts(fonts, options));
}

/**
 * Resolves a package through the active runtime, which understands the
 * install Metaplate is running in — npm and Yarn classic layouts, pnpm
 * stores, and (for package.json targets that are reachable) Plug'n'Play.
 */
function resolveByRequire(packageName: string, cwd: string): string | undefined {
  const requireFrom = createRequire(path.join(cwd, "metaplate-resolver.cjs"));

  // Most font packages ship no `exports` map, so their package.json is a
  // resolvable subpath that leads straight to the package root.
  try {
    return path.dirname(requireFrom.resolve(`${packageName}/package.json`));
  } catch {
    // A restrictive exports map hides package.json; fall through to the
    // entry-file climb below.
  }

  // Resolve the package entry, then climb to the directory whose manifest
  // names the package. This also follows node's default realpath behavior,
  // so pnpm's .pnpm store resolves to its physical location.
  try {
    let directory = path.dirname(requireFrom.resolve(packageName));
    for (let depth = 0; depth < 20; depth += 1) {
      try {
        const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
        if (manifest?.name === packageName) return directory;
      } catch {
        // Not the package root; keep climbing.
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    // Not resolvable through the runtime at all.
  }

  return undefined;
}

/**
 * Locates a font package's directory so its files can be read. Resolution
 * order: the supplied `resolvePackage` hook first (for installs such as Yarn
 * Plug'n'Play that do not lay out ancestor `node_modules` directories), then
 * the active runtime resolver, then an upward `node_modules` walk so hoisted
 * workspace dependencies work.
 */
export function findPackageDirectory(
  packageName: string,
  cwd = process.cwd(),
  resolvePackage?: (packageName: string) => string | undefined,
): string {
  assertPackageName(packageName);
  // `createRequire` requires an absolute filename, so resolve a possibly
  // relative `cwd` once at the public boundary and reuse the absolute value
  // for both the runtime resolver and the upward walk below.
  const absoluteCwd = path.resolve(cwd);
  const custom = resolvePackage?.(packageName);
  if (custom) return custom;

  const resolved = resolveByRequire(packageName, absoluteCwd);
  if (resolved) return resolved;

  const searched: string[] = [];
  let directory = absoluteCwd;

  for (;;) {
    const candidate = path.join(directory, "node_modules", packageName);
    searched.push(candidate);
    if (existsSync(candidate)) return candidate;

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(
    `Cannot find ${packageName}. Looked in:\n  ${searched.join("\n  ")}`,
  );
}

/** Loads Satori-compatible TTF, OTF, or WOFF faces from installed packages. */
export async function loadPackageFonts(
  fonts: readonly PackageFont[],
  options: PackageFontOptions = {},
): Promise<LoadedFont[]> {
  return Promise.all(
    fonts.map(async (font) => {
      const directory = findPackageDirectory(
        font.package,
        options.cwd,
        options.resolvePackage,
      );
      const bytes = await readFile(resolveFontFile(directory, font.file));
      return loadedFont(font, bytes);
    }),
  );
}

type FontsourceMetadata = {
  id: string;
  family: string;
  defSubset: string;
  weights?: unknown;
  styles?: unknown;
};

function fontsourcePackageName(font: string): string {
  const packageName = font.startsWith("@") ? font : `@fontsource/${font}`;
  if (!packageName.startsWith("@fontsource/")) {
    throw new Error(`Fontsource packages must use the @fontsource scope: ${font}`);
  }
  assertPackageName(packageName);
  return packageName;
}

function fontsourceMetadata(directory: string, packageName: string): FontsourceMetadata {
  const metadata = JSON.parse(
    readFileSync(resolveFontFile(directory, "metadata.json"), "utf8"),
  ) as Partial<FontsourceMetadata>;
  if (
    typeof metadata.id !== "string" ||
    !PACKAGE_SEGMENT.test(metadata.id) ||
    typeof metadata.family !== "string" ||
    metadata.family.length === 0 ||
    typeof metadata.defSubset !== "string" ||
    !PACKAGE_SEGMENT.test(metadata.defSubset)
  ) {
    throw new Error(`${packageName} has invalid Fontsource metadata.`);
  }
  return metadata as FontsourceMetadata;
}

/**
 * Loads static Fontsource faces using the installed package's family and
 * default-subset metadata, so callers do not need to discover internal paths.
 */
export async function loadFontsourceFonts(
  fonts: readonly FontsourceFont[],
  options: PackageFontOptions = {},
): Promise<LoadedFont[]> {
  return Promise.all(
    fonts.map(async (font) => {
      const packageName = fontsourcePackageName(font.font);
      const directory = findPackageDirectory(
        packageName,
        options.cwd,
        options.resolvePackage,
      );
      const metadata = fontsourceMetadata(directory, packageName);
      const subset = font.subset ?? metadata.defSubset;
      if (!PACKAGE_SEGMENT.test(subset)) {
        throw new Error(`Invalid Fontsource subset: ${subset}`);
      }
      const weight = font.weight ?? 400;
      const style = font.style ?? "normal";
      const file = `files/${metadata.id}-${subset}-${weight}-${style}.woff`;
      const bytes = await readFile(resolveFontFile(directory, file));
      return loadedFont(
        {
          name: font.name ?? metadata.family,
          weight,
          style,
          ...(font.lang === undefined ? {} : { lang: font.lang }),
        },
        bytes,
      );
    }),
  );
}

/**
 * Memoizes a font set so repeated development requests do not reread files.
 * A failed load is discarded rather than memoized, so a long-lived dev server
 * recovers once the package or file has been fixed.
 */
export function packageFontLoader(
  fonts: readonly PackageFont[],
  options: PackageFontOptions = {},
): () => Promise<LoadedFont[]> {
  return memoizedFontLoader(() => loadPackageFonts(fonts, options));
}

/** Memoizes Fontsource faces across renders. */
export function fontsourceFontLoader(
  fonts: readonly FontsourceFont[],
  options: PackageFontOptions = {},
): () => Promise<LoadedFont[]> {
  return memoizedFontLoader(() => loadFontsourceFonts(fonts, options));
}

/** A Fontsource family to fall back to for one language. */
export type FontsourceLanguageFont = Omit<FontsourceFont, "weight" | "subset" | "lang"> & {
  /**
   * Defaults to 400. Several weights load one face each (only the subset
   * files the copy needs), and Satori draws each run with the closest one.
   */
  weight?: FontWeight | readonly FontWeight[];
};

/**
 * Fontsource families per Satori language code. A string is a Fontsource id
 * (`"noto-sans-jp"`) or package name, loaded at weight 400.
 */
export type FontsourceLanguageFonts = Partial<Record<LanguageCode, string | FontsourceLanguageFont>>;

function assertFontsourceFace(
  packageName: string,
  metadata: FontsourceMetadata,
  weight: FontWeight,
  style: string,
): void {
  const weights = Array.isArray(metadata.weights) ? metadata.weights : undefined;
  const styles = Array.isArray(metadata.styles) ? metadata.styles : undefined;
  if ((weights && !weights.includes(weight)) || (styles && !styles.includes(style))) {
    throw new Error(
      `${packageName} has no ${weight} ${style} face. ` +
        `Available weights: ${weights?.join(", ") ?? "unknown"}; styles: ${styles?.join(", ") ?? "unknown"}.`,
    );
  }
}

async function fontsourceUnicodeRanges(directory: string, packageName: string) {
  let text: string;
  try {
    text = await readFile(resolveFontFile(directory, "unicode.json"), "utf8");
  } catch (error) {
    throw new Error(
      `${packageName} has no readable unicode.json, which maps its subset files to the ` +
        "characters they cover (Fontsource 5 packages ship one).",
      { cause: error },
    );
  }
  return parseUnicodeRanges(JSON.parse(text) as Record<string, string>);
}

/**
 * Falls back to installed Fontsource families for scripts the plate's fonts
 * do not cover, offline. Pass the result as a plate's `languageFonts` option.
 * Nothing is read until Satori first asks for a configured language; then
 * the package's `metadata.json` and `unicode.json` are read once, and only
 * the subset files covering the requested characters are read, each once.
 * A missing package or file fails that render and is retried by the next.
 * Node-compatible runtimes only; on an edge runtime use `languageFontLoader`
 * from `metaplate/font-data`.
 */
export function fontsourceLanguageFontLoader(
  fonts: FontsourceLanguageFonts,
  options: PackageFontOptions = {},
): LanguageFontLoader {
  const codes = languageCodes(fonts);
  const families = new Map(
    codes.map((code) => {
      const entry = fonts[code]!;
      const font: FontsourceLanguageFont = typeof entry === "string" ? { font: entry } : entry;
      // Validate ids now, so a typo fails at definition time.
      return [code, { font, packageName: fontsourcePackageName(font.font) }] as const;
    }),
  );

  return createLanguageFontLoader(codes, async (code) => {
    const { font, packageName } = families.get(code)!;
    const directory = findPackageDirectory(packageName, options.cwd, options.resolvePackage);
    const metadata = fontsourceMetadata(directory, packageName);
    const subsets = await fontsourceUnicodeRanges(directory, packageName);
    const style = font.style ?? "normal";
    const weights: readonly FontWeight[] =
      font.weight === undefined ? [400] : typeof font.weight === "number" ? [font.weight] : font.weight;
    return weights.map((weight) => {
      assertFontsourceFace(packageName, metadata, weight, style);
      return {
        name: font.name ?? metadata.family,
        weight,
        style,
        subsets,
        load: (subset: string | undefined) =>
          readFile(resolveFontFile(directory, `files/${metadata.id}-${subset ?? metadata.defSubset}-${weight}-${style}.woff`)),
      };
    });
  });
}

/**
 * An npm package of per-emoji image files named by code point, such as
 * `1f44b-1f3fd.svg`, `1F44B-1F3FD.svg`, or Noto's `emoji_u1f44b_1f3fd.svg`.
 * `"twemoji"` reads `@twemoji/svg` and `"openmoji"` reads the color SVGs of
 * `openmoji`; any other package names the directory, relative to the package,
 * that holds the files.
 */
export type PackageEmojiSet =
  | "twemoji"
  | "openmoji"
  | {
      package: string;
      /** Package-relative directory of the image files. Defaults to the package root. */
      directory?: string;
    };

const EMOJI_SETS = {
  twemoji: { package: "@twemoji/svg", directory: "" },
  openmoji: { package: "openmoji", directory: "color/svg" },
} as const;

/**
 * Twemoji (`1f44b-1f3fd.svg`), OpenMoji (`1F44B-1F3FD.svg`), and Noto Emoji
 * (`emoji_u1f44b_1f3fd.svg`) file names.
 */
const EMOJI_FILE = /^(?:emoji_u)?([0-9a-f]{1,6}(?:[-_][0-9a-f]{1,6})*)\.(svg|png)$/i;

function emojiDirectory(set: PackageEmojiSet, options: PackageFontOptions): string {
  const { package: packageName, directory } = typeof set === "string" ? EMOJI_SETS[set] : set;
  const root = findPackageDirectory(packageName, options.cwd, options.resolvePackage);
  return directory ? resolveFontFile(root, directory, "Emoji directory") : root;
}

/**
 * Maps each emoji key to its file. Keys drop U+FE0F, so a set that writes
 * `2764.svg` and one that writes `2764-FE0F.svg` both answer `"❤"` and
 * `"❤️"`; SVG wins over PNG when a set ships both.
 */
async function emojiIndex(directory: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const name of await readdir(directory)) {
    const match = EMOJI_FILE.exec(name);
    if (!match) continue;
    const key = emojiKey(match[1]!.split(/[-_]/).map((part) => Number.parseInt(part, 16)));
    const existing = index.get(key);
    if (existing === undefined || (/\.png$/i.test(existing) && /\.svg$/i.test(name))) {
      index.set(key, name);
    }
  }
  return index;
}

/**
 * Renders emoji from an installed npm package of SVG files, offline and
 * deterministically: the directory is listed once, then each emoji is read on
 * first use and memoized. An emoji the package has no file for resolves to
 * `undefined`, and Satori draws it with the plate's fonts. Node-compatible
 * runtimes only; on an edge runtime use `emojiLoader` from `metaplate/emoji`.
 */
export function packageEmojiLoader(
  set: PackageEmojiSet,
  options: PackageFontOptions = {},
): EmojiLoader {
  let indexed: Promise<{ directory: string; index: Map<string, string> }> | undefined;
  const files = () => {
    indexed ??= (async () => {
      const directory = emojiDirectory(set, options);
      return { directory, index: await emojiIndex(directory) };
    })().catch((error: unknown) => {
      indexed = undefined;
      throw error;
    });
    return indexed;
  };

  return emojiLoader(async ({ codepoints }) => {
    const { directory, index } = await files();
    const file = index.get(emojiKey(codepoints));
    return file === undefined ? undefined : readFile(path.join(directory, file));
  });
}
