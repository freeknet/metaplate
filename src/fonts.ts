import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadedFont,
  memoizedFontLoader,
  type FontFace,
  type FontWeight,
  type LoadedFont,
} from "./font-core.js";

export { fontLoader, loadFonts } from "./font-core.js";
export type { DataFont, FontBytes, FontWeight, LoadedFont } from "./font-core.js";

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

function resolveFontFile(packageDirectory: string, file: string): string {
  const root = path.resolve(packageDirectory);
  if (!file || path.isAbsolute(file)) {
    throw new Error(`Font file must stay within its package directory: ${file}`);
  }
  const target = path.resolve(root, file);
  const relative = path.relative(root, target);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Font file must stay within its package directory: ${file}`);
  }
  return target;
}

function projectFontPath(file: string | URL, cwd: string): string {
  if (file instanceof URL) {
    if (file.protocol !== "file:") {
      throw new Error(`Project font URLs must use the file: protocol: ${file.href}`);
    }
    return fileURLToPath(file);
  }
  return path.resolve(cwd, file);
}

/** Loads co-located or otherwise project-managed font files. */
export async function loadFileFonts(
  fonts: readonly FileFont[],
  options: FileFontOptions = {},
): Promise<LoadedFont[]> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return Promise.all(
    fonts.map(async (font) => loadedFont(font, await readFile(projectFontPath(font.file, cwd)))),
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
