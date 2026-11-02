import { afterEach, describe, expect, it } from "vitest";
import {
  REMOTE_USER_AGENT,
  RemoteImageError,
  fetchRemoteImage,
  fetchRemoteImageVia,
  fetchRemoteResourceVia,
  nonPublicAddressKind,
  verifyRemoteImage,
  type RemoteAddress,
  type RemoteFetchOptions,
} from "../../src/verify/remote.js";
import { closeLocalServers, localServer, redirectTo, routes, serveBytes } from "../helpers/http-fixtures.js";
import { completePng } from "../helpers/image-fixtures.js";
import { METAPLATE_VERSION } from "../../src/core/version.js";

afterEach(closeLocalServers);

const card = completePng(1200, 630);
const cardSize = { width: 1200, height: 630 } as const;

/** Local-development options: the loopback server plus its ephemeral port. */
function local(port: number, extra: RemoteFetchOptions = {}): RemoteFetchOptions {
  return { allowPrivate: true, allowedPorts: [port], ...extra };
}

/** A public address (formerly example.com), never dialed: the test dialer maps it to loopback. */
const PUBLIC_STAND_IN = "93.184.216.34";
const dialLoopback = (address: RemoteAddress): RemoteAddress =>
  address.address === PUBLIC_STAND_IN ? { address: "127.0.0.1", family: 4 } : address;

function resolverFrom(table: Record<string, string[]>) {
  const calls: string[] = [];
  const resolve = async (hostname: string) => {
    calls.push(hostname);
    const addresses = table[hostname];
    if (!addresses) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { resolve, calls };
}

describe("verifyRemoteImage", () => {
  it("fetches, verifies, and reports the final URL and byte count", async () => {
    const server = await localServer(serveBytes(card, "image/png"));
    const result = await verifyRemoteImage(
      `${server.origin}/og.png`,
      { ...cardSize, format: "png" },
      local(server.port),
    );

    expect(result).toMatchObject({
      url: `${server.origin}/og.png`,
      finalUrl: `${server.origin}/og.png`,
      redirects: [],
      address: "127.0.0.1",
      status: 200,
      contentType: "image/png",
      byteLength: card.byteLength,
      image: { format: "png", width: 1200, height: 630 },
    });
    expect(Buffer.from(result.bytes).equals(Buffer.from(card))).toBe(true);
  });

  it("sends a fixed identity and no credentials or cookies", async () => {
    const server = await localServer(serveBytes(card, "image/png"));
    await fetchRemoteImage(`${server.origin}/og.png`, local(server.port));

    const headers = server.requests[0]?.headers ?? {};
    expect(REMOTE_USER_AGENT).toBe(`metaplate-verify/${METAPLATE_VERSION}`);
    expect(headers["user-agent"]).toBe(REMOTE_USER_AGENT);
    expect(headers.accept).toBe("image/*");
    expect(headers["accept-encoding"]).toBe("identity");
    expect(headers.host).toBe(`127.0.0.1:${server.port}`);
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
  });

  it("rejects a Content-Type that disagrees with the bytes", async () => {
    const server = await localServer(routes({
      "/mislabeled": serveBytes(card, "image/jpeg"),
      "/unlabeled": serveBytes(card, undefined),
      "/parameterized": serveBytes(card, "Image/PNG; charset=binary"),
    }));
    const options = local(server.port);

    await expect(verifyRemoteImage(`${server.origin}/mislabeled`, cardSize, options)).rejects.toMatchObject({
      code: "content-type",
      message: expect.stringContaining("served as image/jpeg, but its bytes are png"),
    });
    await expect(verifyRemoteImage(`${server.origin}/unlabeled`, cardSize, options)).rejects.toMatchObject({
      code: "content-type",
    });
    await expect(verifyRemoteImage(`${server.origin}/parameterized`, cardSize, options)).resolves.toMatchObject({
      image: { format: "png" },
    });
  });

  it("still applies the size and format contract", async () => {
    const server = await localServer(serveBytes(card, "image/png"));
    await expect(
      verifyRemoteImage(`${server.origin}/og.png`, { width: 1200, height: 600 }, local(server.port)),
    ).rejects.toThrow("Expected 1200x600, received 1200x630");
    await expect(
      verifyRemoteImage(`${server.origin}/og.png`, { ...cardSize, format: "jpeg" }, local(server.port)),
    ).rejects.toThrow("Expected jpeg 1200x630, received png");
  });
});

describe("fetchRemoteImage URL policy", () => {
  it.each([
    ["file:///etc/passwd", "scheme"],
    ["data:image/png;base64,iVBORw0KGgo=", "scheme"],
    ["ftp://example.com/og.png", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["not a url", "invalid-url"],
    ["https://example.com:8443/og.png", "port"],
    ["https://example.com:80/og.png", "port"],
    ["http://example.com:443/og.png", "port"],
  ])("refuses %s before any network access (%s)", async (url, code) => {
    const { resolve, calls } = resolverFrom({});
    await expect(fetchRemoteImage(url, { resolve })).rejects.toMatchObject({ code });
    expect(calls).toEqual([]);
  });

  it("refuses URLs with user information without echoing the secret", async () => {
    const server = await localServer(serveBytes(card, "image/png"));
    const attempt = fetchRemoteImage(`http://user:hunter2@127.0.0.1:${server.port}/og.png`, local(server.port));

    await expect(attempt).rejects.toBeInstanceOf(RemoteImageError);
    const error = (await attempt.catch((caught: unknown) => caught)) as RemoteImageError;
    expect(error.code).toBe("credentials");
    expect(`${error.message} ${error.url}`).not.toContain("hunter2");
    expect(server.requests).toHaveLength(0);
  });

  it("requires an explicit allowance for non-default ports", async () => {
    const server = await localServer(serveBytes(card, "image/png"));
    await expect(
      fetchRemoteImage(`${server.origin}/og.png`, { allowPrivate: true }),
    ).rejects.toMatchObject({ code: "port" });
    expect(server.requests).toHaveLength(0);
  });

  it("validates its limits", async () => {
    await expect(fetchRemoteImage("https://example.com/", { maxBytes: 0 })).rejects.toThrow(TypeError);
    await expect(fetchRemoteImage("https://example.com/", { maxRedirects: -1 })).rejects.toThrow(TypeError);
    await expect(fetchRemoteImage("https://example.com/", { allowedPorts: [70_000] })).rejects.toThrow(TypeError);
  });
});

describe("fetchRemoteImage address policy", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.0.9", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "link-local"],
    ["0.0.0.0", "unspecified"],
    ["100.64.0.1", "shared (carrier-grade NAT)"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved or broadcast"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["fe80::1%eth0", "link-local"],
    ["fc00::1", "unique-local"],
    ["fd12:3456::1", "unique-local"],
    ["ff02::1", "multicast"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:7f00:1", "IPv4-mapped loopback"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["::ffff:169.254.169.254", "IPv4-mapped link-local"],
    ["64:ff9b::a00:1", "NAT64 private"],
    ["2002:7f00:1::", "6to4 loopback"],
    // IANA special-purpose registries, "Globally Reachable: False".
    ["192.0.0.8", "IETF protocol assignment"],
    ["192.0.0.170", "IETF protocol assignment"],
    ["192.0.2.1", "documentation"],
    ["198.51.100.1", "documentation"],
    ["203.0.113.5", "documentation"],
    ["192.88.99.1", "deprecated 6to4 relay anycast"],
    ["198.19.255.1", "benchmarking"],
    ["64:ff9b:1::7f00:1", "local-use NAT64"],
    ["64:ff9b:1::808:808", "local-use NAT64"],
    ["100::1", "discard-only"],
    ["100:0:0:1::1", "dummy"],
    ["2001:0:4136:e378:8000:63bf:80ff:fffe", "Teredo"],
    ["2001:2::1", "IETF protocol assignment"],
    ["2001:10::1", "IETF protocol assignment"],
    ["2001:1ff::1", "IETF protocol assignment"],
    ["2001:db8::1", "documentation"],
    ["3fff::1", "documentation"],
    ["5f00::1", "segment routing SID"],
    ["::ffff:192.0.2.1", "IPv4-mapped documentation"],
    ["2002:c000:0201::1", "6to4 documentation"],
    ["not-an-address", "unparseable"],
  ])("classifies %s as %s", (address, kind) => {
    expect(nonPublicAddressKind(address)).toBe(kind);
  });

  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "172.32.0.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    // Globally reachable allocations inside refused IANA blocks.
    "192.0.0.9",
    "192.0.0.10",
    "2001:1::1",
    "2001:1::3",
    "2001:3::1",
    "2001:4:112::1",
    "2001:20::1",
    "2001:30::1",
    "2001:200::1",
  ])(
    "treats %s as public",
    (address) => {
      expect(nonPublicAddressKind(address)).toBeUndefined();
    },
  );

  it.each(["http://127.0.0.1/og.png", "http://2130706433/og.png", "http://[::ffff:127.0.0.1]/og.png", "http://[::1]/og.png"])(
    "refuses the literal %s without the private-address allowance",
    async (url) => {
      await expect(fetchRemoteImage(url)).rejects.toMatchObject({ code: "address" });
    },
  );

  it("refuses a host when any resolved address is non-public", async () => {
    const { resolve } = resolverFrom({ "mixed.test": [PUBLIC_STAND_IN, "10.0.0.7"] });
    await expect(fetchRemoteImage("http://mixed.test/og.png", { resolve })).rejects.toMatchObject({
      code: "address",
      message: expect.stringContaining("10.0.0.7, a private address"),
    });
  });

  it("reports resolver failures as dns errors", async () => {
    const { resolve } = resolverFrom({ "empty.test": [] });
    await expect(fetchRemoteImage("http://missing.test/og.png", { resolve })).rejects.toMatchObject({ code: "dns" });
    await expect(fetchRemoteImage("http://empty.test/og.png", { resolve })).rejects.toMatchObject({ code: "dns" });
  });

  it("dials the checked address, so a rebinding resolver cannot redirect the connection", async () => {
    const server = await localServer(serveBytes(card, "image/png"));
    let lookups = 0;
    // The first answer is the one checked; any later answer points at cloud
    // metadata. A fetcher that resolved again at connect time would go there.
    const resolve = async () => {
      lookups += 1;
      return [{ address: lookups === 1 ? PUBLIC_STAND_IN : "169.254.169.254", family: 4 }];
    };

    const result = await fetchRemoteImageVia(
      `http://rebind.test:${server.port}/og.png`,
      { resolve, allowedPorts: [server.port] },
      dialLoopback,
    );

    expect(lookups).toBe(1);
    expect(result.address).toBe(PUBLIC_STAND_IN);
    expect(server.requests[0]?.headers.host).toBe(`rebind.test:${server.port}`);
  });

  it("never lets the platform resolver see the hostname", async () => {
    // `rebind.invalid` cannot resolve in real DNS; success proves the
    // connection used the injected, checked answer and nothing else.
    const server = await localServer(serveBytes(card, "image/png"));
    const { resolve, calls } = resolverFrom({ "rebind.invalid": ["127.0.0.1"] });
    const result = await fetchRemoteImage(`http://rebind.invalid:${server.port}/og.png`, local(server.port, { resolve }));

    expect(calls).toEqual(["rebind.invalid"]);
    expect(result.byteLength).toBe(card.byteLength);
    expect(server.requests[0]?.headers.host).toBe(`rebind.invalid:${server.port}`);
  });
});

describe("fetchRemoteImage redirects", () => {
  it("follows a redirect chain, re-resolving each hop, and drops cookies", async () => {
    const server = await localServer(routes({
      "/a": redirectTo("/b", 302),
      "/b": redirectTo("/c", 301),
      "/c": serveBytes(card, "image/png"),
    }));
    const result = await fetchRemoteImage(`${server.origin}/a`, local(server.port));

    expect(result.finalUrl).toBe(`${server.origin}/c`);
    expect(result.redirects).toEqual([`${server.origin}/b`, `${server.origin}/c`]);
    expect(server.requests.map(({ url }) => url)).toEqual(["/a", "/b", "/c"]);
    for (const { headers } of server.requests) {
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
    }
  });

  it("stops after maxRedirects", async () => {
    const server = await localServer(routes({
      "/a": redirectTo("/b"),
      "/b": redirectTo("/c"),
      "/c": serveBytes(card, "image/png"),
    }));
    await expect(
      fetchRemoteImage(`${server.origin}/a`, local(server.port, { maxRedirects: 1 })),
    ).rejects.toMatchObject({ code: "too-many-redirects" });
    expect(server.requests).toHaveLength(2);
  });

  it.each([
    ["http://169.254.169.254/latest/meta-data/", "address"],
    ["http://internal.test/og.png", "address"],
    ["http://[::ffff:10.0.0.1]/og.png", "address"],
  ])("refuses a redirect to the non-public %s without the allowance", async (location, code) => {
    const server = await localServer(redirectTo(location));
    const { resolve, calls } = resolverFrom({
      "images.test": [PUBLIC_STAND_IN],
      "internal.test": ["10.0.0.5"],
    });

    await expect(
      fetchRemoteImageVia(`http://images.test:${server.port}/start`, { resolve, allowedPorts: [server.port] }, dialLoopback),
    ).rejects.toMatchObject({ code });
    expect(server.requests).toHaveLength(1);
    expect(calls[0]).toBe("images.test");
  });

  it.each([
    ["file:///etc/passwd", "scheme"],
    ["data:image/png;base64,iVBORw0KGgo=", "scheme"],
    ["http://user:hunter2@example.com/og.png", "credentials"],
    ["http://example.com:8080/og.png", "port"],
  ])("refuses a redirect to %s (%s)", async (location, code) => {
    const server = await localServer(redirectTo(location));
    const attempt = fetchRemoteImage(`${server.origin}/start`, local(server.port));
    await expect(attempt).rejects.toMatchObject({ code });
    await expect(attempt).rejects.not.toThrow("hunter2");
  });

  it("rejects a redirect without a Location header", async () => {
    const server = await localServer((_request, response) => {
      response.writeHead(302);
      response.end();
    });
    await expect(fetchRemoteImage(`${server.origin}/`, local(server.port))).rejects.toMatchObject({ code: "redirect" });
  });
});

describe("fetchRemoteImage limits", () => {
  it("rejects a declared Content-Length over the byte cap", async () => {
    const server = await localServer(serveBytes(new Uint8Array(2048), "image/png"));
    await expect(
      fetchRemoteImage(`${server.origin}/`, local(server.port, { maxBytes: 1024 })),
    ).rejects.toMatchObject({ code: "byte-limit" });
  });

  it("enforces the byte cap while streaming an undeclared body", async () => {
    const server = await localServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.write(new Uint8Array(800));
      response.write(new Uint8Array(800));
      response.end(new Uint8Array(800));
    });
    await expect(
      fetchRemoteImage(`${server.origin}/`, local(server.port, { maxBytes: 1024 })),
    ).rejects.toMatchObject({ code: "byte-limit", message: expect.stringContaining("1024-byte limit") });
  });

  it("aborts when the total time budget is exhausted", async () => {
    const server = await localServer(() => {
      // Never answer.
    });
    const started = Date.now();
    await expect(
      fetchRemoteImage(`${server.origin}/`, local(server.port, { timeoutMs: 150 })),
    ).rejects.toMatchObject({ code: "timeout", message: expect.stringContaining("150 ms total time budget") });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("aborts a single stalled connection at the per-connection timeout", async () => {
    const server = await localServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "image/png", "Content-Length": "100" });
      response.write(new Uint8Array(10));
    });
    await expect(
      fetchRemoteImage(`${server.origin}/`, local(server.port, { timeoutMs: 5_000, connectionTimeoutMs: 150 })),
    ).rejects.toMatchObject({ code: "timeout", message: expect.stringContaining("150 ms connection timeout") });
  });

  it("rejects non-200 responses", async () => {
    const server = await localServer(routes({}));
    await expect(fetchRemoteImage(`${server.origin}/missing.png`, local(server.port))).rejects.toMatchObject({
      code: "status",
      status: 404,
      message: expect.stringContaining("responded 404"),
    });
  });

  it("keeps the first maxBytes bytes in truncate mode instead of failing", async () => {
    const body = Uint8Array.from({ length: 2400 }, (_, index) => index % 251);
    const server = await localServer(routes({
      "/declared": serveBytes(body, "text/plain"),
      "/streamed": (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.write(body.subarray(0, 800));
        response.write(body.subarray(800, 1600));
        response.end(body.subarray(1600));
      },
      "/small": serveBytes(body.subarray(0, 10), "text/plain"),
    }));
    for (const path of ["/declared", "/streamed"]) {
      const result = await fetchRemoteResourceVia(`${server.origin}${path}`, local(server.port, { maxBytes: 1024 }), (address) => address, "text/plain", { truncate: true });
      expect(result).toMatchObject({ truncated: true, byteLength: 1024 });
      expect([...result.bytes]).toEqual([...body.subarray(0, 1024)]);
    }
    const small = await fetchRemoteResourceVia(`${server.origin}/small`, local(server.port, { maxBytes: 1024 }), (address) => address, "text/plain", { truncate: true });
    expect(small.truncated).toBeUndefined();
    expect(small.byteLength).toBe(10);
  });
});
