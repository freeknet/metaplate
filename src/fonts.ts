import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

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

export type PackageFont = {
  name: string;
  package: string;
  /** Path relative to the package directory, such as `files/font-latin-700-normal.woff`. */
  file: string;
  weight: FontWeight;
  style?: "normal" | "italic";
  /** Optional BCP 47 language tag passed through to Satori's font selection. */
  lang?: string;
};

export type LoadedFont = {
  name: string;
  data: ArrayBuffer;
  weight: FontWeight;
  style: "normal" | "italic";
  /** Optional BCP 47 language tag passed through to Satori's font selection. */
  lang?: string;
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
      const data = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;

      return {
        name: font.name,
        data,
        weight: font.weight,
        style: font.style ?? "normal",
        ...(font.lang === undefined ? {} : { lang: font.lang }),
      };
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
  let loaded: Promise<LoadedFont[]> | undefined;
  return () => {
    loaded ??= loadPackageFonts(fonts, options).catch((error: unknown) => {
      loaded = undefined;
      throw error;
    });
    return loaded;
  };
}
