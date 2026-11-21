import { optionalPeer, type OptionalPeer } from "./optional-peer.js";

/**
 * Not an entry point: these loaders are bundled into the entries that use
 * them. Each is marked pure so an entry that never calls a loader drops it,
 * which keeps, for example, the native Resvg specifier out of `metaplate/edge`.
 */
export const loadSatori = /* @__PURE__ */ optionalPeer(
  { package: "satori", entries: "metaplate/render and metaplate/node" },
  async (): Promise<typeof import("satori").default> =>
    (await import("satori")).default,
);

export const loadResvg = /* @__PURE__ */ optionalPeer(
  { package: "@resvg/resvg-js", entries: "metaplate/node" },
  async (): Promise<typeof import("@resvg/resvg-js").Resvg> =>
    (await import("@resvg/resvg-js")).Resvg,
);

/**
 * Satori without its embedded Yoga: the only Satori build `metaplate/edge`
 * references, so edge bundles never carry the default build as well.
 */
export const loadSatoriStandalone = /* @__PURE__ */ optionalPeer(
  { package: "satori", entries: "metaplate/edge" },
  async (): Promise<typeof import("satori/standalone")> => import("satori/standalone"),
);

export const RESVG_WASM_PEER: OptionalPeer = {
  package: "@resvg/resvg-wasm",
  entries: "metaplate/edge",
};

export const loadResvgWasm = /* @__PURE__ */ optionalPeer(
  RESVG_WASM_PEER,
  async (): Promise<typeof import("@resvg/resvg-wasm")> => import("@resvg/resvg-wasm"),
);

/**
 * Takumi's renderer and the two helpers `metaplate/takumi` converts plates
 * with. `takumi-js` picks its own binding from the runtime's import
 * conditions: the native addon on Node.js, its precompiled Wasm on Cloudflare
 * Workers, Deno, and browsers.
 */
export const loadTakumi = /* @__PURE__ */ optionalPeer(
  { package: "takumi-js", entries: "metaplate/takumi" },
  async () => {
    const [core, jsx, emoji] = await Promise.all([
      import("takumi-js"),
      import("takumi-js/helpers/jsx"),
      import("takumi-js/helpers/emoji"),
    ]);
    return {
      render: core.render,
      renderSvg: core.renderSvg,
      measure: core.measure,
      fromJsx: jsx.fromJsx,
      extractEmojis: emoji.extractEmojis,
      isEmojiImageUrl: emoji.isEmojiImageUrl,
    };
  },
);
