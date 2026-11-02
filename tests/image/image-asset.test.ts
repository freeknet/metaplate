import { describe, expect, it } from "vitest";
import {
  IMAGE_ASSET_DEFAULTS,
  imageAsset,
  imageAssetLoader,
  imageDimensions,
} from "../../src/image.js";
import { RED_GIF, completeJpeg, completePng, fixture } from "../helpers/image-fixtures.js";

const encode = (text: string) => new TextEncoder().encode(text);

function decoded(src: string): Uint8Array {
  const [, payload] = src.split(",", 2);
  return Uint8Array.from(atob(payload!), (character) => character.charCodeAt(0));
}

describe("imageAsset", () => {
  it("embeds a PNG as a base64 data URI with its dimensions", () => {
    const png = completePng(320, 200);
    const asset = imageAsset(png);
    expect(asset).toEqual({
      src: expect.stringMatching(/^data:image\/png;base64,/),
      width: 320,
      height: 200,
      format: "png",
      contentType: "image/png",
      byteLength: png.byteLength,
    });
    expect(decoded(asset.src)).toEqual(png);
    expect(Object.isFrozen(asset)).toBe(true);
  });

  it("accepts an ArrayBuffer, a Node Buffer, and a view into a larger buffer", () => {
    const png = completePng(10, 20);
    const padded = new Uint8Array(png.byteLength + 8);
    padded.set(png, 4);
    for (const input of [
      png.slice().buffer,
      Buffer.from(png),
      new DataView(padded.buffer, 4, png.byteLength),
    ]) {
      expect(imageAsset(input)).toMatchObject({ width: 10, height: 20, byteLength: png.byteLength });
    }
  });

  it("embeds real JPEG encoder output", () => {
    const jpeg = fixture("card.jpg");
    expect(imageAsset(jpeg)).toMatchObject({ ...imageDimensions(jpeg), contentType: "image/jpeg" });
    expect(imageAsset(jpeg).format).toBe("jpeg");
  });

  it("reads SVG pixel dimensions", () => {
    const asset = imageAsset(encode('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"/>'));
    expect(asset).toMatchObject({ width: 120, height: 40, format: "svg", contentType: "image/svg+xml" });
  });

  it("sizes a viewBox-only SVG the way Satori does", () => {
    const svg = (attributes: string) =>
      encode(`<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><path d="M0 0h1v1z"/></svg>`);
    expect(imageAsset(svg('viewBox="0 0 48 24"'))).toMatchObject({ width: 48, height: 24 });
    expect(imageAsset(svg('viewBox="-4,-4, 48,24"'))).toMatchObject({ width: 48, height: 24 });
    expect(imageAsset(svg('width="96" viewBox="0 0 48 24"'))).toMatchObject({ width: 96, height: 48 });
    expect(imageAsset(svg('height="12" viewBox="0 0 48 24"'))).toMatchObject({ width: 24, height: 12 });
    // A percentage is not an intrinsic size, so the viewBox decides.
    expect(imageAsset(svg('width="100%" height="100%" viewBox="0 0 48 24"'))).toMatchObject({
      width: 48,
      height: 24,
    });
  });

  it("rejects an SVG without a usable size", () => {
    const svg = (attributes: string) => encode(`<svg xmlns="http://www.w3.org/2000/svg" ${attributes}/>`);
    expect(() => imageAsset(svg(""))).toThrow(/pixel width and height attributes or a viewBox/);
    expect(() => imageAsset(svg('width="10"'))).toThrow(/pixel width and height attributes or a viewBox/);
    expect(() => imageAsset(svg('viewBox="0 0 0 10"'))).toThrow(/viewBox must be four numbers/);
    expect(() => imageAsset(svg('viewBox="0 0 10"'))).toThrow(/viewBox must be four numbers/);
    expect(() => imageAsset(svg('viewBox="0 0 1 1" viewBox="0 0 2 2"'))).toThrow(/more than one viewBox/);
    expect(() => imageAsset(svg('width="1" width="2" viewBox="0 0 1 1"'))).toThrow(/more than one width/);
  });

  it("keeps the SVG safety rules of the verifier", () => {
    expect(() =>
      imageAsset(encode('<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')),
    ).toThrow(/DOCTYPE and entity declarations/);
    expect(() =>
      imageAsset(encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect/>')),
    ).toThrow(/closing root element/);
  });

  it("rejects truncated or mislabelled bytes with the detector's reason", () => {
    const jpeg = completeJpeg(40, 30);
    expect(() => imageAsset(jpeg.subarray(0, jpeg.byteLength - 2))).toThrow(/Not a JPEG/);
    expect(() => imageAsset(encode("<!doctype html><title>404</title>"))).toThrow(
      /Unrecognized image \(\d+ bytes starting 3c 21 64 6f.*\): Satori's <img> accepts PNG, JPEG, GIF, WebP, and SVG/,
    );
    expect(() => imageAsset(new Uint8Array())).toThrow(/Unrecognized image \(0 bytes starting \(empty\)\)/);
  });

  it.each([
    ["AVIF", [0, 0, 0, 0x1c, ...textBytes("ftypavif")]],
    ["HEIC/HEIF", [0, 0, 0, 0x18, ...textBytes("ftypheic")]],
    ["JPEG XL", [0xff, 0x0a, 0, 0, 0, 0, 0, 0]],
    ["TIFF", [0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]],
    ["ICO", [0, 0, 1, 0, 1, 0, 16, 16]],
    ["BMP", [...textBytes("BM"), ...new Array<number>(20).fill(0)]],
  ])("names %s as a format Satori cannot embed", (name, bytes) => {
    expect(() => imageAsset(Uint8Array.from(bytes))).toThrow(
      `${name} images cannot be embedded: Satori's <img> accepts PNG, JPEG, GIF, WebP, and SVG. Convert it to PNG or JPEG`,
    );
  });

  it("leaves WebP and GIF out by default and explains why", () => {
    expect(IMAGE_ASSET_DEFAULTS.formats).toEqual(["png", "jpeg", "svg"]);
    expect(() => imageAsset(fixture("card-lossy.webp"))).toThrow(
      /WebP images are not enabled: Resvg 2\.6 .* draw WebP as nothing/,
    );
    expect(() => imageAsset(RED_GIF)).toThrow(/GIF images are not enabled: next\/og draws GIF as nothing/);
  });

  it("accepts an opted-in format and restricts to the listed formats", () => {
    expect(imageAsset(RED_GIF, { formats: ["png", "gif"] })).toMatchObject({ format: "gif", width: 1, height: 1 });
    expect(imageAsset(fixture("card-lossless.webp"), { formats: ["webp"] })).toMatchObject({ format: "webp" });
    expect(() => imageAsset(completePng(1, 1), { formats: ["jpeg"] })).toThrow(
      "PNG images are not enabled: formats allows only JPEG",
    );
    expect(() => imageAsset(RED_GIF, { formats: [] })).toThrow("formats allows only nothing");
    expect(() => imageAsset(RED_GIF, { formats: ["avif" as "png"] })).toThrow(/formats entries must be one of/);
  });

  it("enforces maxBytes before decoding", () => {
    const png = completePng(1, 1);
    expect(imageAsset(png, { maxBytes: png.byteLength })).toMatchObject({ format: "png" });
    expect(() => imageAsset(png, { maxBytes: png.byteLength - 1 })).toThrow(RangeError);
    expect(() => imageAsset(png, { maxBytes: png.byteLength - 1 })).toThrow(/over the \d+-byte maxBytes limit/);
    expect(() => imageAsset(png, { maxBytes: 0 })).toThrow(/maxBytes must be a positive integer/);
    expect(() => imageAsset(new Uint8Array(IMAGE_ASSET_DEFAULTS.maxBytes + 1))).toThrow(/4194304-byte/);
  });
});

describe("imageAssetLoader", () => {
  it("loads once and shares the asset across renders", async () => {
    let calls = 0;
    const logo = imageAssetLoader(async () => {
      calls += 1;
      return completePng(4, 4);
    });
    const [first, second] = await Promise.all([logo(), logo()]);
    expect(first).toBe(second);
    expect(first).toBe(await logo());
    expect(calls).toBe(1);
  });

  it("accepts bytes and a Response directly", async () => {
    await expect(imageAssetLoader(completePng(2, 3))()).resolves.toMatchObject({ width: 2, height: 3 });
    const response = new Response(Buffer.from(completePng(5, 6)));
    await expect(imageAssetLoader(response)()).resolves.toMatchObject({ width: 5, height: 6 });
  });

  it("rejects a failed Response and retries on the next call", async () => {
    let calls = 0;
    const logo = imageAssetLoader(() => {
      calls += 1;
      return calls === 1
        ? new Response("<!doctype html>missing", { status: 404 })
        : new Response(Buffer.from(completePng(7, 7)));
    });
    await expect(logo()).rejects.toThrow(/returned 404/);
    await expect(logo()).resolves.toMatchObject({ width: 7 });
    expect(calls).toBe(2);
  });

  it("does not memoize a format error, so a fixed source recovers", async () => {
    let bytes: Uint8Array = encode("not an image");
    const logo = imageAssetLoader(() => bytes);
    await expect(logo()).rejects.toThrow(/Unrecognized image/);
    bytes = completePng(3, 3);
    await expect(logo()).resolves.toMatchObject({ width: 3 });
  });

  it("validates options when it is defined", () => {
    expect(() => imageAssetLoader(completePng(1, 1), { maxBytes: -1 })).toThrow(/maxBytes/);
    expect(() => imageAssetLoader(completePng(1, 1), { formats: ["bmp" as "png"] })).toThrow(/formats/);
  });
});

function textBytes(text: string): number[] {
  return Array.from(text, (character) => character.charCodeAt(0));
}
