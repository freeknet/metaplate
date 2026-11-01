import { describe, expect, it } from "vitest";
import type { ResvgRenderOptions as UpstreamResvgRenderOptions } from "@resvg/resvg-js";
import type { SatoriOptions as UpstreamSatoriOptions } from "satori";
import type { ReactElement } from "react";
import { createNextOg, type NextOgDefinition } from "../src/next.js";
import { createNodeOg, type NodeOgDefinition, type ResvgRenderOptions } from "../src/node.js";
import {
  createSvgOg,
  type PlateContext,
  type SatoriNode,
  type SatoriOptions,
  type SvgOgDefinition,
} from "../src/render.js";
import {
  socialImageMetadata,
  type SocialCompatibilityImage,
  type SocialImageMetadata,
  type SocialImageVerificationDescriptor,
  type TwitterCard,
  type TwitterImageOptions,
  type XCard,
  type XImageOptions,
} from "../src/index.js";

// Satori's TwConfig is an interface with named properties and no string index
// signature, so a `Record<string, unknown>` mirror would reject it. The local
// `tailwindConfig?: object` boundary must accept an upstream-typed config
// without importing Satori's React-dependent declarations. This assignment is
// checked by `tsc`; if the mirror narrows again, this line stops compiling.
const withUpstreamConfig: SatoriOptions = {
  tailwindConfig: {} as unknown as NonNullable<UpstreamSatoriOptions["tailwindConfig"]>,
};
void withUpstreamConfig;

// Satori's runtime handles bigint nodes and React 19's ReactNode can carry
// them, so the local element tree must too.
const bigintNode: SatoriNode = 42n;
void bigintNode;

// The local Resvg options mirror keeps metaplate/node free of Resvg's
// `/// <reference types="node" />` declaration while accepting every option
// object typed by the upstream renderer.
const resvgOptions: ResvgRenderOptions = {} as UpstreamResvgRenderOptions;
void resvgOptions;

// The additive X Card option must not widen the original default call's
// literal return type, while a configured card preserves its own literal.
const defaultMetadata: SocialImageMetadata = socialImageMetadata("/", "card");
const defaultCard: "summary_large_image" = defaultMetadata.twitter.card;
const summaryCard: "summary" = socialImageMetadata("/", "card", {
  twitter: { card: "summary" },
}).twitter.card;
const xCardAlias: XCard = "summary_large_image";
const twitterCardAlias: TwitterCard = xCardAlias;
const xOptions: XImageOptions = { card: twitterCardAlias };
const twitterOptions: TwitterImageOptions = xOptions;
void defaultCard;
void summaryCard;
void twitterOptions;

const compatibilityInput: SocialCompatibilityImage = { width: 1200, height: 630, type: "image/png" };
const verificationInput: SocialImageVerificationDescriptor = { type: "image/png" };
void compatibilityInput;
void verificationInput;

// Size variants add a second `context` argument to every plate component.
// Components written before variants take one argument and must still be
// accepted everywhere a component is: inline, as a named function, through
// each definition type, and with an explicit `Copy` type argument.
type Copy = { title: string };
const fonts = () => [{ name: "Inter", data: new ArrayBuffer(1), weight: 700 as const }];
function legacyCard(copy: Copy): SatoriNode {
  return { type: "div", props: { children: copy.title } };
}
const legacySvg: SvgOgDefinition<Copy> = { alt: (copy) => copy.title, fonts, component: legacyCard };
const legacyNode: NodeOgDefinition<Copy> = { ...legacySvg, component: (copy) => legacyCard(copy) };
const legacyNext: NextOgDefinition<Copy> = {
  alt: (copy) => copy.title,
  component: (copy) => copy.title as unknown as ReactElement,
};
createSvgOg(legacySvg);
createSvgOg<Copy>({ alt: (copy) => copy.title, fonts, component: (copy) => copy.title });
createNodeOg(legacyNode);
createNextOg(legacyNext);
createNextOg<Copy>({ alt: (copy) => copy.title, component: () => null as unknown as ReactElement });

// Without explicit type arguments, variant names are inferred from the
// declaration: the component's context and `plate.variant` both use them.
const inferred = createSvgOg({
  alt: (copy: Copy) => copy.title,
  fonts,
  variants: { square: { size: { width: 1080, height: 1080 } } },
  component: (copy, context) => {
    const variant: "square" | undefined = context.variant;
    void variant;
    return copy.title;
  },
});
const inferredNames: readonly "square"[] = inferred.variants;
void inferredNames;
inferred.variant("square").variant("square");
inferred.metadata("/", { title: "t" }, { twitter: { variant: "square" } });

// An explicit `Copy` falls back to `string` names; the context stays typed.
const explicitContext = (_copy: Copy, context: PlateContext): SatoriNode =>
  `${context.variant ?? "default"} ${context.size.width}x${context.size.height}`;
const explicit = createNodeOg<Copy>({ ...legacySvg, component: explicitContext });

// Compile-only: these would throw at runtime for undeclared names.
export function variantNamesAreChecked() {
  // @ts-expect-error -- `story` is not a declared variant.
  inferred.variant("story");
  // @ts-expect-error -- the X Card variant must be declared too.
  inferred.metadata("/", { title: "t" }, { twitter: { variant: "story" } });
  explicit.variant("any-name");
}

describe("React-free type mirror", () => {
  it("is exercised by the type-level assertions above", () => {
    expect(true).toBe(true);
  });
});
