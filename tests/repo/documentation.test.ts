import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createEdgeOg } from "../../src/edge.js";
import { createNextOg } from "../../src/next.js";
import { createNodeOg } from "../../src/node.js";
import { createSvgOg } from "../../src/render.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = async (file: string) => (await readFile(path.join(root, file), "utf8")).replaceAll("\r\n", "\n");

const readme = await read("docs/rendering.md");

describe("rendering guide build-script example", () => {
  it("defines copy before passing it to render", () => {
    const start = readme.indexOf("### Authoring without a JSX toolchain");
    const end = readme.indexOf("### SVG-only rendering", start);
    const section = readme.slice(start, end);
    const copyDeclaration = section.indexOf("const copy = {");
    const renderCall = section.indexOf("await og.render(copy)");

    expect(copyDeclaration).toBeGreaterThanOrEqual(0);
    expect(renderCall).toBeGreaterThan(copyDeclaration);
  });
});

/**
 * A fenced block whose first line is `// <path>` quotes that file. The path is
 * relative to `base`, so a guide can show readers the path they will use.
 */
function quotedFiles(markdown: string, base: string) {
  return [...markdown.matchAll(/```[a-z]+\n\/\/ ([^\n ]+\.[a-z]+)\n([\s\S]*?)\n```/g)]
    .map((match) => ({ file: path.posix.join(base, match[1]!), block: `// ${match[1]}\n${match[2]}` }))
    .filter(({ file }) => file.startsWith("examples/") && existsSync(path.join(root, file)));
}

describe("code quoted from the type-checked examples", () => {
  it.each([
    ["docs/static-next-site.md", "examples/next-static-site", 10],
    ["docs/testing.md", "examples/next-static-site", 2],
    ["docs/recipes.md", "", 5],
  ])("%s matches its example files", async (doc, base, count) => {
    const quoted = quotedFiles(await read(doc), base);
    expect(quoted).toHaveLength(count);
    for (const { file, block } of quoted) {
      expect(block, file).toBe((await read(file)).trimEnd());
    }
  });
});

describe("plate reference", () => {
  const definition = {
    alt: () => "",
    fonts: () => [],
    component: () => null,
    variants: { square: { size: { width: 10, height: 10 } } },
  };

  it.each([
    ["createSvgOg", createSvgOg],
    ["createNodeOg", createNodeOg],
    ["createEdgeOg", createEdgeOg],
    ["createNextOg", createNextOg],
  ] as const)("lists every member %s returns", async (name, factory) => {
    const reference = await read("docs/plate.md");
    const header = reference.split("\n").find((line) => line.startsWith("| Member |"))!;
    const column = header.split("|").findIndex((cell) => cell.includes(`\`${name}\``));
    const rows = reference.split("\n").filter((line) => line.startsWith("| `"));
    const table = rows.filter((row) => /\| (Yes)? *\|/.test(row) && row.split("|").length === header.split("|").length);

    const documented = table
      .filter((row) => row.split("|")[column]!.trim() === "Yes")
      .flatMap((row) => [...row.split("|")[1]!.matchAll(/`(\w+)`/g)].map((match) => match[1]!));

    const plate = (factory as (value: typeof definition) => object)(definition);
    expect(documented.sort()).toEqual(Object.keys(plate).sort());
  });
});

describe("links between guides", () => {
  const slug = (heading: string) =>
    heading
      .toLowerCase()
      .replace(/[`*]/g, "")
      .replace(/[^\w\- ]/g, "")
      .replace(/ /g, "-");

  it("resolve to a file and a heading that exist", async () => {
    const docs = (await readdir(path.join(root, "docs"))).map((name) => `docs/${name}`);
    const broken: string[] = [];

    for (const doc of ["README.md", ...docs]) {
      const prose = (await read(doc)).replace(/```[\s\S]*?```/g, "");
      for (const [, target] of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/.test(target!)) continue;
        const [file, anchor] = target!.split("#");
        const resolved = file ? path.posix.join(path.posix.dirname(doc), file) : doc;
        if (!existsSync(path.join(root, resolved))) {
          broken.push(`${doc}: ${target}`);
          continue;
        }
        if (!anchor || !resolved.endsWith(".md")) continue;
        const headings = (await read(resolved)).replace(/```[\s\S]*?```/g, "").match(/^#{1,6} .+$/gm) ?? [];
        if (!headings.some((heading) => slug(heading.replace(/^#+ /, "")) === anchor)) {
          broken.push(`${doc}: ${target}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });
});
