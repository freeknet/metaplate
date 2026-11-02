import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIN_IMAGE_SIGNING_SECRET_BYTES,
  signImagePath,
  verifyImageSignature,
} from "../../src/index.js";

const current = "current-secret-0123456789abcdefghijkl";
const previous = "previous-secret-0123456789abcdefghijk";
const SIGNED = /^\/posts\/hello\/([A-Za-z0-9_-]{43})\/og-image\.png$/;

/** Rewrites the signature segment, the second-to-last path segment. */
function withSignature(path: string, edit: (signature: string) => string): string {
  const segments = path.split("/");
  segments[segments.length - 2] = edit(segments.at(-2)!);
  return segments.join("/");
}

/** Replaces one base64url character with a different one that keeps the encoding canonical. */
function flip(signature: string, index: number): string {
  const replacement = signature[index] === "A" ? "Q" : "A";
  return `${signature.slice(0, index)}${replacement}${signature.slice(index + 1)}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signImagePath", () => {
  it("inserts a 43-character base64url HMAC-SHA-256 segment before the file name", async () => {
    const signed = await signImagePath("/posts/hello/og-image.png", current);
    expect(signed).toMatch(SIGNED);
    expect(await signImagePath("/posts/hello/og-image.png", current)).toBe(signed);
    expect(await signImagePath("/posts/other/og-image.png", current)).not.toBe(
      signed.replace("hello", "other"),
    );
  });

  it("signs the domain-separated pathname, so other languages can reproduce it", async () => {
    const signed = await signImagePath("/posts/hello/og-image.png", current);
    const expected = createHmac("sha256", current)
      .update("metaplate:image-path:v1\n/posts/hello/og-image.png")
      .digest("base64url");
    expect(SIGNED.exec(signed)?.[1]).toBe(expected);
    // A bare HMAC of the path, as another feature sharing the secret might
    // compute, is not a valid image signature.
    const bare = createHmac("sha256", current).update("/posts/hello/og-image.png").digest("base64url");
    expect(await verifyImageSignature(`/posts/hello/${bare}/og-image.png`, current)).toEqual({
      valid: false,
      reason: "mismatch",
    });
  });

  it("keeps the origin, query, and fragment of an absolute URL without signing them", async () => {
    const signed = await signImagePath("https://example.com/base/docs/og-image.png?v=abc#x", current);
    expect(signed).toMatch(/^https:\/\/example\.com\/base\/docs\/[A-Za-z0-9_-]{43}\/og-image\.png\?v=abc#x$/);
    expect(await signImagePath(new URL("https://example.com/base/docs/og-image.png"), current)).toBe(
      signed.replace("?v=abc#x", ""),
    );
    const verified = await verifyImageSignature(signed.replace("?v=abc", "?v=changed"), current);
    expect(verified).toEqual({ valid: true, path: "/base/docs/og-image.png", secretIndex: 0 });
  });

  it("signs the root route and paths with a leading double slash as paths", async () => {
    expect(await signImagePath("/og-image", current)).toMatch(/^\/[A-Za-z0-9_-]{43}\/og-image$/);
    const doubled = await signImagePath("//example.com/og.png", current);
    expect(doubled).toMatch(/^\/\/example\.com\/[A-Za-z0-9_-]{43}\/og\.png$/);
    expect((await verifyImageSignature(doubled, current)).valid).toBe(true);
  });

  it.each([
    ["og-image.png", /pathname starting with "\/"/],
    ["ftp://example.com/og.png", /absolute http\(s\) URL/],
    ["/posts/hello/", /ends in a file segment/],
    ["/", /ends in a file segment/],
    ["/posts/\nhello/og.png", /tab or newline/],
  ])("rejects %j", async (path, message) => {
    await expect(signImagePath(path, current)).rejects.toThrow(message);
  });
});

describe("secrets", () => {
  it(`requires at least ${MIN_IMAGE_SIGNING_SECRET_BYTES} bytes per secret`, async () => {
    await expect(signImagePath("/og.png", "short")).rejects.toThrow(/at least 32 bytes; received 5/);
    await expect(signImagePath("/og.png", [current, "short"])).rejects.toThrow(/secret 1 must be at least/);
    await expect(signImagePath("/og.png", [])).rejects.toThrow(/at least one secret/);
    await expect(
      signImagePath("/og.png", 42 as unknown as string),
    ).rejects.toThrow(/string or a Uint8Array/);
  });

  it("treats a string and its UTF-8 bytes as the same key", async () => {
    const bytes = new TextEncoder().encode(current);
    expect(await signImagePath("/og.png", bytes)).toBe(await signImagePath("/og.png", current));
  });

  it("signs with the first secret and verifies with any, reporting which matched", async () => {
    const old = await signImagePath("/posts/hello/og-image.png", previous);
    const rotated = await signImagePath("/posts/hello/og-image.png", [current, previous]);

    expect(rotated).toBe(await signImagePath("/posts/hello/og-image.png", current));
    expect(await verifyImageSignature(old, [current, previous])).toEqual({
      valid: true,
      path: "/posts/hello/og-image.png",
      secretIndex: 1,
    });
    expect(await verifyImageSignature(rotated, [current, previous])).toMatchObject({ secretIndex: 0 });
    // Retiring the previous secret invalidates every URL it signed.
    expect(await verifyImageSignature(old, [current])).toEqual({ valid: false, reason: "mismatch" });
  });
});

describe("verifyImageSignature", () => {
  it("rejects tampered paths and signatures", async () => {
    const signed = await signImagePath("/posts/hello/og-image.png", current);
    const mismatch = { valid: false, reason: "mismatch" };

    expect(await verifyImageSignature(signed.replace("hello", "hellp"), current)).toEqual(mismatch);
    expect(await verifyImageSignature(signed.replace("og-image.png", "og-image.jpg"), current)).toEqual(mismatch);
    expect(await verifyImageSignature(`/x${signed}`, current)).toEqual(mismatch);
    expect(await verifyImageSignature(withSignature(signed, (s) => flip(s, 0)), current)).toEqual(mismatch);
    expect(await verifyImageSignature(withSignature(signed, (s) => flip(s, 41)), current)).toEqual(mismatch);
    expect(await verifyImageSignature(signed, "another-secret-0123456789abcdefghijk")).toEqual(mismatch);
  });

  it("reports a path without a canonical signature segment as malformed", async () => {
    const signed = await signImagePath("/posts/hello/og-image.png", current);
    const malformed = { valid: false, reason: "malformed" };
    const signature = SIGNED.exec(signed)![1]!;
    // The final character carries two unused bits; only the zero-bit spelling is accepted.
    const index = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(signature.at(-1)!);
    const alias = `${signature.slice(0, -1)}${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[index + 1]}`;

    for (const path of [
      "/posts/hello/og-image.png",
      "/og-image.png",
      signed.replace("/og-image.png", "/"),
      withSignature(signed, (s) => s.slice(1)),
      withSignature(signed, (s) => `${s}A`),
      withSignature(signed, (s) => `${s.slice(0, -1)}=`),
      withSignature(signed, (s) => `%41${s.slice(1)}`),
      withSignature(signed, () => alias),
    ]) {
      expect(await verifyImageSignature(path, current), path).toEqual(malformed);
    }
  });

  it("delegates the comparison to Web Crypto's constant-time HMAC verify", async () => {
    const signed = await signImagePath("/posts/hello/og-image.png", current);
    const verify = vi.spyOn(crypto.subtle, "verify");

    // A wrong first byte and a wrong last byte take the same path: the
    // decoded bytes reach crypto.subtle.verify for every secret, with no
    // JavaScript comparison that could stop at the first differing byte.
    for (const index of [0, 41]) {
      verify.mockClear();
      const tampered = withSignature(signed, (s) => flip(s, index));
      expect((await verifyImageSignature(tampered, [current, previous])).valid).toBe(false);
      expect(verify).toHaveBeenCalledTimes(2);
      for (const [algorithm, , signature, data] of verify.mock.calls) {
        expect(algorithm).toBe("HMAC");
        expect(signature).toBeInstanceOf(Uint8Array);
        expect((signature as Uint8Array).byteLength).toBe(32);
        expect(new TextDecoder().decode(data as Uint8Array)).toBe(
          "metaplate:image-path:v1\n/posts/hello/og-image.png",
        );
      }
    }

    // A malformed segment is rejected on its public format alone.
    verify.mockClear();
    await verifyImageSignature("/posts/hello/not-a-signature/og-image.png", current);
    expect(verify).not.toHaveBeenCalled();
  });

  it("accepts URL objects and rejects non-http inputs", async () => {
    const signed = await signImagePath("https://example.com/docs/og.png", current);
    expect((await verifyImageSignature(new URL(signed), current)).valid).toBe(true);
    await expect(verifyImageSignature("javascript:alert(1)", current)).rejects.toThrow(/http\(s\)/);
    await expect(verifyImageSignature("docs/og.png", current)).rejects.toThrow(/starting with "\/"/);
  });

  it("is implemented without Node built-ins", () => {
    const source = readFileSync(new URL("../../src/metadata/signing.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/\bBuffer\b/);
  });
});
