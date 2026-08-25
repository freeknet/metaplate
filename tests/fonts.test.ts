import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  findPackageDirectory,
  fileFontLoader,
  fontLoader,
  fontsourceFontLoader,
  loadFileFonts,
  loadFonts,
  loadFontsourceFonts,
  loadPackageFonts,
  packageFontLoader,
} from "../src/fonts.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "metaplate-"));
  const packageDirectory = path.join(root, "node_modules", "@fontsource", "example");
  await mkdir(path.join(packageDirectory, "files"), { recursive: true });
  await writeFile(path.join(packageDirectory, "files", "example.woff"), Uint8Array.of(1, 2, 3));
  await writeFile(
    path.join(packageDirectory, "metadata.json"),
    JSON.stringify({ id: "example", family: "Example Sans", defSubset: "latin" }),
  );
  await writeFile(
    path.join(packageDirectory, "files", "example-latin-400-normal.woff"),
    Uint8Array.of(4, 5, 6),
  );
  return { root, packageDirectory, nested: path.join(root, "apps", "site") };
}

describe("font loading", () => {
  it("normalizes existing application font bytes and memoizes lazy sources", async () => {
    const backing = Uint8Array.of(9, 1, 2, 3, 8);
    const load = vi.fn(() => backing.subarray(1, 4));
    const fonts = [{ name: "Existing", data: load, weight: 400 }] as const;

    expect(new Uint8Array((await loadFonts(fonts))[0]!.data)).toEqual(Uint8Array.of(1, 2, 3));
    const memoized = fontLoader(fonts);
    expect(await memoized()).toBe(await memoized());
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("loads relative and co-located project font files", async () => {
    const { root } = await fixture();
    const projectFile = path.join(root, "project.woff");
    await writeFile(projectFile, Uint8Array.of(7, 8, 9));
    const relative = [{ name: "Project", file: "project.woff", weight: 700 }] as const;
    const coLocated = [
      { name: "Project", file: pathToFileURL(projectFile), weight: 700 },
    ] as const;

    expect(new Uint8Array((await loadFileFonts(relative, { cwd: root }))[0]!.data)).toEqual(
      Uint8Array.of(7, 8, 9),
    );
    const memoized = fileFontLoader(coLocated);
    expect(await memoized()).toBe(await memoized());
  });

  it("rejects non-file URLs for project fonts", async () => {
    await expect(loadFileFonts([
      { name: "Remote", file: new URL("https://example.com/font.woff"), weight: 400 },
    ])).rejects.toThrow(/file: protocol/);
  });

  it("infers Fontsource family, subset, and package file", async () => {
    const { root } = await fixture();
    const [font] = await loadFontsourceFonts([{ font: "example" }], { cwd: root });
    expect(font).toMatchObject({ name: "Example Sans", weight: 400, style: "normal" });
    expect(new Uint8Array(font!.data)).toEqual(Uint8Array.of(4, 5, 6));

    const memoized = fontsourceFontLoader([{ font: "@fontsource/example" }], { cwd: root });
    expect(await memoized()).toBe(await memoized());
  });

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
