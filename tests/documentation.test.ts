import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readme = await readFile(new URL("../docs/rendering.md", import.meta.url), "utf8");

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
