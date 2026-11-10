import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fontLoader } from "../../src/font-data.js";
import { verifyImage } from "../../src/image.js";
import { createNodeOg, memoryRenderCache, type RenderCacheEntry, type RenderCacheStore } from "../../src/node.js";
import {
  createRenderCache,
  ifNoneMatchHolds,
  parseEntityTags,
  requestFrom,
  type CacheablePlate,
} from "../../src/render/cache.js";
import { taggedSerialize } from "../../src/core/stable-hash.js";
import { completePng } from "../helpers/image-fixtures.js";

const root = path.join(import.meta.dirname, "../..");
const installed = (...segments: string[]) => readFileSync(path.join(root, "node_modules", ...segments));
const interBold = installed("@fontsource", "inter", "files", "inter-latin-700-normal.woff");

const hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  vi.useRealTimers();
});

describe("taggedSerialize", () => {
  it("ignores object key order and keeps array, Map, and Set order", () => {
    expect(taggedSerialize({ a: 1, b: { c: [1, 2], d: "x" } }))
      .toBe(taggedSerialize({ b: { d: "x", c: [1, 2] }, a: 1 }));
    expect(taggedSerialize([1, 2])).not.toBe(taggedSerialize([2, 1]));
    expect(taggedSerialize(new Map([["a", 1], ["b", 2]]))).not.toBe(taggedSerialize(new Map([["b", 2], ["a", 1]])));
    expect(taggedSerialize(new Set([1, 2]))).not.toBe(taggedSerialize(new Set([2, 1])));
  });

  it("tags every type so different values never collide", () => {
    const values: unknown[] = [
      undefined, null, true, false, 0, -0, 1, "1", 1n, [1], ["1"], { 1: 1 }, NaN, Infinity, "",
      new Uint8Array([1]), new Uint16Array([1]), new Uint8Array([1]).buffer, new Date(0), new Date(Number.NaN),
      new Map([[1, 1]]), new Set([1]), new URL("https://example.com/"), "https://example.com/",
      (copy: string) => copy, { a: undefined }, {},
    ];
    const serialized = values.map((value) => taggedSerialize(value));
    expect(new Set(serialized).size).toBe(values.length);
  });

  it("serializes bytes, dates, and toJSON objects by value", () => {
    expect(taggedSerialize({ data: Uint8Array.from([0xde, 0xad]) })).toBe('{"data":bUint8Array:dead}');
    expect(taggedSerialize(new Date("2026-01-02T03:04:05Z"))).toBe(taggedSerialize(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))));
    expect(taggedSerialize(new URL("https://example.com/a"))).toBe(taggedSerialize(new URL("https://example.com/a")));
  });

  it("refuses cycles, symbols, and objects without a data representation, naming the path", () => {
    const cycle: { child: { parent?: unknown } } = { child: {} };
    cycle.child.parent = cycle;
    expect(() => taggedSerialize(cycle, "copy")).toThrow("Cannot serialize the cycle at copy.child.parent");
    expect(() => taggedSerialize({ tag: Symbol("x") }, "copy")).toThrow("Cannot serialize the symbol at copy.tag");
    expect(() => taggedSerialize({ list: [new (class Moment {})()] }, "copy"))
      .toThrow("Cannot serialize Moment at copy.list[0]");
    // A value seen twice without a cycle is fine.
    const shared = { x: 1 };
    expect(() => taggedSerialize({ a: shared, b: shared })).not.toThrow();
  });
});

describe("If-None-Match", () => {
  it("parses entity-tag lists in one pass, including commas inside a tag", () => {
    expect(parseEntityTags('"xyzzy"')).toEqual(['"xyzzy"']);
    expect(parseEntityTags('W/"xyzzy", "r2d2xxxx",\t"c3piozzzz"')).toEqual(['"xyzzy"', '"r2d2xxxx"', '"c3piozzzz"']);
    expect(parseEntityTags('"a,b", W/"c"')).toEqual(['"a,b"', '"c"']);
    // A malformed member ends the list; the members before it still count.
    expect(parseEntityTags('"a", b, "c"')).toEqual(['"a"']);
    expect(parseEntityTags('"unterminated')).toEqual([]);
    expect(parseEntityTags("")).toEqual([]);
  });

  // RFC 9110 section 8.8.3.2, table 3: If-None-Match uses the weak comparison.
  it.each([
    ['W/"1"', 'W/"1"', true],
    ['W/"1"', 'W/"2"', false],
    ['W/"1"', '"1"', true],
    ['"1"', '"1"', true],
    ['"1", "2"', '"2"', true],
    ['"12"', '"1"', false],
    ["*", '"anything"', true],
    [" * ", '"anything"', true],
    [null, '"1"', false],
  ])("compares %j against %j weakly", (field, etag, expected) => {
    expect(ifNoneMatchHolds(field, etag)).toBe(expected);
  });

  it("stays linear on a long malformed field", () => {
    const field = `${'W/"a",'.repeat(20_000)}${"W/".repeat(20_000)}`;
    const started = performance.now();
    expect(parseEntityTags(field)).toHaveLength(20_000);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("finds the request among framework handler arguments", () => {
    const request = new Request("https://example.com/og.png");
    expect(requestFrom([request])).toBe(request);
    expect(requestFrom([{ request, params: {} }])).toBe(request);
    expect(requestFrom([{ params: {} }, request])).toBe(request);
    expect(requestFrom([undefined, null, "x", { request: "no" }])).toBeUndefined();
  });
});

function entry(size: number, expires?: number): RenderCacheEntry {
  return { bytes: new Uint8Array(size), contentType: "image/png", etag: '"x"', expires };
}

describe("memoryRenderCache", () => {
  it("evicts the least recently used entry past maxEntries", () => {
    const store = memoryRenderCache({ maxEntries: 2 });
    store.set("a", entry(1));
    store.set("b", entry(1));
    expect(store.get("a")).toBeDefined(); // a is now the most recent
    store.set("c", entry(1));
    expect([store.get("a"), store.get("b"), store.get("c")].map(Boolean)).toEqual([true, false, true]);
    expect(store.size).toBe(2);
  });

  it("evicts by byte budget and never stores an entry larger than it", () => {
    const store = memoryRenderCache({ maxBytes: 10 });
    store.set("a", entry(4));
    store.set("b", entry(4));
    store.set("c", entry(4));
    expect(store.byteSize).toBe(8);
    expect(store.get("a")).toBeUndefined();
    store.set("huge", entry(11));
    expect(store.get("huge")).toBeUndefined();
    expect(store.byteSize).toBe(8);
    store.set("b", entry(2));
    expect(store.byteSize).toBe(6);
    expect(store.delete("b")).toBe(true);
    expect(store.delete("b")).toBe(false);
    store.clear();
    expect([store.size, store.byteSize]).toEqual([0, 0]);
  });

  it("drops an expired entry when it is read", () => {
    const store = memoryRenderCache();
    store.set("old", entry(1, Date.now() - 1));
    store.set("fresh", entry(1, Date.now() + 60_000));
    expect(store.get("old")).toBeUndefined();
    expect(store.get("fresh")).toBeDefined();
    expect(store.size).toBe(1);
  });

  it.each([{ maxBytes: 0 }, { maxEntries: 1.5 }, { maxBytes: -1 }])("rejects %j", (options) => {
    expect(() => memoryRenderCache(options)).toThrow(TypeError);
  });
});

/** A plate double that renders the copy's title as bytes and counts renders. */
function fakePlate(options: { fingerprint?: string; delay?: number } = {}) {
  const calls: string[] = [];
  const plate: CacheablePlate<{ title: string }> = {
    contentType: "image/png",
    async render(copy) {
      calls.push(copy.title);
      if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
      return new TextEncoder().encode(`png:${copy.title}`);
    },
    fingerprint: async () => options.fingerprint ?? "plate-v1",
    sha256: hex,
    headers: (byteLength, etag) => new Headers({
      "Content-Type": "image/png",
      "Content-Length": String(byteLength),
      ETag: etag,
      "Cache-Control": "public, max-age=86400",
      Vary: "Accept",
    }),
  };
  return { plate, calls };
}

describe("createRenderCache", () => {
  it("renders each distinct copy once and serves repeats from the store", async () => {
    const { plate, calls } = fakePlate();
    const cache = createRenderCache(plate);
    const first = await cache.render({ title: "A" });
    expect(new TextDecoder().decode(await cache.render({ title: "A" }))).toBe("png:A");
    await cache.render({ title: "B" });
    expect(calls).toEqual(["A", "B"]);
    expect(first).toEqual(new TextEncoder().encode("png:A"));
    expect((await cache.entry({ title: "A" })).etag).toBe(`"${hex(first)}"`);
  });

  it("keys on the plate fingerprint and the stable-serialized copy", async () => {
    const { plate } = fakePlate();
    const cache = createRenderCache(plate);
    const key = await cache.key({ title: "A" });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await cache.key({ title: "A" })).toBe(key);
    expect(await cache.key({ title: "B" })).not.toBe(key);
    expect(await createRenderCache(fakePlate({ fingerprint: "plate-v2" }).plate).key({ title: "A" })).not.toBe(key);
  });

  it("shares one render between concurrent misses for the same copy", async () => {
    const { plate, calls } = fakePlate({ delay: 10 });
    const cache = createRenderCache(plate);
    await Promise.all([cache.render({ title: "A" }), cache.render({ title: "A" }), cache.render({ title: "B" })]);
    expect(calls.sort()).toEqual(["A", "B"]);
  });

  it("re-renders an expired entry", async () => {
    vi.useFakeTimers({ now: 0 });
    const { plate, calls } = fakePlate();
    const cache = createRenderCache(plate, { ttl: 60 });
    await cache.render({ title: "A" });
    vi.setSystemTime(59_000);
    await cache.render({ title: "A" });
    vi.setSystemTime(60_000);
    await cache.render({ title: "A" });
    expect(calls).toEqual(["A", "A"]);
  });

  it("re-renders an entry a store returns damaged, stale, or for another format", async () => {
    const { plate, calls } = fakePlate();
    const entries = new Map<string, RenderCacheEntry>();
    const store: RenderCacheStore = { get: async (key) => entries.get(key), set: async (key, value) => void entries.set(key, value) };
    const cache = createRenderCache(plate, { store });
    const key = await cache.key({ title: "A" });
    const good = await cache.entry({ title: "A" });
    for (const damaged of [
      { ...good, bytes: new TextEncoder().encode("png:tampered") },
      { ...good, contentType: "image/jpeg" },
      { ...good, expires: Date.now() - 1 },
      { ...good, bytes: "png:A" as unknown as Uint8Array },
    ]) {
      entries.set(key, damaged);
      expect(new TextDecoder().decode(await cache.render({ title: "A" }))).toBe("png:A");
    }
    expect(calls).toHaveLength(5);
    expect(entries.get(key)).toEqual(good);
  });

  it("treats a failing store as a miss and reports it", async () => {
    const { plate, calls } = fakePlate();
    const errors: string[] = [];
    const cache = createRenderCache(plate, {
      store: {
        get: () => {
          throw new Error("get down");
        },
        set: async () => {
          throw new Error("set down");
        },
      },
      onStoreError: (error, operation) => errors.push(`${operation}: ${(error as Error).message}`),
    });
    const response = await cache.response({ title: "A" });
    expect(response.status).toBe(200);
    expect(calls).toEqual(["A"]);
    expect(errors).toEqual(["get: get down", "set: set down"]);
  });

  it("answers a matching If-None-Match with 304 and the 200's caching headers", async () => {
    const { plate } = fakePlate();
    const cache = createRenderCache(plate);
    const ok = await cache.response({ title: "A" });
    const etag = ok.headers.get("etag")!;
    expect(ok.status).toBe(200);
    expect(etag).toBe(`"${hex(new TextEncoder().encode("png:A"))}"`);

    for (const field of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const request = new Request("https://example.com/og.png", { headers: { "If-None-Match": field } });
      const response = await cache.response({ title: "A" }, request);
      expect(response.status).toBe(304);
      expect(response.body).toBeNull();
      expect(response.headers.get("etag")).toBe(etag);
      expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
      expect(response.headers.get("vary")).toBe("Accept");
      expect(response.headers.has("content-type")).toBe(false);
      expect(response.headers.has("content-length")).toBe(false);
    }

    const head = new Request("https://example.com/og.png", { method: "HEAD", headers: { "If-None-Match": etag } });
    expect((await cache.response({ title: "A" }, head)).status).toBe(304);
    const post = new Request("https://example.com/og.png", { method: "POST", headers: { "If-None-Match": etag } });
    expect((await cache.response({ title: "A" }, post)).status).toBe(412);
    const stale = new Request("https://example.com/og.png", { headers: { "If-None-Match": '"old"' } });
    const fresh = await cache.response({ title: "A" }, stale);
    expect(fresh.status).toBe(200);
    expect(new TextDecoder().decode(await fresh.arrayBuffer())).toBe("png:A");
  });

  it("finds the request in every handler form", async () => {
    const { plate, calls } = fakePlate();
    const cache = createRenderCache(plate);
    const etag = (await cache.response({ title: "A" })).headers.get("etag")!;
    const request = new Request("https://example.com/og.png", { headers: { "If-None-Match": etag } });
    const resolve = (context: { params: { title: string } }) => ({ title: context.params.title });
    const responses = await Promise.all([
      cache.handler({ title: "A" })(request),
      cache.handlerFrom(resolve)({ params: { title: "A" }, request } as never),
      cache.fetchable({ title: "A" }).fetch(request),
      cache.fetchableFrom((incoming: Request) => ({ title: new URL(incoming.url).hostname === "example.com" ? "A" : "B" })).fetch(request),
    ]);
    expect(responses.map((response) => response.status)).toEqual([304, 304, 304, 304]);
    expect(calls).toEqual(["A"]);
  });

  it("answers HEAD with the GET response's fields and no body", async () => {
    const { plate } = fakePlate();
    const cache = createRenderCache(plate);
    const get = await cache.response({ title: "A" });
    const head = new Request("https://example.com/og.png", { method: "HEAD" });
    for (const response of [
      await cache.response({ title: "A" }, head),
      await cache.handler({ title: "A" })(head),
      await cache.fetchableFrom((request: Request) => ({ title: new URL(request.url).hostname === "example.com" ? "A" : "B" })).fetch(head),
    ]) {
      expect(response.status).toBe(200);
      expect(response.body).toBeNull();
      expect(response.headers.get("etag")).toBe(get.headers.get("etag"));
      expect(response.headers.get("content-length")).toBe(String("png:A".length));
      expect(response.headers.get("content-type")).toBe("image/png");
    }
  });

  it("checks a signed route's signature before resolving copy or reading the cache", async () => {
    const { plate, calls } = fakePlate();
    const cache = createRenderCache(plate);
    const secret = "route-secret-0123456789abcdefghijklmn";
    const retired = "retired-secret-0123456789abcdefghijkl";
    const resolve = vi.fn((request: Request) => ({ title: new URL(request.url).pathname }));
    const { signImagePath } = await import("../../src/index.js");
    const signedUrl = await signImagePath("https://example.com/posts/a/og-image.png", secret);

    const get = cache.handlerFrom(resolve, { signed: { secret } });
    const unsigned = await get(new Request("https://example.com/posts/a/og-image.png"));
    expect(unsigned.status).toBe(403);
    expect(unsigned.headers.get("cache-control")).toBe("no-store");
    const tampered = await cache.fetchableFrom(resolve, { signed: { secret, status: 404 } })
      .fetch(new Request(signedUrl.replace("posts/a", "posts/b")));
    expect(tampered.status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();
    expect(calls).toEqual([]);

    // A valid signature renders once, then serves the cached image; a
    // retiring secret still verifies, and a custom URL extractor is honored.
    expect((await get(new Request(signedUrl))).status).toBe(200);
    expect((await get(new Request(signedUrl))).status).toBe(200);
    const rotated = cache.handlerFrom(resolve, { signed: { secrets: [retired, secret] } });
    expect((await rotated(new Request(signedUrl))).status).toBe(200);
    const proxied = cache.handlerFrom(
      (context: { path: string }) => ({ title: context.path }),
      { signed: { secret, url: (context) => `https://example.com${context.path}` } },
    );
    expect((await proxied({ path: new URL(signedUrl).pathname })).status).toBe(200);
    // Every valid request resolved the same copy, so one render served them all.
    expect(calls).toHaveLength(1);
  });

  it("refuses two plates with one fingerprint in one store, and allows one plate to attach twice", async () => {
    const store = memoryRenderCache();
    const first = fakePlate().plate;
    await createRenderCache(first, { store }).render({ title: "A" });
    await createRenderCache(first, { store }).render({ title: "A" });
    // A second plate whose definition differs only in a closed-over value.
    await expect(createRenderCache(fakePlate().plate, { store }).render({ title: "A" }))
      .rejects.toThrow("Give each plate a distinct revision");
    // Separate stores never conflict.
    await createRenderCache(fakePlate().plate).render({ title: "A" });
  });

  it("rejects options that cannot apply", () => {
    const { plate } = fakePlate();
    expect(() => createRenderCache(plate, { store: memoryRenderCache(), maxEntries: 5 })).toThrow(TypeError);
    expect(() => createRenderCache(plate, { ttl: 0 })).toThrow("ttl must be a positive number of seconds");
    expect(() => createRenderCache(plate, { ttl: Number.NaN })).toThrow(TypeError);
  });
});

type Copy = { title: string };

function component(copy: Copy) {
  return {
    type: "div",
    props: {
      style: { width: "100%", height: "100%", display: "flex", background: "#111", color: "#fff", fontFamily: "Inter", fontSize: 64 },
      children: copy.title,
    },
  };
}

const definition = {
  alt: (copy: Copy) => copy.title,
  fonts: fontLoader([{ name: "Inter", weight: 700 as const, data: interBold }]),
  component,
  variants: { square: { size: { width: 1080, height: 1080 } } },
};

// Real renders load the renderer and fonts on first use, which can pass
// Vitest's 5 s default on a cold macOS or Windows runner.
describe("plate fingerprint and cached()", { timeout: 30_000 }, () => {
  it("fingerprints what a size renders: equal for equal definitions, different for any input", async () => {
    const base = await createNodeOg(definition).fingerprint();
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await createNodeOg({ ...definition }).fingerprint()).toBe(base);
    const variants = await Promise.all([
      createNodeOg(definition).variant("square").fingerprint(),
      createNodeOg({ ...definition, revision: "2" }).fingerprint(),
      createNodeOg({ ...definition, size: { width: 1200, height: 600 } }).fingerprint(),
      createNodeOg({ ...definition, component: (copy: Copy) => ({ ...component(copy), key: "changed" }) }).fingerprint(),
      createNodeOg({ ...definition, resvg: { background: "#fff" } }).fingerprint(),
      createNodeOg({ ...definition, languageFonts: async () => [] }).fingerprint(),
      createNodeOg({
        ...definition,
        fonts: fontLoader([{ name: "Inter", weight: 700 as const, data: installed("@fontsource", "inter", "files", "inter-latin-400-normal.woff") }]),
      }).fingerprint(),
    ]);
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
    // Metadata-only options do not change the bytes, so they keep the fingerprint.
    expect(await createNodeOg({ ...definition, origin: "https://example.com", etag: true }).fingerprint()).toBe(base);
  });

  it("serves a real plate's repeat requests from the cache with a strong ETag and 304s", async () => {
    let renders = 0;
    const og = createNodeOg<Copy, "square">({
      ...definition,
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
      component: (copy) => {
        renders += 1;
        return component(copy);
      },
    });
    const store = memoryRenderCache({ maxBytes: 1024 * 1024 });
    const cached = og.cached({ store });
    const GET = cached.handlerFrom(({ params }: { params: { slug: string }; request: Request }) => ({ title: params.slug }));

    const first = await GET({ params: { slug: "hello" }, request: new Request("https://example.com/hello/og.png") });
    const bytes = new Uint8Array(await first.arrayBuffer());
    expect(first.status).toBe(200);
    expect(verifyImage(bytes, og.size, "png").format).toBe("png");
    expect(first.headers.get("etag")).toBe(`"${hex(bytes)}"`);
    expect(first.headers.get("content-length")).toBe(String(bytes.byteLength));

    const conditional = new Request("https://example.com/hello/og.png", {
      headers: { "If-None-Match": first.headers.get("etag")! },
    });
    const second = await GET({ params: { slug: "hello" }, request: conditional });
    expect(second.status).toBe(304);
    expect(second.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(renders).toBe(1);
    expect(store.size).toBe(1);

    // Each size keys separately, so a shared store holds both.
    await og.variant("square").cached({ store }).render({ title: "hello" });
    expect(store.size).toBe(2);
    expect(renders).toBe(2);

    // A factory's plates fingerprint alike when only a closed-over theme differs.
    const themed = (background: string) => createNodeOg<Copy>({
      ...definition,
      component: (copy) => ({ ...component(copy), props: { ...component(copy).props, style: { background } } }),
    });
    const shared = memoryRenderCache();
    await themed("#000").cached({ store: shared }).render({ title: "x" });
    await expect(themed("#fff").cached({ store: shared }).render({ title: "x" })).rejects.toThrow("distinct revision");
  });
});

describe("metaplate/edge cached()", { timeout: 30_000 }, () => {
  it("caches through Web Crypto with the plate's Fetch-shaped forms only", async () => {
    vi.resetModules();
    const { createEdgeOg } = await import("../../src/edge.js");
    let renders = 0;
    const og = createEdgeOg<Copy>({
      ...definition,
      resvg: { wasm: installed("@resvg", "resvg-wasm", "index_bg.wasm") },
      layout: { wasm: installed("satori", "layout.wasm") },
      component: (copy) => {
        renders += 1;
        return component(copy);
      },
    });
    const cached = og.cached();
    expect("handler" in cached).toBe(false);
    const fetchable = cached.fetchableFrom((request: Request) => ({ title: new URL(request.url).pathname }));
    const first = await fetchable.fetch(new Request("https://example.com/edge"));
    const bytes = new Uint8Array(await first.arrayBuffer());
    expect(first.headers.get("etag")).toBe(`"${hex(bytes)}"`);
    const again = await fetchable.fetch(new Request("https://example.com/edge", {
      headers: { "If-None-Match": first.headers.get("etag")! },
    }));
    expect(again.status).toBe(304);
    expect(renders).toBe(1);
    // Signed routes are checked on the edge cached view too.
    const signed = cached.fetchableFrom(
      (request: Request) => ({ title: new URL(request.url).pathname }),
      { signed: { secret: "route-secret-0123456789abcdefghijklmn" } },
    );
    expect((await signed.fetch(new Request("https://example.com/edge"))).status).toBe(403);
    expect(renders).toBe(1);
    // The same definition fingerprints differently per renderer.
    expect(await og.fingerprint()).not.toBe(await createNodeOg(definition).fingerprint());
    expect(completePng(1, 1)).toBeInstanceOf(Uint8Array);
  });
});
