# Signed image routes

Sign the image URLs your pages emit, and have the dynamic image route refuse
any URL your application did not issue, before it resolves copy or renders.

A dynamic image route that turns request data into card text lets anyone make
your server render arbitrary text: abusive cards served from your domain,
unbounded CPU and memory spent on unique URLs, and, behind a shared cache,
poisoned entries for real pages. This is not hypothetical:
[CVE-2026-102527](https://github.com/advisories/GHSA-2x6f-rp82-ppmj)
("cache poisoning through derivable cache keys on unsigned dynamic image
routes") let an unauthenticated request change the content of a real
`nuxt-og-image` card. nuxt-og-image now signs image URLs and answers a missing
or invalid signature with 403
([security guide](https://nuxtseo.com/docs/og-image/guides/security)), with
the key derived from the app secret since
[v7](https://nuxtseo.com/docs/og-image/releases/v7).
Vercel documents the same pattern of an HMAC over the parameters checked before
`ImageResponse` runs
([Encrypting parameters](https://vercel.com/kb/guide/encrypting-parameters)).

Signing is opt-in in Metaplate. Static files from
[`metaplate render`](render-cli.md) need none of it.

## How it works

A signed URL carries an HMAC-SHA-256 signature as one extra path segment,
inserted before the last segment:

```
/posts/hello/og-image.png
/posts/hello/q3n0Xb9hT1o0eR4vJm0eS2pY8kC7wA5uL6dF1gH2iJ4/og-image.png
```

- **Algorithm.** HMAC-SHA-256 through Web Crypto (`crypto.subtle`), so the same
  code runs in Node 20+, Deno, and the edge entry. No Node built-ins.
- **Signed message.** `metaplate:image-path:v1\n` followed by the URL's
  pathname without the signature segment, as WHATWG URL parsing serializes it
  (so `basePath` is included, the origin is not). The prefix separates image
  signatures from any other HMAC the same secret might produce. Any language
  can reproduce it: in Node,
  `createHmac("sha256", secret).update("metaplate:image-path:v1\n" + pathname).digest("base64url")`.
- **Encoding.** Unpadded base64url, always 43 characters. Only the canonical
  spelling is accepted, so each image has exactly one signed URL and one cache
  key.
- **Comparison.** Verification calls `crypto.subtle.verify`, whose HMAC
  operation the
  [Web Cryptography specification](https://w3c.github.io/webcrypto/#hmac-operations)
  requires to compare "in constant-time". No secret-derived bytes are compared
  in JavaScript.
- **Why a path segment.** `socialImagePath` rejects query strings and
  fragments in `route`, `basePath`, and `imagePath`, because they change the
  URL a crawler resolves; the signature follows the same rule. A path segment
  also survives CDNs and hosts that strip or reorder query strings, keeps the
  file extension last for static-host content types, and maps onto every
  framework's dynamic route segment.

## Signing on the page

`signedMetadata` is `metadata` with every image URL signed: the default card,
each [variant](variants.md), and the X Card image. It is async because Web
Crypto is:

```ts
import { og } from "$lib/og";
import { OG_IMAGE_SECRET } from "$app/env/private";

export async function load({ params }) {
  const post = await getPost(params.slug);
  return {
    social: await og.signedMetadata(`/posts/${post.slug}`, { title: post.title }, {
      secret: OG_IMAGE_SECRET,
    }),
  };
}
```

Every other field matches `metadata`, so the result goes straight into
`socialMetaTags`, Next's `Metadata`, or JSON-LD. `plate.variant(name)` has its
own `signedMetadata`, and `metaplate/next` plates have one too.

Without a plate, `signImagePath` signs any pathname or absolute http(s) URL;
it keeps the origin, query, and fragment but does not sign them:

```ts
import { signImagePath } from "metaplate";

await signImagePath("https://example.com/posts/hello/og-image.png", process.env.OG_IMAGE_SECRET!);
// "https://example.com/posts/hello/<signature>/og-image.png"
```

## Verifying in the route

`handlerFrom` and `fetchableFrom` on `metaplate/node`, `metaplate/edge`, and
`metaplate/next` plates take a second argument. With `signed`, the route
verifies the request path first and answers a missing or invalid signature
without calling the resolver or the renderer:

```ts
// src/routes/posts/[slug]/[signature]/og-image.png/+server.ts
import { OG_IMAGE_SECRET } from "$app/env/private";
import { og } from "$lib/og";

export const GET = og.handlerFrom(
  async ({ params }) => ({ title: (await getPost(params.slug))?.title ?? "Example" }),
  { signed: { secret: OG_IMAGE_SECRET } },
);
```

The route needs one dynamic segment for the signature before the file name:
`app/posts/[slug]/[signature]/og-image.png/route.ts` in Next.js,
`src/pages/posts/[slug]/[signature]/og-image.png.ts` in Astro, or
`/og/:slug/:signature/og-image.png` in Netlify's `config.path`. The resolver
ignores the signature parameter.

| Option | Default | Meaning |
| --- | --- | --- |
| `secret` or `secrets` | required | One secret, or several newest first (see [rotation](#rotating-secrets)). At least 32 bytes each; checked when the route is defined. |
| `status` | `403` | `403` or `404` for a rejected request. |
| `url` | the request's URL | `(...handlerArguments) => string \| URL`, the public URL or pathname the request was made for. |

The request URL is read from the first handler argument when it is a `Request`
(Next.js, Netlify, Deno, Vercel), or from its `request` property (SvelteKit,
Astro, React Router). The signature covers the path the client requested, so
when a rewrite, proxy, or framework changes the path the handler sees (for
example by removing a `basePath`), supply `url` with the public one. A route
that cannot find a URL throws, rather than rendering unchecked.

### 403 or 404

A rejection is `403 Forbidden` by default: the server understood the request
and refuses it ([RFC 9110 section 15.5.4](https://www.rfc-editor.org/rfc/rfc9110.html#name-403-forbidden)),
the status nuxt-og-image uses. `401` is wrong here, because it requires a
`WWW-Authenticate` challenge (section 15.5.2) and there are no credentials to
offer. Set `status: 404` to avoid confirming that the route exists; RFC 9110
allows a server that wishes to hide a forbidden resource to answer 404.

Either way the response is a short `text/plain` body with `Cache-Control:
no-store`, and the plate's `headers` (such as a long `Cache-Control`) are not
applied. That matters for 404, which caches may store heuristically when no
cache policy is sent (RFC 9110 section 15.1): without `no-store`, a URL
rejected during a rotation mistake could stay rejected at the CDN after the
fix.

### Without `handlerFrom`

Express and other servers verify directly. `verifyImageSignature` takes a
pathname (with or without a query) or an absolute URL:

```ts
import { verifyImageSignature } from "metaplate";

app.get("/posts/:slug/:signature/og-image.png", async (request, response, next) => {
  try {
    const result = await verifyImageSignature(request.originalUrl, secrets);
    if (!result.valid) {
      response.status(403).set("Cache-Control", "no-store").end();
      return;
    }
    response.type(og.contentType).send(Buffer.from(await og.render(copyFor(request.params.slug))));
  } catch (error) {
    next(error);
  }
});
```

A valid result carries the unsigned `path` and `secretIndex`, the position of
the secret that matched; a non-zero index means URLs signed with a retiring
secret are still being requested. An invalid result has `reason: "malformed"`
(no well-formed signature segment) or `"mismatch"`.

## Static files

Static files need no signing: nothing renders at request time, so there is
nothing to abuse. [`metaplate render`](render-cli.md) writes each image to
`plate.sitePath(route)`, which is unsigned, and pages pointing at those files
use `metadata`, not `signedMetadata`. A signed URL would point at a path no
file exists at.

A site can mix both: static cards for known pages from `metaplate render`, and
a signed dynamic route for pages created after the build. Give the two
different `imagePath`s or routes so a static file is never mistaken for a
signed one.

## Secrets

- **Generate** at least 32 random bytes, for example
  `node -e "console.log(crypto.randomBytes(32).toString('base64url'))"` or
  `openssl rand -base64 32`. Shorter secrets are rejected; a string secret is
  used as its UTF-8 bytes, and a `Uint8Array` as is.
- **Store** it in the deployment's secret environment variables, never in the
  repository. Use the same value on every instance and region, or URLs signed
  by one instance fail on another.
- **Keep it out of client bundles.** Sign only in server code: server
  components, `load` functions in `+page.server.ts`, endpoints, and build
  scripts. Frameworks inline some variables into browser JavaScript: anything
  prefixed `NEXT_PUBLIC_` in Next.js
  ([docs](https://nextjs.org/docs/app/guides/environment-variables)),
  `VITE_` in Vite ([docs](https://vite.dev/guide/env-and-mode)), and
  `PUBLIC_` in Astro
  ([docs](https://docs.astro.build/en/guides/environment-variables/)). Never
  give the secret such a prefix. SvelteKit 3's `$app/env/private` cannot be
  imported into browser code
  ([docs](https://svelte.dev/docs/kit/environment-variables)).
- **Use a dedicated secret.** The message prefix keeps image signatures
  distinct from other HMACs, but a secret used only for images can be rotated
  without logging anyone out.

### Rotating secrets

Pass `secrets` newest first. Signing uses the first; verification accepts any.

1. Generate a new secret and deploy with `secrets: [next, current]`. Pages now
   emit URLs signed with `next`, and URLs already in HTML, feeds, and crawler
   caches keep working through `current`.
2. Wait until those old URLs stop mattering: re-rendered or revalidated pages,
   plus however long social platforms keep their copy (`secretIndex` above 0
   in `verifyImageSignature` shows they are still requested).
3. Deploy with `secrets: [next]`.

After a leak, skip the wait: deploy `secrets: [replacement]` at once and accept
that every previously shared preview breaks until the platform refetches the
page.

## Threat model

Signing guarantees that the route renders only paths the application signed.
It protects against:

- **Arbitrary text.** A request cannot put its own text on a card served from
  your origin, by path or by changing a parameter in a signed path.
- **Cache poisoning through image URLs.** Every cacheable URL was issued by the
  application, so a forged URL cannot occupy, or collide with, a real card's
  cache key, and the 403/404 carries `no-store`.
- **Render amplification.** Unique URLs no longer each cost a render; an
  invalid signature costs one HMAC, and the resolver (and any database lookup
  it makes) never runs.

It does not protect against:

- **Replay.** A signed URL is valid until its secret is retired; there is no
  expiry, because crawlers fetch and refetch previews long after a page is
  shared. Anyone can request a real card repeatedly, so keep caching, rate
  limits, and provider concurrency limits.
- **What you sign.** If a page signs text a user typed (a comment, a profile
  name), that text renders. Resolve copy from your own data by slug, and
  validate and bound it, as [support](support.md) advises for every dynamic
  route.
- **The query string.** Only the pathname is signed. A resolver that reads
  `searchParams` reads unsigned input; put every input in the path.
- **Confidentiality.** Signing is not encryption: the path stays readable.
  Do not put private data in it.
- **A leaked secret.** Anyone holding it can sign anything; rotate as above.
- **Request floods.** Rejection is cheap, not free; volumetric attacks belong
  to the CDN or WAF.
- **Remote assets in the plate.** Signing does not make it safe to fetch
  request-chosen image URLs; keep those allowlisted
  ([deployment](deployment.md)).

## Query strings and cache-busting versions

A URL may carry a query, such as a cache-busting version `v` parameter. The
signature covers only the pathname, so adding, removing, or changing the query
neither breaks nor forges a signature, and signing in either order gives the
same path: `signImagePath` keeps an existing query, and a query appended to a
signed URL is ignored by verification. Treat the query as a cache key, never as
input to the card.

## Reference

```ts
// metaplate
signImagePath(path: string | URL, secrets: ImageSigningSecrets): Promise<string>;
verifyImageSignature(path: string | URL, secrets: ImageSigningSecrets): Promise<ImageSignatureVerification>;
type ImageSigningSecrets = ImageSigningSecret | readonly ImageSigningSecret[]; // string | Uint8Array
type ImageSigningKeys = { secret: ImageSigningSecret } | { secrets: readonly ImageSigningSecret[] };
const MIN_IMAGE_SIGNING_SECRET_BYTES = 32;

// metaplate/node, metaplate/edge, metaplate/next plates and their variants
plate.signedMetadata(route, copy, keys: ImageSigningKeys, options?): Promise<SocialImageMetadata>;
plate.handlerFrom(resolve, { signed?: SignedRouteOptions });
plate.fetchableFrom(resolve, { signed?: SignedRouteOptions });
type SignedRouteOptions = ImageSigningKeys & { status?: 403 | 404; url?: (...args) => string | URL };
```

The copy-bound `handler(copy)` and `fetchable(copy)` render fixed copy and
take no options: there is no request input to sign.
