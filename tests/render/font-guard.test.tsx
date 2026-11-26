import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fontLoader } from "../../src/font-data.js";
import { createNodeOg } from "../../src/node.js";
import { createSvgOg, type SatoriNode } from "../../src/render.js";
import { RenderGuardError, type RenderGuardIssue } from "../../src/render/guards.js";

// Real renders load Satori and fonts; cold macOS and Windows runners exceed
// Vitest's five-second default.
const RENDER_TIMEOUT = 30_000;

const interBold = readFileSync(
  path.join(import.meta.dirname, "../../node_modules/@fontsource/inter/files/inter-latin-700-normal.woff"),
);
const interRegular = readFileSync(
  path.join(import.meta.dirname, "../../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff"),
);
const plateFonts = fontLoader([{ name: "Inter", weight: 700, data: interBold }]);
const size = { width: 400, height: 200 } as const;

type Tree = () => SatoriNode | React.ReactElement;

/** Issues the fontFallback guard reports for one SVG render of `tree`. */
async function issuesFor(tree: Tree, options: Partial<Parameters<typeof createSvgOg>[0]> = {}) {
  const issues: RenderGuardIssue[] = [];
  const plate = createSvgOg({
    alt: () => "card",
    fonts: plateFonts,
    size,
    component: tree as () => SatoriNode,
    guards: { fontFallback: "warn", onWarning: (issue) => issues.push(issue) },
    ...options,
  });
  await plate.renderSvg({});
  return issues;
}

const root = (style: React.CSSProperties, children: React.ReactNode) => (
  <div style={{ display: "flex", width: "100%", height: "100%", ...style }}>{children}</div>
);

describe("fontFallback guard", () => {
  it("passes text whose family stack, weight, and style a loaded face provides", async () => {
    expect(await issuesFor(() => root({ fontFamily: "Inter", fontWeight: 700 }, "Plain"))).toEqual([]);
    // Satori matches case-insensitively, unquoted, and through the stack; generic names are skipped.
    expect(await issuesFor(() => root({ fontFamily: "'Missing', inter, sans-serif", fontWeight: "bold" }, "Stack"))).toEqual([]);
    // With no family named, Satori uses the first loaded font.
    expect(await issuesFor(() => root({ fontWeight: 700 }, "Default"))).toEqual([]);
  }, RENDER_TIMEOUT);

  it("reports a family stack with no loaded family, naming what is loaded", async () => {
    const [issue, ...rest] = await issuesFor(() => root({ fontFamily: "JetBrains Mono, monospace", fontWeight: 700 }, "Code"));
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({
      guard: "fontFallback",
      missing: "family",
      element: "div",
      text: "Code",
      fontFamily: "JetBrains Mono, monospace",
      loaded: ["Inter 700 normal"],
    });
    expect(issue?.message).toContain("so it is drawn with Inter");
  }, RENDER_TIMEOUT);

  it("reports an inherited weight or style the family has no face for, once per request", async () => {
    const issues = await issuesFor(() =>
      root({ fontFamily: "Inter", fontWeight: 400 }, [
        <span key="a">Light one</span>,
        <span key="b">Light two</span>,
        <span key="c" style={{ fontWeight: 700, fontStyle: "italic" }}>Slanted</span>,
      ]));
    expect(issues.map((issue) => issue.guard === "fontFallback" && [issue.missing, issue.element, issue.text, issue.fontWeight, issue.fontStyle]))
      .toEqual([["face", "span", "Light one", 400, "normal"], ["face", "span", "Slanted", 700, "italic"]]);
    expect(issues[0]?.message).toContain("the loaded Inter faces are 700 normal");
  }, RENDER_TIMEOUT);

  it("follows function components and skips values it cannot resolve", async () => {
    const Label = ({ children }: { children: string }) => <span style={{ fontWeight: 300 }}>{children}</span>;
    const [issue] = await issuesFor(() => root({ fontFamily: "Inter", fontWeight: 700 }, <Label>Inside</Label>));
    expect(issue).toMatchObject({ missing: "face", text: "Inside", fontWeight: 300 });
    // Satori has no rule for a relative weight, so nothing is reported.
    expect(await issuesFor(() => root({ fontFamily: "Inter", fontWeight: "bolder" }, "Relative"))).toEqual([]);
  }, RENDER_TIMEOUT);

  it("starts each element from Satori's default style for its tag", async () => {
    // Only Inter 700 loaded: headings and <strong>/<b> ask for bold, which is loaded.
    expect(await issuesFor(() => root({}, [<h1 key="h">Heading</h1>, <strong key="s">Strong</strong>, <b key="b">Bold</b>]))).toEqual([]);
    const strict = createSvgOg({
      alt: () => "card",
      fonts: plateFonts,
      size,
      component: () => root({}, <h1>Heading</h1>),
      guards: { fontFallback: "error" },
    });
    await expect(strict.renderSvg({})).resolves.toMatch(/^<svg/);
    // <em> asks for italic, which is not.
    expect((await issuesFor(() => root({ fontWeight: 700 }, <em>Leaning</em>)))
      .map((issue) => issue.guard === "fontFallback" && [issue.missing, issue.element, issue.fontWeight, issue.fontStyle]))
      .toEqual([["face", "em", 700, "italic"]]);
  }, RENDER_TIMEOUT);

  it("reports text a tag's default makes bold or italic when only the regular face is loaded", async () => {
    const fonts = fontLoader([{ name: "Inter", weight: 400, data: interRegular }]);
    const summary = (issues: RenderGuardIssue[]) =>
      issues.map((issue) => issue.guard === "fontFallback" && [issue.missing, issue.element, issue.text, issue.fontWeight, issue.fontStyle]);
    for (const [Tag, weight, style] of [["h1", 700, "normal"], ["h6", 700, "normal"], ["strong", 700, "normal"], ["b", 700, "normal"], ["em", 400, "italic"], ["i", 400, "italic"]] as const) {
      expect(summary(await issuesFor(() => root({}, [<span key="p">Plain</span>, <Tag key="t">Tagged</Tag>]), { fonts })))
        .toEqual([["face", Tag, "Tagged", weight, style]]);
    }
    // The inline style overrides the tag's default.
    expect(await issuesFor(() => root({}, [<h1 key="h" style={{ fontWeight: 400 }}>Regular</h1>, <em key="e" style={{ fontStyle: "normal" }}>Upright</em>]), { fonts }))
      .toEqual([]);
  }, RENDER_TIMEOUT);

  it("resolves var() font values from custom properties in inline styles, and skips one it cannot", async () => {
    const variable = (style: Record<string, unknown>, children: React.ReactNode) => root(style as React.CSSProperties, children);
    // Declared on an ancestor, inherited, and resolved where it is used.
    const [issue, ...rest] = await issuesFor(() =>
      variable({ "--face": "Nope", "--weight": "700" }, <span style={{ fontFamily: "var(--face)", fontWeight: "var(--weight)" } as React.CSSProperties}>Variable</span>));
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({ missing: "family", fontFamily: "Nope", fontWeight: 700 });
    expect(await issuesFor(() => variable({ "--face": "Inter", fontFamily: "var(--face)", fontWeight: "var(--missing, 700)" }, "Resolved")))
      .toEqual([]);
    // An undeclared property with no fallback has no static answer: nothing is reported, not a face of the first font.
    expect(await issuesFor(() => variable({ fontFamily: "var(--undeclared)", fontWeight: 400 }, "Unknown"))).toEqual([]);
  }, RENDER_TIMEOUT);

  it("counts a family that only a language font supplies as loaded", async () => {
    const tree: Tree = () => root({ fontFamily: "Noto Sans JP", fontWeight: 700 }, "日本");
    expect((await issuesFor(tree)).map((issue) => issue.guard === "fontFallback" && issue.missing)).toEqual(["family"]);
    const data = interBold.buffer.slice(interBold.byteOffset, interBold.byteOffset + interBold.byteLength) as ArrayBuffer;
    const languageFonts = vi.fn(async () => [{ name: "Noto Sans JP", weight: 700 as const, style: "normal" as const, data }]);
    expect(await issuesFor(tree, { languageFonts })).toEqual([]);
    expect(languageFonts).toHaveBeenCalled();
  }, RENDER_TIMEOUT);

  it("fails a metaplate/node render at the error level and stays out of the way when off", async () => {
    const component = () => root({ fontFamily: "Serif Display", fontWeight: 700 }, "Headline");
    const strict = createNodeOg({ alt: () => "card", fonts: plateFonts, size, component, guards: { fontFallback: "error" } });
    const error = await strict.render({}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RenderGuardError);
    expect((error as RenderGuardError).issues.map((issue) => issue.guard)).toEqual(["fontFallback"]);
    const lenient = createNodeOg({ alt: () => "card", fonts: plateFonts, size, component });
    await expect(lenient.render({})).resolves.toBeInstanceOf(Uint8Array);
  }, RENDER_TIMEOUT);
});
