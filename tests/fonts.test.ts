import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  findPackageDirectory,
  loadPackageFonts,
  packageFontLoader,
} from "../src/fonts.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "metaplate-"));
  const packageDirectory = path.join(root, "node_modules", "@fontsource", "example");
  await mkdir(path.join(packageDirectory, "files"), { recursive: true });
  await writeFile(path.join(packageDirectory, "files", "example.woff"), Uint8Array.of(1, 2, 3));
  return { root, packageDirectory, nested: path.join(root, "apps", "site") };
}

describe("package fonts", () => {
  it("finds a hoisted scoped package by walking upward", async () => {
    const { packageDirectory, nested } = await fixture();
    expect(findPackageDirectory("@fontsource/example", nested)).toBe(packageDirectory);
  });

  it("loads a Satori-compatible font", async () => {
    const { root } = await fixture();
    const [font] = await loadPackageFonts(
      [{
        name: "Example",
        package: "@fontsource/example",
        file: "files/example.woff",
        weight: 700,
      }],
      { cwd: root },
    );
    expect(font?.name).toBe("Example");
    expect(new Uint8Array(font!.data)).toEqual(Uint8Array.of(1, 2, 3));
  });

  it("preserves a declared language tag for Satori font selection", async () => {
    const { root } = await fixture();
    const [font] = await loadPackageFonts(
      [{
        name: "Example",
        package: "@fontsource/example",
        file: "files/example.woff",
        weight: 700,
        lang: "ja-JP",
      }],
      { cwd: root },
    );

    expect(font?.lang).toBe("ja-JP");

    const loader = packageFontLoader(
      [{
        name: "Example",
        package: "@fontsource/example",
        file: "files/example.woff",
        weight: 700,
        lang: "ja-JP",
      }],
      { cwd: root },
    );
    expect((await loader())[0]?.lang).toBe("ja-JP");
  });

  it("names every directory it searched when a package is missing", async () => {
    const { nested } = await fixture();
    expect(() => findPackageDirectory("@fontsource/absent", nested)).toThrow(
      /Cannot find @fontsource\/absent\. Looked in:/,
    );
  });

  it.each(["../outside", "@scope/../outside", "C:\\outside"])(
    "rejects an invalid package name (%s)",
    async (packageName) => {
      const { root } = await fixture();
      expect(() => findPackageDirectory(packageName, root)).toThrow(/Invalid font package name/);
    },
  );

  it("rejects font paths that escape a normally resolved package", async () => {
    const { root, packageDirectory } = await fixture();
    const outside = path.join(root, "outside.woff");
    await writeFile(outside, Uint8Array.of(6, 6, 6));

    await expect(loadPackageFonts(
      [{
        name: "Outside",
        package: "@fontsource/example",
        file: path.relative(packageDirectory, outside),
        weight: 400,
      }],
      { cwd: root },
    )).rejects.toThrow(/must stay within its package directory/);
  });

  it("accepts a relative cwd", async () => {
    // `createRequire` requires an absolute filename, so a relative `cwd` must
    // be resolved once at the public boundary instead of reaching the runtime
    // resolver as-is (which throws ERR_INVALID_ARG_VALUE).
    const { root } = await fixture();
    const previous = process.cwd();
    process.chdir(root);
    try {
      const [font] = await loadPackageFonts(
        [{
          name: "Example",
          package: "@fontsource/example",
          file: "files/example.woff",
          weight: 700,
        }],
        { cwd: "." },
      );
      expect(font!.name).toBe("Example");
    } finally {
      process.chdir(previous);
    }
  });

  it("memoizes a declared font set", async () => {
    const { root } = await fixture();
    const loader = packageFontLoader(
      [{
        name: "Example",
        package: "@fontsource/example",
        file: "files/example.woff",
        weight: 400,
      }],
      { cwd: root },
    );
    const spy = vi.fn(loader);
    expect(await spy()).toBe(await spy());
  });

  it("consults an injected resolver before any filesystem walk", async () => {
    const { root } = await fixture();
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "custom.woff"), Uint8Array.of(9, 8, 7));

    const [font] = await loadPackageFonts(
      [{
        name: "Example",
        package: "@fontsource/example",
        file: "custom.woff",
        weight: 700,
      }],
      {
        cwd: root,
        resolvePackage: () => elsewhere,
      },
    );

    expect(font!.name).toBe("Example");
    expect(new Uint8Array(font!.data)).toEqual(Uint8Array.of(9, 8, 7));
  });

  it("rejects font paths that escape an injected package directory", async () => {
    const { root } = await fixture();
    const elsewhere = path.join(root, "elsewhere");
    const outside = path.join(root, "outside.woff");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(outside, Uint8Array.of(6, 6, 6));

    await expect(loadPackageFonts(
      [{
        name: "Outside",
        package: "@fontsource/example",
        file: path.relative(elsewhere, outside),
        weight: 400,
      }],
      { cwd: root, resolvePackage: () => elsewhere },
    )).rejects.toThrow(/must stay within its package directory/);
  });

  it("falls back to the normal layout when the resolver declines", async () => {
    const { root } = await fixture();
    const loader = packageFontLoader(
      [{
        name: "Example",
        package: "@fontsource/example",
        file: "files/example.woff",
        weight: 400,
      }],
      { cwd: root, resolvePackage: () => undefined },
    );

    await expect(loader()).resolves.toHaveLength(1);
  });

  it("discards a failed load and retries on the next call", async () => {
    const { root, packageDirectory } = await fixture();
    const file = path.join(packageDirectory, "files", "example.woff");
    // `fixture()` creates the package and font, so remove the font first:
    // the load must reject, and the rejection must not be memoized.
    await rm(file);

    const loader = packageFontLoader(
      [{
        name: "Example",
        package: "@fontsource/example",
        file: "files/example.woff",
        weight: 400,
      }],
      { cwd: root },
    );

    await expect(loader()).rejects.toThrow("ENOENT");

    // Repair the fixture: the same loader must now succeed without being
    // recreated, exactly the long-lived development-server recovery case.
    await writeFile(file, Uint8Array.of(1, 2, 3));
    await expect(loader()).resolves.toHaveLength(1);
    await expect(loader()).resolves.toHaveLength(1);
  });
});
