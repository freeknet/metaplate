import { describe, expect, it } from "vitest";
import type { ResvgRenderOptions as UpstreamResvgRenderOptions } from "@resvg/resvg-js";
import type { SatoriOptions as UpstreamSatoriOptions } from "satori";
import type { ReactElement } from "react";
import type { Metadata, Viewport } from "next";
import {
  NEXT_OPEN_GRAPH_TYPES,
  createNextOg,
  nextPageMetadata,
  nextPageViewport,
  nextTwitterMetadata,
  type NextOgDefinition,
  type NextOpenGraphType,
} from "../src/next.js";
import {
  createNodeOg,
  type NodeOgDefinition,
  type RenderJob,
  type RenderModule,
  type ResvgRenderOptions,
} from "../src/node.js";
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
  type XAppCard,
  type XAppStoreListing,
  type XCard,
  type XCardMetadata,
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

// A render job is checked against its plate's copy, for every size; a
// renderer that cannot produce artifacts is not a renderable plate.
export function renderJobsAreChecked() {
  const plate = createNodeOg<Copy, "square">({
    ...legacySvg,
    variants: { square: { size: { width: 1080, height: 1080 } } },
  });
  const job = { plate, pages: [{ copy: { title: "t" } }] } satisfies RenderJob<Copy>;
  const square = { plate: plate.variant("square"), pages: [{ route: "/a", copy: { title: "t" } }] } satisfies RenderJob<Copy>;
  const module: RenderModule = async () => [job, square];
  // @ts-expect-error -- the copy must match the plate's.
  const wrongCopy: RenderJob<Copy> = { plate, pages: [{ copy: { heading: "t" } }] };
  const svg = createSvgOg<Copy>({ ...legacySvg });
  // @ts-expect-error -- an SVG-only plate has no artifact().
  const svgJob: RenderJob<Copy> = { plate: svg, pages: [{ copy: { title: "t" } }] };
  return [module, wrongCopy, svgJob];
}

// X player and app cards are discriminated by `card`: each requires its own
// payload, rejects the other's, and keeps its literal in the return type.
const playerOptions = { url: "https://example.com/embed/1", width: 640, height: 360, stream: "https://example.com/1.mp4" };
const playerMetadata = socialImageMetadata("/", "card", {
  twitter: { card: "player", site: "@example", player: playerOptions },
});
const playerCard: "player" = playerMetadata.twitter.card;
const playerUrl: string = playerMetadata.twitter.player.url;
const appMetadata = socialImageMetadata("/", "card", {
  twitter: { card: "app", site: "@example", description: "Get the app", app: { googleplay: { id: "com.example" } } },
});
const appCard: "app" = appMetadata.twitter.card;
const appListing: XAppStoreListing | undefined = appMetadata.twitter.app.googleplay;
const wideCards: XCardMetadata[] = [playerMetadata.twitter, appMetadata.twitter, defaultMetadata.twitter];
const xPlayerOptions: XImageOptions = { card: "player", siteId: "1", player: playerOptions };
const appOnlyIpad: XAppCard = { ipad: { id: "123" }, country: "GB" };
const nextTwitter: Metadata["twitter"] = nextTwitterMetadata(playerMetadata.twitter);
void [playerCard, playerUrl, appCard, appListing, wideCards, xPlayerOptions, appOnlyIpad, nextTwitter];

// Compile-only: each of these would also throw at runtime.
export function xCardPayloadsAreChecked() {
  // @ts-expect-error -- a player card requires `player`.
  socialImageMetadata("/", "card", { twitter: { card: "player", site: "@e" } });
  // @ts-expect-error -- `player` requires a width and height.
  socialImageMetadata("/", "card", { twitter: { card: "player", site: "@e", player: { url: "https://example.com/e" } } });
  // @ts-expect-error -- an app card requires `app`.
  socialImageMetadata("/", "card", { twitter: { card: "app", site: "@e" } });
  // @ts-expect-error -- `app` requires at least one platform listing.
  socialImageMetadata("/", "card", { twitter: { card: "app", site: "@e", app: { country: "GB" } } });
  // @ts-expect-error -- a listing requires its app id.
  socialImageMetadata("/", "card", { twitter: { card: "app", site: "@e", app: { iphone: { name: "Example" } } } });
  // @ts-expect-error -- a summary card takes no player payload.
  socialImageMetadata("/", "card", { twitter: { card: "summary", player: playerOptions } });
  // @ts-expect-error -- an omitted card defaults to `summary_large_image`.
  socialImageMetadata("/", "card", { twitter: { player: playerOptions } });
  // @ts-expect-error -- a player card takes no app payload.
  socialImageMetadata("/", "card", { twitter: { card: "player", site: "@e", player: playerOptions, app: { ipad: { id: "1" } } } });
  // @ts-expect-error -- `description` belongs to player and app cards.
  socialImageMetadata("/", "card", { twitter: { card: "summary", description: "d" } });
  // @ts-expect-error -- X requires `site` or `siteId` on a player card.
  socialImageMetadata("/", "card", { twitter: { card: "player", player: playerOptions } });
  // @ts-expect-error -- X requires `site` on an app card.
  socialImageMetadata("/", "card", { twitter: { card: "app", siteId: "1", app: { ipad: { id: "1" } } } });
  // @ts-expect-error -- the wide options type is discriminated too.
  const wide: XImageOptions = { card: "player", site: "@e" };
  void wide;
}

// Page-level fields: the Next mapping returns Next's own types, and the
// og:type allowlist names every value Next's openGraph.type accepts.
const pageMetadata: Metadata = {
  ...nextPageMetadata({ type: "article", article: { publishedTime: new Date(0) } }),
};
const pageViewport: Viewport = nextPageViewport({ themeColor: "#000000" });
type UnlistedNextType = Exclude<NextOpenGraphType, (typeof NEXT_OPEN_GRAPH_TYPES)[number]>;
const everyNextTypeListed: [UnlistedNextType] extends [never] ? true : false = true;
void [pageMetadata, pageViewport, everyNextTypeListed];

describe("React-free type mirror", () => {
  it("is exercised by the type-level assertions above", () => {
    expect(true).toBe(true);
  });
});
