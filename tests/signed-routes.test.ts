import { describe, expect, it, vi } from "vitest";
import { verifyImage } from "../src/image.js";
import { signImagePath, verifyImageSignature } from "../src/index.js";
import { fontsourceFontLoader } from "../src/fonts.js";
import { createNextOg } from "../src/next.js";
import { createNodeOg } from "../src/node.js";
import { createPlateHandlers } from "../src/plate.js";

const secret = "route-secret-0123456789abcdefghijklmn";
const retired = "retired-secret-0123456789abcdefghijkl";
const signed = { secret } as const;

type Copy = { title: string };

/** A render and a resolver that record whether either ran. */
function spies() {
  const render = vi.fn(async (copy: Copy) => new Response(copy.title));
  const resolve = vi.fn((request: Request) => ({ title: new URL(request.url).pathname }));
  return { render, resolve, handlers: createPlateHandlers(render) };
}

describe("signed handlerFrom and fetchableFrom", () => {
  it("renders a correctly signed path", async () => {
    const { render, resolve, handlers } = spies();
    const GET = handlers.handlerFrom(resolve, { signed });
    const url = await signImagePath("https://example.com/posts/hello/og-image.png", secret);

    const response = await GET(new Request(url));
    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
  });

  it("returns 403 without resolving or rendering when the signature is missing or wrong", async () => {
    const { render, resolve, handlers } = spies();
    const route = handlers.fetchableFrom(resolve, { signed });
    const url = await signImagePath("https://example.com/posts/hello/og-image.png", secret);

    for (const target of [
      "https://example.com/posts/hello/og-image.png",
      url.replace("hello", "evil"),
      await signImagePath("https://example.com/posts/hello/og-image.png", retired),
    ]) {
      const response = await route.fetch(new Request(target));
      expect(response.status, target).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await response.text()).toBe("Forbidden");
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it("can answer 404 instead, and accepts retiring secrets during rotation", async () => {
    const { render, resolve, handlers } = spies();
    const GET = handlers.handlerFrom(resolve, { signed: { secrets: [secret, retired], status: 404 } });

    const missing = await GET(new Request("https://example.com/posts/hello/og-image.png"));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Not Found");
    expect(render).not.toHaveBeenCalled();

    const old = await signImagePath("https://example.com/posts/hello/og-image.png", retired);
    expect((await GET(new Request(old))).status).toBe(200);
    expect(render).toHaveBeenCalledOnce();
  });

  it("reads the request from framework context objects or a url callback", async () => {
    const { render, handlers } = spies();
    const url = await signImagePath("https://example.com/posts/hello/og-image.png", secret);

    // SvelteKit, Astro, and React Router pass `{ request, params, ... }`.
    const svelte = handlers.handlerFrom(
      ({ params }: { request: Request; params: { slug: string } }) => ({ title: params.slug }),
      { signed },
    );
    expect((await svelte({ request: new Request(url), params: { slug: "hello" } })).status).toBe(200);
    expect(render).toHaveBeenLastCalledWith({ title: "hello" });

    // Behind a rewrite, the public path is supplied explicitly.
    const rewritten = handlers.handlerFrom(
      (_request: Request, original: string) => ({ title: original }),
      { signed: { secret, url: (_request, original) => original } },
    );
    expect((await rewritten(new Request("https://internal/render"), url)).status).toBe(200);
    expect((await rewritten(new Request(url), "/posts/hello/og-image.png")).status).toBe(403);

    const contextless = handlers.handlerFrom((slug: string) => ({ title: slug }), { signed });
    await expect(contextless("hello")).rejects.toThrow(/pass signed\.url/);
  });

  it("validates secrets and status when the route is defined", () => {
    const { resolve, handlers } = spies();
    expect(() => handlers.handlerFrom(resolve, { signed: { secret: "short" } })).toThrow(/at least 32 bytes/);
    expect(() => handlers.fetchableFrom(resolve, { signed: { secrets: [] } })).toThrow(/at least one secret/);
    expect(() =>
      handlers.handlerFrom(resolve, { signed: { secret, status: 401 as 403 } }),
    ).toThrow(/403 or 404/);
    expect(() =>
      handlers.handlerFrom(resolve, {
        signed: { secret, secrets: [secret] } as unknown as { secret: string },
      }),
    ).toThrow(/not both/);
    expect(() => handlers.handlerFrom(resolve, { signed: {} as { secret: string } })).toThrow(
      /needs a secret or secrets/,
    );
  });

  it("leaves unsigned routes unchanged", async () => {
    const { render, resolve, handlers } = spies();
    const response = await handlers.handlerFrom(resolve)(new Request("https://example.com/a/og.png"));
    expect(response.status).toBe(200);
    expect(render).toHaveBeenCalledOnce();
  });
});

describe("signedMetadata", () => {
  const component = vi.fn((copy: Copy) => ({
    type: "div",
    props: {
      style: { display: "flex", width: "100%", height: "100%", fontFamily: "Inter", fontSize: 48 },
      children: copy.title,
    },
  }));
  const plate = createNodeOg<Copy, "square">({
    alt: (copy) => `${copy.title} card`,
    fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
    imagePath: "og-image.png",
    basePath: "/base",
    origin: "https://example.com",
    variants: { square: { size: { width: 1080, height: 1080 } } },
    component,
  });

  it("signs every image URL, including basePath, and nothing else", async () => {
    const copy = { title: "Hello" };
    const unsigned = plate.metadata("/posts/hello", copy, { twitter: { variant: "square" } });
    const metadata = await plate.signedMetadata("/posts/hello", copy, signed, {
      twitter: { variant: "square" },
    });

    expect(metadata.openGraph.images.map((image) => image.url)).toEqual([
      expect.stringMatching(/^https:\/\/example\.com\/base\/posts\/hello\/[\w-]{43}\/og-image\.png$/),
      expect.stringMatching(/^https:\/\/example\.com\/base\/posts\/hello\/[\w-]{43}\/og-image-square\.png$/),
    ]);
    expect(metadata.twitter.images[0]?.url).toBe(metadata.openGraph.images[1]?.url);
    expect({ ...metadata, openGraph: { ...metadata.openGraph, images: [] }, twitter: { ...metadata.twitter, images: [] } })
      .toEqual({ ...unsigned, openGraph: { ...unsigned.openGraph, images: [] }, twitter: { ...unsigned.twitter, images: [] } });
    for (const [index, image] of metadata.openGraph.images.entries()) {
      expect(await verifyImageSignature(image.url, secret)).toEqual({
        valid: true,
        path: new URL(unsigned.openGraph.images[index]!.url).pathname,
        secretIndex: 0,
      });
      expect(image).toEqual({ ...unsigned.openGraph.images[index], url: image.url });
    }

    const square = await plate.variant("square").signedMetadata("/posts/hello", copy, { secrets: [secret] });
    expect(square.openGraph.images.map((image) => image.url)).toEqual([metadata.openGraph.images[1]?.url]);
    // Static output is unsigned: sitePath and metadata are unchanged.
    expect(plate.sitePath("/posts/hello")).toBe("posts/hello/og-image.png");
  });

  it(
    "renders the URL signedMetadata emits and refuses a tampered one without rendering",
    async () => {
      const metadata = await plate.signedMetadata("/posts/hello", { title: "Hello" }, signed);
      const GET = plate.handlerFrom(
        (request: Request) => ({ title: new URL(request.url).pathname.split("/")[3] ?? "home" }),
        { signed },
      );

      const response = await GET(new Request(metadata.openGraph.images[0]!.url));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      verifyImage(new Uint8Array(await response.arrayBuffer()), plate.size, "png");

      expect(component).toHaveBeenCalledOnce();
      expect(component.mock.calls[0]?.[0]).toEqual({ title: "hello" });

      component.mockClear();
      const tampered = await GET(new Request(metadata.openGraph.images[0]!.url.replace("hello", "evil")));
      expect(tampered.status).toBe(403);
      expect(component).not.toHaveBeenCalled();
    },
    30_000,
  );
});

describe("metaplate/next", () => {
  it("verifies before rendering through next/og", async () => {
    const component = vi.fn(() => null as never);
    const plate = createNextOg<Copy>({ alt: (copy) => copy.title, component });
    const resolve = vi.fn((request: Request) => ({ title: request.url }));
    const GET = plate.handlerFrom(resolve, { signed });

    expect((await GET(new Request("https://example.com/posts/hello/og-image"))).status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
    expect(component).not.toHaveBeenCalled();

    const metadata = await plate.signedMetadata("/posts/hello", { title: "Hello" }, signed);
    expect(metadata.openGraph.images[0]?.url).toMatch(/^\/posts\/hello\/[\w-]{43}\/og-image$/);
  });
});
