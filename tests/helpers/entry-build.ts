import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.join(import.meta.dirname, "..", "..");

/**
 * Builds one entry (`dist/<name>.js`) as the project's own tsup configuration
 * does, so bundle checks never depend on a stale or absent dist directory.
 * Builds once per test file; call `remove` from `afterAll`.
 */
export function entryBuilder(name: string) {
  let pending: Promise<{ outDir: string; entry: string }> | undefined;
  return {
    build() {
      pending ??= (async () => {
        const { build } = await import("tsup");
        const { default: config } = await import("../../tsup.config.js");
        const outDir = mkdtempSync(path.join(tmpdir(), `metaplate-${name}-build-`));
        await build({
          ...(config as object),
          entry: { [name]: path.join(root, "src", `${name}.ts`) },
          outDir,
          dts: false,
          sourcemap: false,
          clean: false,
          silent: true,
        });
        return { outDir, entry: path.join(outDir, `${name}.js`) };
      })();
      return pending;
    },
    async remove() {
      if (pending) rmSync((await pending).outDir, { recursive: true, force: true });
    },
  };
}
