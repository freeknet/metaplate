import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  REMOTE_IMAGE_LOADER_DEFAULTS,
  RemoteImageError,
  fileImageLoader,
  readImageAsset,
  remoteImageLoader,
  type RemoteImageLoaderOptions,
} from "../src/assets.js";
import { closeLocalServers, localServer, redirectTo, routes, serveBytes } from "./helpers/http-fixtures.js";
import { completePng, fixture } from "./helpers/image-fixtures.js";

afterEach(closeLocalServers);

const directory = mkdtempSync(path.join(tmpdir(), "metaplate-assets-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const logo = completePng(64, 32);
writeFileSync(path.join(directory, "logo.png"), logo);
writeFileSync(path.join(directory, "page.html"), "<!doctype html><title>Not found</title>");
writeFileSync(path.join(directory, "cover.webp"), fixture("card-lossy.webp"));

describe("readImageAsset", () => {
  it("reads a project file relative to cwd or as a file: URL", async () => {
    const relative = await readImageAsset("logo.png", { cwd: directory });
    expect(relative).toMatchObject({ format: "png", width: 64, height: 32, byteLength: logo.byteLength });
    const url = await readImageAsset(pathToFileURL(path.join(directory, "logo.png")));
    expect(url.src).toBe(relative.src);
  });

  it("names the file in format and size errors", async () => {
    const page = path.join(directory, "page.html");
    await expect(readImageAsset(page)).rejects.toThrow(`${page}: Unrecognized image`);
    const cover = path.join(directory, "cover.webp");
    await expect(readImageAsset(cover)).rejects.toThrow(`${cover}: WebP images are not enabled`);
    await expect(readImageAsset(cover, { formats: ["webp"] })).resolves.toMatchObject({ format: "webp" });
    await expect(readImageAsset("logo.png", { cwd: directory, maxBytes: 10 })).rejects.toThrow(
      /logo\.png: Image is \d+ bytes, over the 10-byte maxBytes limit/,
    );
  });

  it("keeps system errors as they are", async () => {
    await expect(readImageAsset("missing.png", { cwd: directory })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses URLs that are not file: URLs", async () => {
    await expect(readImageAsset(new URL("https://example.com/logo.png"))).rejects.toThrow(
      "Project image URLs must use the file: protocol: https://example.com/logo.png",
    );
  });
});

describe("fileImageLoader", () => {
  it("reads once, then retries after a failure", async () => {
    const file = path.join(directory, "late.png");
    const late = fileImageLoader(file);
    await expect(late()).rejects.toMatchObject({ code: "ENOENT" });
    writeFileSync(file, completePng(3, 3));
    const first = await late();
    expect(first).toMatchObject({ width: 3 });
    expect(await late()).toBe(first);
  });

  it("validates options when it is defined", () => {
    expect(() => fileImageLoader("logo.png", { maxBytes: 0 })).toThrow(/maxBytes/);
  });
});

/** Local-development options for a loopback fixture server. */
function local(origin: string, port: number, extra: Partial<RemoteImageLoaderOptions> = {}): RemoteImageLoaderOptions {
  return { origins: [origin], allowPrivate: true, allowedPorts: [port], ...extra };
}

describe("remoteImageLoader", () => {
  it("fetches an allowlisted image once and memoizes it by URL", async () => {
    const server = await localServer(serveBytes(logo, "image/png"));
    const load = remoteImageLoader(local(server.origin, server.port));
    const [first, second] = await Promise.all([
      load(`${server.origin}/avatar.png`),
      load(new URL(`${server.origin}/avatar.png`)),
    ]);
    expect(first).toMatchObject({ format: "png", width: 64, height: 32 });
    expect(second).toBe(first);
    expect(await load(`${server.origin}/avatar.png`)).toBe(first);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.headers.accept).toBe("image/*");
    expect(server.requests[0]?.headers.cookie).toBeUndefined();
  });

  it("refuses an origin that is not on the allowlist before connecting", async () => {
    const server = await localServer(serveBytes(logo, "image/png"));
    const load = remoteImageLoader(local("https://cdn.example.com", server.port));
    const failure = load(`${server.origin}/avatar.png`);
    await expect(failure).rejects.toBeInstanceOf(RemoteImageError);
    await expect(failure).rejects.toMatchObject({
      code: "origin",
      message: `URL ${server.origin}/avatar.png is not on an allowed origin (https://cdn.example.com)`,
    });
    expect(server.requests).toHaveLength(0);
  });

  it("re-checks the allowlist on every redirect", async () => {
    const elsewhere = await localServer(serveBytes(logo, "image/png"));
    const server = await localServer(routes({
      "/same": redirectTo("/avatar.png"),
      "/avatar.png": serveBytes(logo, "image/png"),
      "/away": redirectTo(`${elsewhere.origin}/avatar.png`),
    }));
    const load = remoteImageLoader(local(server.origin, server.port, {
      allowedPorts: [server.port, elsewhere.port],
    }));
    await expect(load(`${server.origin}/same`)).resolves.toMatchObject({ width: 64 });
    await expect(load(`${server.origin}/away`)).rejects.toMatchObject({
      code: "origin",
      message: `Redirect to ${elsewhere.origin}/avatar.png is not on an allowed origin (${server.origin})`,
    });
    expect(elsewhere.requests).toHaveLength(0);
  });

  it("keeps the fetcher's address policy: loopback needs allowPrivate", async () => {
    const server = await localServer(serveBytes(logo, "image/png"));
    const load = remoteImageLoader({ origins: [server.origin], allowedPorts: [server.port] });
    await expect(load(`${server.origin}/avatar.png`)).rejects.toMatchObject({ code: "address" });
    expect(server.requests).toHaveLength(0);
  });

  it("caps the body at the asset maxBytes while streaming", async () => {
    const server = await localServer(serveBytes(logo, "image/png"));
    const load = remoteImageLoader(local(server.origin, server.port, { maxBytes: 16 }));
    await expect(load(`${server.origin}/avatar.png`)).rejects.toMatchObject({ code: "byte-limit" });
    expect(REMOTE_IMAGE_LOADER_DEFAULTS.maxBytes).toBe(4 * 1024 * 1024);
  });

  it("checks the bytes, names the URL, and retries a failure instead of caching it", async () => {
    let body: Uint8Array = new TextEncoder().encode("<!doctype html>busy");
    const server = await localServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(body);
    });
    const load = remoteImageLoader(local(server.origin, server.port));
    await expect(load(`${server.origin}/avatar.png`)).rejects.toThrow(
      `${server.origin}/avatar.png: Unrecognized image`,
    );
    body = logo;
    await expect(load(`${server.origin}/avatar.png`)).resolves.toMatchObject({ width: 64 });
    expect(server.requests).toHaveLength(2);
  });

  it("applies imageAsset formats to fetched bytes", async () => {
    const server = await localServer(serveBytes(fixture("card-lossy.webp"), "image/webp"));
    const strict = remoteImageLoader(local(server.origin, server.port));
    await expect(strict(`${server.origin}/cover.webp`)).rejects.toThrow(/WebP images are not enabled/);
    const lenient = remoteImageLoader(local(server.origin, server.port, { formats: ["webp"] }));
    await expect(lenient(`${server.origin}/cover.webp`)).resolves.toMatchObject({ format: "webp" });
  });

  it("evicts the oldest entry once the cache is full, and caches nothing at size 0", async () => {
    const server = await localServer(serveBytes(logo, "image/png"));
    const load = remoteImageLoader(local(server.origin, server.port, { cacheSize: 2 }));
    const url = (name: string) => `${server.origin}/${name}.png`;
    for (const name of ["a", "b", "c", "b", "a"]) await load(url(name));
    // a, b, c fetched; b still cached; a evicted when c arrived, so fetched again.
    expect(server.requests.map((request) => request.url)).toEqual(["/a.png", "/b.png", "/c.png", "/a.png"]);

    const uncached = remoteImageLoader(local(server.origin, server.port, { cacheSize: 0 }));
    await uncached(url("z"));
    await uncached(url("z"));
    expect(server.requests.filter((request) => request.url === "/z.png")).toHaveLength(2);
  });

  it("reports an unparseable URL with the fetcher's code", async () => {
    const load = remoteImageLoader({ origins: ["https://cdn.example.com"] });
    await expect(load("not a url")).rejects.toMatchObject({ code: "invalid-url" });
  });

  it("requires a bare origins allowlist and valid options", () => {
    expect(() => remoteImageLoader({ origins: [] })).toThrow(/needs an origins allowlist/);
    expect(() => remoteImageLoader({} as RemoteImageLoaderOptions)).toThrow(/needs an origins allowlist/);
    expect(() => remoteImageLoader({ origins: ["cdn.example.com"] })).toThrow(/is not a URL/);
    expect(() => remoteImageLoader({ origins: ["ftp://cdn.example.com"] })).toThrow(/must use http: or https:/);
    for (const entry of [
      "https://cdn.example.com/avatars",
      "https://cdn.example.com/?v=1",
      "https://user:pass@cdn.example.com",
    ]) {
      expect(() => remoteImageLoader({ origins: [entry] })).toThrow(/must be bare origins/);
    }
    expect(() => remoteImageLoader({ origins: [new URL("https://cdn.example.com/")] })).not.toThrow();
    expect(() => remoteImageLoader({ origins: ["https://a.example"], cacheSize: -1 })).toThrow(/cacheSize/);
    expect(() => remoteImageLoader({ origins: ["https://a.example"], timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => remoteImageLoader({ origins: ["https://a.example"], formats: ["tiff" as "png"] })).toThrow(/formats/);
  });
});
