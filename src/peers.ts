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

/** Satori's default build, which compiles its embedded Yoga layout engine. */
export const loadEdgeSatori = /* @__PURE__ */ optionalPeer(
  { package: "satori", entries: "metaplate/edge" },
  async (): Promise<typeof import("satori").default> =>
    (await import("satori")).default,
);

/** Satori without its embedded Yoga, for runtimes that forbid compiling Wasm from bytes. */
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
