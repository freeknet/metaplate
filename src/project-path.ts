import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Not an entry point: resolves a project file named by a path (relative to
 * `cwd`) or a `file:` URL, as `metaplate/fonts` and `metaplate/assets` accept.
 */
export function projectFilePath(file: string | URL, cwd: string, kind: string): string {
  if (file instanceof URL) {
    if (file.protocol !== "file:") {
      throw new Error(`Project ${kind} URLs must use the file: protocol: ${file.href}`);
    }
    return fileURLToPath(file);
  }
  return path.resolve(cwd, file);
}
