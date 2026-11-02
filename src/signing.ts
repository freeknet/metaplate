/**
 * Signed image paths: an HMAC-SHA-256 signature, carried as one path segment,
 * that lets a dynamic image route refuse to render any URL the application
 * did not issue. Web Crypto only (no Node built-ins), so the same code runs in
 * Node 20+, Deno, and edge runtimes. See docs/signed-routes.md.
 */

/** Secret key material: a string (UTF-8 encoded) or raw bytes, at least 32 bytes long. */
export type ImageSigningSecret = string | Uint8Array;

/**
 * One secret, or an ordered list for rotation: signing always uses the first,
 * verification accepts any of them.
 */
export type ImageSigningSecrets = ImageSigningSecret | readonly ImageSigningSecret[];

/** The keys a signed plate route or `signedMetadata` uses: `secret` or `secrets`, not both. */
export type ImageSigningKeys =
  | { secret: ImageSigningSecret; secrets?: never }
  | { secrets: readonly ImageSigningSecret[]; secret?: never };

/** The outcome of `verifyImageSignature`. */
export type ImageSignatureVerification =
  | {
      valid: true;
      /** The pathname with the signature segment removed, as it was signed. */
      path: string;
      /** Index of the secret that matched; above 0 means a retiring key is still in use. */
      secretIndex: number;
    }
  | {
      valid: false;
      /**
       * `malformed` when the path has no well-formed signature segment before
       * its last segment; `mismatch` when it has one that no secret produced.
       */
      reason: "malformed" | "mismatch";
    };

/** Minimum secret length in bytes: the HMAC-SHA-256 output size (RFC 2104 section 3). */
export const MIN_IMAGE_SIGNING_SECRET_BYTES = 32;

/** HMAC-SHA-256 is 32 bytes, which unpadded base64url writes as 43 characters. */
const SIGNATURE_BYTES = 32;
const SIGNATURE_LENGTH = 43;

/**
 * Domain separation: a secret shared with another HMAC use in the same
 * application (sessions, CSRF tokens) can never produce a valid image
 * signature for a message that use signs, or the reverse.
 */
const MESSAGE_PREFIX = "metaplate:image-path:v1\n";

/** Parses relative paths without letting a leading `//` become a host. */
const RELATIVE_BASE = "http://metaplate.invalid";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const ALPHABET_INDEX = new Map([...ALPHABET].map((character, index) => [character, index]));

function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset]!;
    const b = bytes[offset + 1];
    const c = bytes[offset + 2];
    output += ALPHABET[a >> 2]!;
    output += ALPHABET[((a & 0b11) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) output += ALPHABET[((b & 0b1111) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) output += ALPHABET[c & 0b111111]!;
  }
  return output;
}

/**
 * Decodes a signature segment, or returns undefined unless it is the one
 * canonical encoding of 32 bytes. The final character of 43 carries two
 * unused bits; accepting non-zero values there would give every signature
 * four spellings, and so four cache keys for one image.
 */
function decodeSignature(segment: string): Uint8Array<ArrayBuffer> | undefined {
  if (segment.length !== SIGNATURE_LENGTH) return undefined;
  const values: number[] = [];
  for (const character of segment) {
    const value = ALPHABET_INDEX.get(character);
    if (value === undefined) return undefined;
    values.push(value);
  }
  if ((values[SIGNATURE_LENGTH - 1]! & 0b11) !== 0) return undefined;
  const bytes = new Uint8Array(SIGNATURE_BYTES);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const value of values) {
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }
  return bytes;
}

function secretList(secrets: ImageSigningSecrets): readonly ImageSigningSecret[] {
  return Array.isArray(secrets) ? secrets : [secrets as ImageSigningSecret];
}

function secretBytes(secret: ImageSigningSecret, index: number): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  if (typeof secret === "string") {
    bytes = new TextEncoder().encode(secret);
  } else if (secret instanceof Uint8Array) {
    bytes = new Uint8Array(secret);
  } else {
    throw new TypeError(`Image signing secret ${index} must be a string or a Uint8Array`);
  }
  if (bytes.byteLength < MIN_IMAGE_SIGNING_SECRET_BYTES) {
    throw new TypeError(
      `Image signing secret ${index} must be at least ${MIN_IMAGE_SIGNING_SECRET_BYTES} bytes; ` +
        `received ${bytes.byteLength}. Generate one with ` +
        `\`node -e "console.log(crypto.randomBytes(32).toString('base64url'))"\`.`,
    );
  }
  return bytes;
}

/** Normalises `{ secret }` / `{ secrets }` to the ordered list signing uses. */
export function signingSecrets(keys: ImageSigningKeys): readonly ImageSigningSecret[] {
  const { secret, secrets } = keys as { secret?: ImageSigningSecret; secrets?: readonly ImageSigningSecret[] };
  if (secret !== undefined && secrets !== undefined) {
    throw new TypeError("Pass either secret or secrets for image signing, not both");
  }
  const list = secrets ?? (secret === undefined ? undefined : [secret]);
  if (list === undefined) throw new TypeError("Image signing needs a secret or secrets");
  return list;
}

function subtleCrypto(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) {
    throw new Error("Image signing needs Web Crypto (globalThis.crypto.subtle), available in Node 20+, Deno, and edge runtimes");
  }
  return subtle;
}

export type ImageSigner = {
  sign: (path: string | URL) => Promise<string>;
  verify: (path: string | URL) => Promise<ImageSignatureVerification>;
};

/**
 * Validates the secrets now and imports them as HMAC keys once, on first use,
 * so a route verifying many requests does not re-import per request.
 */
export function createImageSigner(secrets: ImageSigningSecrets): ImageSigner {
  const list = secretList(secrets);
  if (list.length === 0) throw new TypeError("Image signing needs at least one secret");
  const material = list.map((secret, index) => secretBytes(secret, index));
  let keys: Promise<CryptoKey[]> | undefined;
  const importKeys = () => {
    keys ??= Promise.all(
      material.map((bytes) =>
        subtleCrypto().importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
      ),
    ).catch((error: unknown) => {
      keys = undefined;
      throw error;
    });
    return keys;
  };
  const encodeMessage = (pathname: string) => new TextEncoder().encode(MESSAGE_PREFIX + pathname);

  return Object.freeze({
    async sign(path: string | URL) {
      const { url, relative } = parseTarget(path, "signImagePath");
      const segments = url.pathname.split("/");
      const file = segments.at(-1);
      if (!file) {
        throw new Error(`signImagePath needs a path that ends in a file segment, such as /posts/hello/og-image.png; received ${String(path)}`);
      }
      const [key] = await importKeys();
      const mac = new Uint8Array(await subtleCrypto().sign("HMAC", key!, encodeMessage(url.pathname)));
      url.pathname = [...segments.slice(0, -1), encodeBase64Url(mac), file].join("/");
      return relative ? `${url.pathname}${url.search}${url.hash}` : url.href;
    },
    async verify(path: string | URL): Promise<ImageSignatureVerification> {
      const { url } = parseTarget(path, "verifyImageSignature");
      const segments = url.pathname.split("/");
      const file = segments.at(-1);
      const signature = segments.length >= 3 && file ? decodeSignature(segments.at(-2)!) : undefined;
      if (!signature) return { valid: false, reason: "malformed" };
      const unsigned = [...segments.slice(0, -2), file].join("/");
      const message = encodeMessage(unsigned);
      const imported = await importKeys();
      for (const [index, key] of imported.entries()) {
        // Web Crypto's HMAC verify recomputes the MAC and compares it in
        // constant time, as the specification requires; no string or byte
        // comparison of secret-derived data happens in JavaScript here.
        if (await subtleCrypto().verify("HMAC", key, signature, message)) {
          return { valid: true, path: unsigned, secretIndex: index };
        }
      }
      return { valid: false, reason: "mismatch" };
    },
  });
}

/**
 * Accepts a pathname starting with `/` or an absolute http(s) URL. Tab and
 * newline are rejected because URL parsing strips them, which would sign a
 * different path from the one written.
 */
function parseTarget(input: string | URL, label: string): { url: URL; relative: boolean } {
  if (input instanceof URL) return { url: assertHttp(new URL(input.href), label, input.href), relative: false };
  if (typeof input !== "string") throw new TypeError(`${label} needs a path or URL string`);
  if (/[\t\n\r]/.test(input)) {
    throw new Error(`${label} path must not contain tab or newline characters: ${JSON.stringify(input)}`);
  }
  if (input.startsWith("/")) return { url: new URL(RELATIVE_BASE + input), relative: true };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${label} needs a pathname starting with "/" or an absolute http(s) URL; received ${input}`);
  }
  return { url: assertHttp(url, label, input), relative: false };
}

function assertHttp(url: URL, label: string, input: string): URL {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} needs a pathname starting with "/" or an absolute http(s) URL; received ${input}`);
  }
  return url;
}

/**
 * Inserts an HMAC-SHA-256 signature of the pathname as a new segment before
 * its last segment: `/posts/hello/og-image.png` becomes
 * `/posts/hello/<43 base64url characters>/og-image.png`. Accepts a pathname
 * or an absolute http(s) URL; the origin, query, and fragment are kept but not
 * signed. With several secrets, the first signs.
 */
export async function signImagePath(path: string | URL, secrets: ImageSigningSecrets): Promise<string> {
  return createImageSigner(secrets).sign(path);
}

/**
 * Checks the signature segment `signImagePath` inserted, against every secret
 * in order. Only the pathname is covered: the query string is ignored, so a
 * signed route must not read copy from it.
 */
export async function verifyImageSignature(
  path: string | URL,
  secrets: ImageSigningSecrets,
): Promise<ImageSignatureVerification> {
  return createImageSigner(secrets).verify(path);
}
