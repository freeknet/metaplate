import { isIP } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipFamily } from "../../src/core/remote-policy.js";
import {
  FETCH_IMAGE_LOADER_DEFAULTS,
  RemoteImageError,
  fetchImageLoader,
  type FetchImageLoaderOptions,
} from "../../src/image.js";
import { closeLocalServers, localServer, redirectTo, routes, serveBytes } from "../helpers/http-fixtures.js";
import { completePng } from "../helpers/image-fixtures.js";

afterEach(closeLocalServers);

const avatar = completePng(48, 24);

/** A loader allowed to reach one local test server. */
function loaderFor(server: { origin: string; port: number }, extra: Partial<FetchImageLoaderOptions> = {}) {
  return fetchImageLoader({ origins: [server.origin], allowPrivate: true, allowedPorts: [server.port], ...extra });
}

describe("fetchImageLoader", () => {
  it("fetches an allowlisted image through fetch and memoizes it by URL", async () => {
    const server = await localServer(serveBytes(avatar, "image/png"));
    const load = loaderFor(server);
    const [one, two] = await Promise.all([load(`${server.origin}/a.png`), load(new URL(`${server.origin}/a.png`))]);
    expect(one).toMatchObject({ format: "png", width: 48, height: 24 });
    expect(two).toBe(one);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.headers.accept).toBe("image/*");
    expect(server.requests[0]?.headers["user-agent"]).toMatch(/^metaplate-verify\//);
  });

  it("follows redirects by hand, re-checking the allowlist on every hop", async () => {
    const outside = await localServer(serveBytes(avatar, "image/png"));
    const server = await localServer(routes({
      "/hop": redirectTo("/a.png", 307),
      "/a.png": serveBytes(avatar, "image/png"),
      "/out": redirectTo(`${outside.origin}/a.png`),
      "/loop": redirectTo("/loop"),
      "/bare": (_request, response) => {
        response.writeHead(302);
        response.end();
      },
    }));
    const load = loaderFor(server, { allowedPorts: [server.port, outside.port], maxRedirects: 2 });
    await expect(load(`${server.origin}/hop`)).resolves.toMatchObject({ width: 48 });
    await expect(load(`${server.origin}/out`)).rejects.toMatchObject({
      code: "origin",
      message: `Redirect to ${outside.origin}/a.png is not on an allowed origin (${server.origin})`,
    });
    expect(outside.requests).toHaveLength(0);
    await expect(load(`${server.origin}/loop`)).rejects.toMatchObject({ code: "too-many-redirects" });
    await expect(load(`${server.origin}/bare`)).rejects.toMatchObject({ code: "redirect" });
    // The redirect set a cookie; fetch keeps no jar, so no hop ever sent one.
    expect(server.requests.every((request) => request.headers.cookie === undefined)).toBe(true);
  });

  it("refuses non-public IP literals and localhost names before any request", async () => {
    const fetchSpy = vi.fn<NonNullable<FetchImageLoaderOptions["fetch"]>>();
    const origins = ["http://127.0.0.1", "http://10.1.2.3", "http://[::1]", "http://[::ffff:192.168.0.1]", "http://localhost", "http://img.localhost", "http://localhost.", "http://img.localhost."];
    const load = fetchImageLoader({ origins, fetch: fetchSpy });
    for (const origin of origins) {
      const failure = load(`${origin}/a.png`);
      await expect(failure).rejects.toBeInstanceOf(RemoteImageError);
      await expect(failure).rejects.toMatchObject({ code: "address" });
    }
    // WHATWG URL canonicalizes other IPv4 spellings first, so they are caught too.
    await expect(fetchImageLoader({ origins: ["http://2130706433"], fetch: fetchSpy })("http://2130706433/a.png"))
      .rejects.toMatchObject({ code: "address", message: expect.stringContaining("127.0.0.1 is a loopback address") });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("applies the URL policy: allowlist, scheme, credentials, and port", async () => {
    const fetchSpy = vi.fn<NonNullable<FetchImageLoaderOptions["fetch"]>>();
    const load = fetchImageLoader({ origins: ["https://cdn.example.com"], fetch: fetchSpy });
    const codes = await Promise.all(
      ["https://other.example.com/a.png", "ftp://cdn.example.com/a.png", "https://u:p@cdn.example.com/a.png", "https://cdn.example.com:8443/a.png", "nope"]
        .map((url) => load(url).catch((error: RemoteImageError) => error.code)),
    );
    expect(codes).toEqual(["origin", "scheme", "credentials", "port", "invalid-url"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enforces maxBytes from Content-Length and while the body streams", async () => {
    const server = await localServer(routes({
      "/declared": serveBytes(avatar, "image/png"),
      "/chunked": (_request, response) => {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.write(avatar.subarray(0, 20));
        response.end(avatar.subarray(20));
      },
    }));
    const load = loaderFor(server, { maxBytes: 32 });
    await expect(load(`${server.origin}/declared`)).rejects.toMatchObject({ code: "byte-limit" });
    await expect(load(`${server.origin}/chunked`)).rejects.toMatchObject({ code: "byte-limit" });
    expect(FETCH_IMAGE_LOADER_DEFAULTS.maxBytes).toBe(4 * 1024 * 1024);
  });

  it("reports statuses, checks the bytes, and retries a failure instead of caching it", async () => {
    let healthy = false;
    const server = await localServer(routes({
      "/missing": (_request, response) => {
        response.writeHead(404, "Not Found");
        response.end();
      },
      "/flaky": (_request, response) => {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.end(healthy ? avatar : new TextEncoder().encode("<html>"));
      },
    }));
    const load = loaderFor(server);
    await expect(load(`${server.origin}/missing`)).rejects.toMatchObject({ code: "status", status: 404 });
    await expect(load(`${server.origin}/flaky`)).rejects.toThrow(`${server.origin}/flaky: Unrecognized image`);
    healthy = true;
    await expect(load(`${server.origin}/flaky`)).resolves.toMatchObject({ width: 48 });
  });

  it("fails a fetch that outlives timeoutMs", async () => {
    const server = await localServer(() => {
      // Never answers.
    });
    const load = loaderFor(server, { timeoutMs: 150 });
    await expect(load(`${server.origin}/slow.png`)).rejects.toMatchObject({ code: "timeout" });
  });

  it("holds the time budget for an injected fetch that ignores its signal, and retries afterwards", async () => {
    let calls = 0;
    const hangs: FetchImageLoaderOptions["fetch"] = () => {
      calls += 1;
      return new Promise<Response>(() => {});
    };
    const load = fetchImageLoader({ origins: ["https://cdn.example.com"], fetch: hangs, timeoutMs: 50 });
    await expect(load("https://cdn.example.com/a.png")).rejects.toMatchObject({ code: "timeout" });
    // The failed load is not cached: the next call fetches again, and also settles.
    await expect(load("https://cdn.example.com/a.png")).rejects.toMatchObject({ code: "timeout" });
    expect(calls).toBe(2);

    const stalls: FetchImageLoaderOptions["fetch"] = async () =>
      new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { headers: { "Content-Type": "image/png" } });
    const body = fetchImageLoader({ origins: ["https://cdn.example.com"], fetch: stalls, timeoutMs: 50 });
    await expect(body("https://cdn.example.com/b.png")).rejects.toMatchObject({ code: "timeout" });
  });

  it("calls an injected fetch, and refuses a redirect whose target the runtime hides", async () => {
    const calls: string[] = [];
    const injected: FetchImageLoaderOptions["fetch"] = async (url, init) => {
      calls.push(`${url} ${init.redirect}`);
      return url.endsWith("/hidden")
        ? ({ type: "opaqueredirect", status: 0, headers: new Headers(), body: null } as unknown as Response)
        : new Response(avatar as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": "image/png" } });
    };
    const load = fetchImageLoader({ origins: ["https://cdn.example.com"], fetch: injected });
    await expect(load("https://cdn.example.com/a.png")).resolves.toMatchObject({ width: 48 });
    await expect(load("https://cdn.example.com/hidden")).rejects.toMatchObject({ code: "redirect" });
    expect(calls).toEqual(["https://cdn.example.com/a.png manual", "https://cdn.example.com/hidden manual"]);
  });

  it("validates its options when it is defined", () => {
    expect(() => fetchImageLoader({ origins: [] })).toThrow("fetchImageLoader needs an origins allowlist");
    expect(() => fetchImageLoader({ origins: ["https://cdn.example.com/path"] })).toThrow(/must be bare origins/);
    for (const extra of [{ cacheSize: -1 }, { maxRedirects: -1 }, { timeoutMs: 0 }, { allowedPorts: [70_000] }, { fetch: "no" }]) {
      expect(() => fetchImageLoader({ origins: ["https://cdn.example.com"], ...(extra as object) })).toThrow(TypeError);
    }
  });
});

describe("ipFamily", () => {
  it("agrees with node:net isIP", () => {
    const samples = [
      "1.2.3.4", "255.255.255.255", "256.1.1.1", "01.2.3.4", "1.2.3", "1.2.3.4.5", "0.0.0.0", "a.b.c.d",
      "::", "::1", "2001:db8::1", "fe80::1", "::ffff:1.2.3.4", "1:2:3:4:5:6:7:8", "1::2::3", "12345::", "example.com", "",
    ];
    for (const sample of samples) expect(ipFamily(sample), sample).toBe(isIP(sample));
  });
});
