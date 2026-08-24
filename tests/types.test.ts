import { describe, expect, it } from "vitest";
import type { ResvgRenderOptions as UpstreamResvgRenderOptions } from "@resvg/resvg-js";
import type { SatoriOptions as UpstreamSatoriOptions } from "satori";
import type { ResvgRenderOptions } from "../src/node.js";
import type { SatoriNode, SatoriOptions } from "../src/render.js";

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

describe("React-free type mirror", () => {
  it("is exercised by the type-level assertions above", () => {
    expect(true).toBe(true);
  });
});
