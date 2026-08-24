import { describe, expect, it } from "vitest";
import type { ResvgRenderOptions as UpstreamResvgRenderOptions } from "@resvg/resvg-js";
import type { SatoriOptions as UpstreamSatoriOptions } from "satori";
import type { ResvgRenderOptions } from "../src/node.js";
import type { SatoriNode, SatoriOptions } from "../src/render.js";
import {
  socialImageMetadata,
  type SocialImageMetadata,
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

describe("React-free type mirror", () => {
  it("is exercised by the type-level assertions above", () => {
    expect(true).toBe(true);
  });
});
