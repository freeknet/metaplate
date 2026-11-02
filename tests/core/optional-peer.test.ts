import { describe, expect, it, vi } from "vitest";
import { loadPeerPair, optionalPeer } from "../../src/core/optional-peer.js";

const peer = { package: "satori", entries: "metaplate/render and metaplate/node" };

function missingModule(specifier: string) {
  return Object.assign(
    new Error(`Cannot find package '${specifier}' imported from /app/node_modules/metaplate/dist/render.js`),
    { code: "ERR_MODULE_NOT_FOUND" },
  );
}

describe("optionalPeer", () => {
  it("loads the peer once and reuses it", async () => {
    const load = vi.fn(() => Promise.resolve("satori"));
    const loadPeer = optionalPeer(peer, load);

    await expect(loadPeer()).resolves.toBe("satori");
    await expect(loadPeer()).resolves.toBe("satori");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("turns a missing peer into install guidance", async () => {
    const cause = missingModule("satori");
    const loadPeer = optionalPeer(peer, () => Promise.reject(cause));

    await expect(loadPeer()).rejects.toThrow(
      "Cannot find satori, required by metaplate/render and metaplate/node. Install it with: npm install satori",
    );
    await expect(loadPeer()).rejects.toMatchObject({ cause });
  });

  it("retries after the peer is installed", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(missingModule("satori"))
      .mockResolvedValue("satori");
    const loadPeer = optionalPeer(peer, load);

    await expect(loadPeer()).rejects.toThrow("npm install satori");
    await expect(loadPeer()).resolves.toBe("satori");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("leaves a peer's own broken dependency tree alone", async () => {
    // satori resolved, but something it imports did not. Telling this consumer
    // to install satori would point at the wrong package.
    const cause = Object.assign(
      new Error("Cannot find package 'yoga-wasm-web' imported from satori/dist/index.js"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    const loadPeer = optionalPeer(peer, () => Promise.reject(cause));

    await expect(loadPeer()).rejects.toBe(cause);
  });

  it("leaves unrelated failures alone", async () => {
    // Resvg reports a missing native binding rather than a missing package.
    const cause = new Error("Failed to load native binding");
    const loadPeer = optionalPeer(peer, () => Promise.reject(cause));

    await expect(loadPeer()).rejects.toBe(cause);
  });
});

describe("loadPeerPair", () => {
  const missing = (name: string) =>
    optionalPeer({ package: name, entries: "metaplate/node" }, () =>
      Promise.reject(missingModule(name)),
    );

  it("names both packages when neither is installed", async () => {
    await expect(
      loadPeerPair(missing("satori"), missing("@resvg/resvg-js"), "metaplate/node"),
    ).rejects.toThrow(
      "Cannot find satori and @resvg/resvg-js, required by metaplate/node. Install them with: npm install satori @resvg/resvg-js",
    );
  });

  it("reports the single missing package on its own", async () => {
    await expect(
      loadPeerPair(() => Promise.resolve("satori"), missing("@resvg/resvg-js"), "metaplate/node"),
    ).rejects.toThrow("npm install @resvg/resvg-js");
  });

  it("passes an unrelated failure through", async () => {
    const cause = new Error("Failed to load native binding");
    await expect(
      loadPeerPair(() => Promise.resolve("satori"), () => Promise.reject(cause), "metaplate/node"),
    ).rejects.toBe(cause);
  });

  it("returns both values in order", async () => {
    await expect(
      loadPeerPair(() => Promise.resolve("a"), () => Promise.resolve("b"), "metaplate/node"),
    ).resolves.toEqual(["a", "b"]);
  });
});
