import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { ImageFormat } from "../image.js";

/**
 * Not an entry point: turns `metaplate verify` operands into files, so a
 * directory or a glob works the same from every shell. npm runs scripts
 * through `cmd.exe` on Windows, which expands no globs, and Node 20 has no
 * `fs.glob`, so the matching is done here.
 *
 * - An existing file is itself, even when its name holds glob characters.
 * - An existing directory is every image file below it, by extension, limited
 *   to the operand's `--format` when one is given.
 * - Otherwise an operand with `*`, `?`, `[...]`, or `{a,b}` is a glob: `*` and
 *   `?` stay within one path segment, `**` spans any number of directories,
 *   and hidden entries match only a segment that starts with a dot.
 * - Anything else is left as written, so a missing file is reported as before.
 *
 * Symbolic links to files count as files; links to directories are not
 * followed, so no walk can loop. Results are sorted, and a file named by two
 * operands is checked once.
 */

const EXTENSIONS: Readonly<Record<ImageFormat, readonly string[]>> = {
  svg: [".svg"],
  png: [".png"],
  jpeg: [".jpg", ".jpeg"],
  webp: [".webp"],
  gif: [".gif"],
};

const ALL_EXTENSIONS = new Set(Object.values(EXTENSIONS).flat());

const GLOB_CHARACTERS = /[*?[{]/;

/** Path separators: `/` everywhere, and `\` on Windows. */
const SEPARATORS = process.platform === "win32" ? /[\\/]+/ : /\/+/;

function isImageFile(name: string, format: ImageFormat | undefined): boolean {
  const extension = path.extname(name).toLowerCase();
  return format ? EXTENSIONS[format].includes(extension) : ALL_EXTENSIONS.has(extension);
}

async function kind(file: string): Promise<"file" | "directory" | undefined> {
  try {
    const found = await stat(file);
    if (found.isDirectory()) return "directory";
    return found.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

type Entry = { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };

/** A file, or a symbolic link to one; links to directories are not followed, so a walk cannot loop. */
async function isFileEntry(entry: Entry, full: string): Promise<boolean> {
  if (entry.isFile()) return true;
  return entry.isSymbolicLink() && (await kind(full)) === "file";
}

/** Every file below `directory`; with `skipHidden`, entries whose names start with a dot are left out. */
async function walk(directory: string, skipHidden = false): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skipHidden && entry.name.startsWith(".")) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, skipHidden)));
    else if (await isFileEntry(entry, full)) files.push(full);
  }
  return files;
}

/** Expands `{a,b}` alternatives into separate patterns, innermost first. */
function braces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const before = pattern.slice(0, match.index);
  const after = pattern.slice(match.index + match[0].length);
  return match[1]!.split(",").flatMap((choice) => braces(`${before}${choice}${after}`));
}

/** One path segment's pattern as a regular expression. */
function segmentPattern(segment: string): RegExp {
  let source = "";
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]!;
    if (character === "*") source += "[^/\\\\]*";
    else if (character === "?") source += "[^/\\\\]";
    else if (character === "[") {
      const close = segment.indexOf("]", index + 2);
      if (close === -1) {
        source += "\\[";
        continue;
      }
      const body = segment.slice(index + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      const members = (negated ? body.slice(1) : body).replace(/[\\\]^]/g, "\\$&");
      source += `[${negated ? "^" : ""}${members}]`;
      index = close;
    } else source += character.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  // Windows file names compare case-insensitively.
  return new RegExp(`^${source}$`, process.platform === "win32" ? "i" : "");
}

/** Files matching one brace-free glob, walking only the directories it can reach. */
async function glob(pattern: string): Promise<string[]> {
  const absolute = path.isAbsolute(pattern);
  const parts = pattern.split(SEPARATORS).filter((part, index) => part !== "" || index === 0);
  // The literal prefix before the first segment with a glob character.
  const firstGlob = parts.findIndex((part) => GLOB_CHARACTERS.test(part));
  let base = parts.slice(0, firstGlob).join(path.sep) || (absolute ? path.sep : ".");
  // A bare drive (`C:`) means that drive's current directory; the pattern meant its root.
  if (/^[A-Za-z]:$/.test(base)) base += path.sep;
  const rest = parts.slice(firstGlob);
  const found: string[] = [];

  async function visit(directory: string, index: number): Promise<void> {
    const segment = rest[index];
    if (segment === undefined) return;
    const last = index === rest.length - 1;
    if (segment === "**") {
      // `**` matches no directory here, or descends into each one.
      if (last) {
        found.push(...(await walk(directory, true)));
        return;
      }
      await visit(directory, index + 1);
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) await visit(path.join(directory, entry.name), index);
      }
      return;
    }
    const matcher = segmentPattern(segment);
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!matcher.test(entry.name)) continue;
      // Hidden entries match only a segment that names the dot itself.
      if (entry.name.startsWith(".") && !segment.startsWith(".")) continue;
      const full = path.join(directory, entry.name);
      if (last) {
        if (await isFileEntry(entry, full)) found.push(full);
      } else if (entry.isDirectory()) await visit(full, index + 1);
    }
  }

  await visit(base, 0);
  return found;
}

/** One `verify` operand as the files it names; see the module comment. */
export async function expandVerifyOperand(operand: string, format: ImageFormat | undefined): Promise<string[]> {
  const found = await kind(operand);
  if (found === "file") return [operand];
  if (found === "directory") {
    const files = (await walk(operand)).filter((file) => isImageFile(file, format)).sort();
    if (files.length === 0) {
      throw new Error(`${operand} is a directory with no ${format ?? "image"} files in it`);
    }
    return files;
  }
  if (!GLOB_CHARACTERS.test(operand)) return [operand];
  const matches = new Set<string>();
  for (const pattern of braces(operand)) for (const file of await glob(pattern)) matches.add(file);
  if (matches.size === 0) throw new Error(`No files match ${operand}`);
  return [...matches].sort();
}
