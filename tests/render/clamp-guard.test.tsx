import { readFileSync } from "node:fs";
import path from "node:path";
import satori from "satori";
import { describe, expect, it } from "vitest";
import { fontLoader } from "../../src/font-data.js";
import { createNodeOg } from "../../src/node.js";
import { createSvgOg, type SatoriNode } from "../../src/render.js";
import { RenderGuardError, type RenderGuardIssue } from "../../src/render/guards.js";

// Real renders load Satori and fonts; cold macOS and Windows runners exceed
// Vitest's five-second default.
const RENDER_TIMEOUT = 30_000;

const size = { width: 400, height: 300 } as const;
const inter = {
  name: "Inter",
  weight: 700 as const,
  data: readFileSync(path.join(import.meta.dirname, "../../node_modules/@fontsource/inter/files/inter-latin-700-normal.woff")),
};
const plateFonts = fontLoader([inter]);

/** Wraps to several lines in a 300px column at 20px. */
const LONG = "The quick brown fox jumps over the lazy dog again and again until the line wraps many times over";

type Tree = () => SatoriNode | React.ReactElement;

/** Issues the lineClamp guard reports for one SVG render of `tree`. */
async function issuesFor(tree: Tree) {
  const issues: RenderGuardIssue[] = [];
  const onWarning = (issue: RenderGuardIssue) => issues.push(issue);
  await createSvgOg({ alt: () => "card", fonts: plateFonts, size, component: tree as () => SatoriNode, guards: { lineClamp: "warn", onWarning } })
    .renderSvg({});
  return issues;
}

/** Whether Satori draws an ellipsis for `tree`, which is how a clamp or `textOverflow` shows it took effect. */
async function satoriTruncates(tree: Tree): Promise<boolean> {
  const svg = await satori(tree() as Parameters<typeof satori>[0], { ...size, fonts: [inter], embedFont: false });
  return svg.includes("…");
}

const column = (children: React.ReactNode, style: React.CSSProperties = {}) => (
  <div style={{ display: "flex", flexDirection: "column", width: 300, height: "100%", fontSize: 20, lineHeight: 1, ...style }}>
    {children}
  </div>
);

const summary = (issue: RenderGuardIssue | undefined) =>
  issue?.guard === "lineClamp" ? [issue.property, issue.reason, issue.element, issue.display] : issue;

describe("lineClamp guard", () => {
  it("agrees with Satori on which truncations it ignores", async () => {
    const cases: [string, Tree, boolean][] = [
      ["lineClamp on display block", () => column(<div style={{ display: "block", lineClamp: 2 }}>{LONG}</div>), true],
      ["lineClamp on a bare div (block by default)", () => column(<div style={{ lineClamp: 2 }}>{LONG}</div>), true],
      ["lineClamp on a bare p", () => column(<p style={{ lineClamp: 2, margin: 0 }}>{LONG}</p>), true],
      ["lineClamp on strings and a number", () => column(<div style={{ display: "block", lineClamp: 2 }}>{[LONG, " ", 2026]}</div>), true],
      ["lineClamp on display flex", () => column(<div style={{ display: "flex", lineClamp: 2 }}>{LONG}</div>), false],
      ["lineClamp on display grid", () => column(<div style={{ display: "grid", lineClamp: 2 }}>{LONG}</div>), false],
      ["lineClamp on inline-block", () => column(<div style={{ display: "inline-block", lineClamp: 2 }}>{LONG}</div>), false],
      ["lineClamp on -webkit-box", () => column(<div style={{ display: "-webkit-box", lineClamp: 2 }}>{LONG}</div>), false],
      ["lineClamp on a bare span (inline)", () => column(<span style={{ lineClamp: 2 }}>{LONG}</span>), false],
      ["lineClamp on a bare li (list-item)", () => column(<li style={{ lineClamp: 2 }}>{LONG}</li>), false],
      ["lineClamp with the text in a child", () => column(<div style={{ display: "block", lineClamp: 2 }}><span>{LONG}</span></div>), false],
      ["lineClamp with a block child holding the text", () => column(<div style={{ display: "block", lineClamp: 2 }}><div>{LONG}</div></div>), false],
      ["lineClamp beside an inline child", () => column(<div style={{ display: "block", lineClamp: 2 }}>{LONG}<b> more</b></div>), false],
      ["lineClamp beside a br", () => column(<div style={{ display: "block", lineClamp: 2 }}>{LONG}<br /></div>), false],
      ["lineClamp beside a block child", () => column(<div style={{ display: "block", lineClamp: 2 }}>{LONG}<div>more</div></div>), true],
      ["WebkitLineClamp with -webkit-box and vertical", () => column(<div style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }}>{LONG}</div>), true],
      ["WebkitLineClamp on display block", () => column(<div style={{ display: "block", WebkitLineClamp: 2 }}>{LONG}</div>), false],
      ["WebkitLineClamp without WebkitBoxOrient", () => column(<div style={{ display: "-webkit-box", WebkitLineClamp: 2 }}>{LONG}</div>), false],
      ["textOverflow with hidden and nowrap on flex", () => column(<div style={{ display: "flex", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{LONG}</div>), true],
      ["textOverflow on an inline span", () => column(<span style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{LONG}</span>), true],
      ["textOverflow with an inherited nowrap", () => column(<div style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{LONG}</div>, { whiteSpace: "nowrap" }), true],
      ["textOverflow with whiteSpace pre", () => column(<div style={{ overflow: "hidden", whiteSpace: "pre", textOverflow: "ellipsis" }}>{LONG}</div>), true],
      ["textOverflow with overflowX hidden", () => column(<div style={{ overflowX: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{LONG}</div>), true],
      ["textOverflow without overflow hidden", () => column(<div style={{ display: "block", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{LONG}</div>), false],
      ["textOverflow with overflow visible", () => column(<div style={{ overflow: "visible", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{LONG}</div>), false],
      ["textOverflow with overflow clip", () => column(<div style={{ overflow: "clip", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{LONG}</div>), true],
      ["textOverflow with overflowY hidden only", () => column(<div style={{ overflowY: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{LONG}</div>), true],
      ["textOverflow with overflow 'visible auto'", () => column(<div style={{ overflow: "visible auto", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{LONG}</div>), true],
      ["textOverflow on wrapping text", () => column(<div style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>{LONG}</div>), false],
      ["textOverflow with pre-line", () => column(<div style={{ overflow: "hidden", whiteSpace: "pre-line", textOverflow: "ellipsis" }}>{LONG}</div>), false],
      ["textOverflow with the text in a child", () => column(<div style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}><span>{LONG}</span></div>), false],
    ];
    const disagreements: string[] = [];
    for (const [label, tree, applies] of cases) {
      const truncated = await satoriTruncates(tree);
      const flagged = (await issuesFor(tree)).length > 0;
      // The probe itself must hold, or a Satori upgrade has changed the rules.
      if (truncated !== applies) disagreements.push(`${label}: Satori ${truncated ? "truncates" : "does not truncate"}`);
      if (flagged === applies) disagreements.push(`${label}: guard ${flagged ? "flags" : "passes"} it`);
    }
    expect(disagreements).toEqual([]);
  }, RENDER_TIMEOUT * 4);

  it("reports a clamp on a flex child, with the display and the remedy", async () => {
    const [issue, ...rest] = await issuesFor(() => column(<div style={{ display: "flex", lineClamp: 2 }}>{LONG}</div>));
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({
      guard: "lineClamp",
      variant: undefined,
      size,
      element: "div",
      text: LONG,
      property: "lineClamp",
      display: "flex",
      reason: "display",
    });
    expect(issue?.message).toMatch(/^Text "The quick brown fox.*…" in a <div> in the 400x300 plate sets lineClamp: 2, but its display is "flex"/);
    expect(issue?.message).toContain('add display: "block" to that element');
  }, RENDER_TIMEOUT);

  it("names a display that comes from the tag's default", async () => {
    const [issue] = await issuesFor(() => column(<span style={{ lineClamp: "2 \"...\"" }}>{LONG}</span>));
    expect(summary(issue)).toEqual(["lineClamp", "display", "span", "inline"]);
    expect(issue?.message).toContain('sets lineClamp: "2 \\"...\\"", but its display is "inline" (the default for <span>)');
  }, RENDER_TIMEOUT);

  it("reports text Satori does not clamp because it is not the element's own", async () => {
    const [nested] = await issuesFor(() => column(<div style={{ lineClamp: 3 }}><h2 style={{ margin: 0 }}>{LONG}</h2></div>));
    expect(summary(nested)).toEqual(["lineClamp", "children", "div", "block"]);
    expect(nested).toMatchObject({ text: LONG });
    expect(nested?.message).toContain("its text is inside a child <h2>");
    const [mixed] = await issuesFor(() => column(<div style={{ display: "block", lineClamp: 2 }}>{"By "}<b>{LONG}</b></div>));
    expect(summary(mixed)).toEqual(["lineClamp", "children", "div", "block"]);
    expect(mixed).toMatchObject({ text: "By " });
    expect(mixed?.message).toContain("its text sits beside an inline <b>");
  }, RENDER_TIMEOUT);

  it("reports a WebkitLineClamp without -webkit-box and a vertical orient", async () => {
    const [issue] = await issuesFor(() => column(<div style={{ display: "block", WebkitLineClamp: 2 }}>{LONG}</div>));
    expect(summary(issue)).toEqual(["WebkitLineClamp", "display", "div", "block"]);
    expect(issue?.message).toContain('use lineClamp with display: "block" instead');
  }, RENDER_TIMEOUT);

  it("reports a textOverflow ellipsis Satori never draws, whatever the display", async () => {
    const [overflow] = await issuesFor(() => column(<div style={{ display: "block", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{LONG}</div>));
    expect(summary(overflow)).toEqual(["textOverflow", "overflow", "div", "block"]);
    expect(overflow?.message).toContain('without overflow: "hidden"');
    const [wraps] = await issuesFor(() => column(<div style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{LONG}</div>));
    expect(summary(wraps)).toEqual(["textOverflow", "whiteSpace", "div", "block"]);
    expect(wraps?.message).toContain('its whiteSpace is "normal", which wraps');
    // display does not matter for textOverflow.
    expect(await issuesFor(() => column(<div style={{ display: "flex", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{LONG}</div>)))
      .toEqual([]);
  }, RENDER_TIMEOUT);

  it("follows function components and fragments, and skips what Satori never draws", async () => {
    const Clamp = ({ children }: { children: string }) => <div style={{ display: "flex", lineClamp: 2 }}>{children}</div>;
    const [issue] = await issuesFor(() => column(<><Clamp>{LONG}</Clamp></>));
    expect(summary(issue)).toEqual(["lineClamp", "display", "div", "flex"]);
    // Hidden elements, elements with no text, and a zero or "none" clamp are not checked.
    expect(await issuesFor(() => column([
      <div key="a" style={{ display: "none", lineClamp: 2 }}>{LONG}</div>,
      <div key="b" style={{ display: "flex", lineClamp: 2, width: 10, height: 10 }} />,
      <div key="c" style={{ display: "flex", lineClamp: 0 }}>{LONG}</div>,
      <div key="d" style={{ display: "flex", lineClamp: "none" } as React.CSSProperties}>{LONG}</div>,
    ]))).toEqual([]);
  }, RENDER_TIMEOUT);

  it("reports every ignored truncation in the tree, in document order", async () => {
    const issues = await issuesFor(() => column([
      <div key="a" style={{ display: "flex", lineClamp: 2 }}>First</div>,
      <div key="b" style={{ display: "block", lineClamp: 2 }}>Fine</div>,
      <div key="c" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>Second</div>,
    ]));
    expect(issues.map((found) => found.guard === "lineClamp" && [found.text, found.reason])).toEqual([
      ["First", "display"],
      ["Second", "whiteSpace"],
    ]);
  }, RENDER_TIMEOUT);

  it("fails a metaplate/node render at the error level and stays out of the way when off", async () => {
    const component = () => column(<div style={{ display: "flex", lineClamp: 2 }}>{LONG}</div>);
    const strict = createNodeOg({ alt: () => "card", fonts: plateFonts, size, component, guards: { lineClamp: "error" } });
    const error = await strict.render({}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RenderGuardError);
    expect((error as RenderGuardError).issues.map((found) => found.guard)).toEqual(["lineClamp"]);
    const lenient = createNodeOg({ alt: () => "card", fonts: plateFonts, size, component });
    await expect(lenient.render({})).resolves.toBeInstanceOf(Uint8Array);
  }, RENDER_TIMEOUT);

  it("rejects an invalid level where the plate is defined", () => {
    expect(() =>
      createSvgOg({ alt: () => "card", fonts: plateFonts, size, component: () => column("x"), guards: { lineClamp: "warning" as never } }),
    ).toThrow('guards.lineClamp must be "error", "warn", or "off"');
  });
});
