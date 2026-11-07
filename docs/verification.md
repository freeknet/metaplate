# Verifying images

Checking generated files and deployed URLs for dimensions, format, structure, and platform rules.
## Verify generated files

`metaplate verify` reads dimensions from SVG roots and from PNG, JPEG, WebP,
and GIF container headers. It runs a structural/truncation check: raster chunk streams
are walked through image data to their terminator, while SVG roots must declare
safe, positive pixel dimensions (without XML entity expansion). Obvious header
shells, malformed roots, and partially written files fail even when their
dimension data survives. It is not a full raster decode — a file whose headers
are intact but whose payload cannot decode is outside its scope:

```sh
npx metaplate verify --size 1200x630 public/og.png
```

Files of different sizes can be checked in one invocation by repeating the
size group:

```sh
npx metaplate verify \
  --size 1200x630 public/og.png public/about.png \
  --size 512x512 public/icon-512.png
```

Mixed formats work in one invocation, since the format is detected per file,
and every target is checked even when earlier ones fail — the command reports
the full failing set and exits non-zero once:

```sh
npx metaplate verify --size 1200x630 public/og-image.jpg out/og-image.jpg --size 512x512 public/icon.webp
```

When a declared format must also hold — for example a `.jpg` file that must
really contain JPEG — pass `--format`:

```sh
npx metaplate verify --format jpeg --size 1200x630 out/og-image.jpg
```

### Directories and globs

An operand can be a directory or a glob as well as a file, and metaplate
expands it itself. Shell globbing is not needed, which matters because npm
runs scripts through `cmd.exe` on Windows, and `cmd.exe` expands nothing:

```sh
npx metaplate verify --require-content --size 1200x630 out/og
npx metaplate verify --size 1200x630 "out/og/*/og-image.jpg"
```

- A directory stands for every `.svg`, `.png`, `.jpg`, `.jpeg`, `.webp`, and
  `.gif` file below it. With `--format`, only that format's extensions count.
  A directory with no such file is an error.
- In a glob, `*` and `?` match within one path segment, `**` matches any
  number of directories, and `[abc]` and `{a,b}` work as in a shell. Hidden
  entries match only a segment that starts with a dot. A glob that matches
  nothing is an error. Quote globs so a POSIX shell passes them through
  unchanged.
- An operand that exists as a file is always that file, even when its name
  contains glob characters.
- A symbolic link to a file counts as a file. Links to directories are not
  followed, so a walk cannot loop.

Files are checked in sorted order, and a file named by several operands is
checked once. Each operand uses the `--size` and `--format` group it is in.

### Run the CLI from a script

`runCli` from `metaplate/cli` runs any `metaplate` command in-process. It
needs no shell and no child process, so it avoids hard-coding
`node_modules/metaplate/dist/cli.js` or Node's `DEP0190` warning for
`spawn(..., { shell: true })`. It resolves to the exit code:

```ts
import { runCli } from "metaplate/cli";

const code = await runCli(["verify", "--require-content", "--size", "1200x630", "out/og"]);
if (code !== 0) process.exit(code);
```

`args` are the arguments after `metaplate`. Output goes to `process.stdout`
and `process.stderr` unless `stdout` or `stderr` is given: anything with a
`write(text)` method. With `--json`, `stdout` receives the one JSON report:

```ts
let json = "";
await runCli(["verify", "--json", "--size", "1200x630", "out/og"], {
  stdout: { write: (text: string) => { json += text; } },
});
const report = JSON.parse(json);
```

`runCli` never touches `process.exitCode`, and calls running at the same
time keep their output and exit codes separate.

Or import `verifyImage` from `metaplate/image` in a test, which returns the
format it verified alongside the dimensions. `metaplate/png` remains available
for PNG-only checks.

For a single application/reporting contract, `verifySocialImage` from the root
entry checks the encoded bytes and the published descriptor together. Structural
image failures still throw; metadata disagreement and compatibility findings are
returned so CI can report them:

```ts
import { verifySocialImage } from "metaplate";

const report = verifySocialImage(bytes, metadata.openGraph.images[0], {
  targets: ["universal", "linkedin"],
  maxFileSize: 1_000_000,
});

if (!report.compatible) throw new Error(JSON.stringify(report.issues));
console.log(report.actual); // { width, height, format, contentType, byteLength }
```

Every descriptor field is optional. `width` and `height` must be supplied
together and are compared against the bytes; `type` is compared against the
detected format; `url` and `alt` are checked only when present.

A present `url` must be crawler-ready for most targets: absolute and HTTPS. A
plate's URLs are root-relative unless it sets `origin`, so the example above reports
`compatible: false` for a plate without one, even though Next would publish the
right URL through `metadataBase`. Set `origin` on the plate, make the descriptor's
URL absolute for the check, or leave `url` out; see
[Check bytes against the descriptor](testing.md#check-bytes-against-the-descriptor),
and the rest of [Testing your cards](testing.md) for where this check fits.

The CLI exposes the same checks for deployment pipelines:

```sh
npx metaplate verify --json --target linkedin --url https://example.com/og.png --alt "Project card" --max-file-size 1000000 --size 1200x630 out/og-image.png
```

`--json` prints one stable report per file, with `valid` (file-level
findings) separate from each target's `compatible`:

```json
{
  "schemaVersion": 1,
  "files": [
    {
      "file": "out/og-image.png",
      "valid": true,
      "image": { "format": "png", "width": 1200, "height": 630, "bytes": 48213 },
      "globalIssues": [],
      "targets": { "linkedin": { "compatible": true, "issues": [] } }
    }
  ]
}
```

Each issue has a `severity`, a `message`, and, for target findings, a `code`
(`url`, `format`, `dimensions`, `file-size`, or `contract`). A file that
cannot be read or parsed at all has `valid: false`, a single global issue
with the error's `message`, no `image`, and empty `targets`. `--target` is
repeatable.
`--max-file-size N` fails any file over `N` bytes and works without a target.
A target without `--url` or `--alt` verifies only image and platform facts and
does not invent metadata; those two flags are evaluated against targets only,
so they are rejected without at least one `--target`.

### Require visible content

Format, size, and structure checks accept a card whose every pixel is one
color: a title drawn off the canvas or in a font that never loaded leaves the
background behind, still a valid 1200x630 PNG. `--require-content` decodes a
PNG or JPEG and fails it when every pixel is the same color:

```sh
npx metaplate verify --require-content --size 1200x630 public/og.png
npx metaplate verify-url --require-content --size 1200x630 https://example.com/og.png
```

The failure reads `image is blank: every pixel is rgba(17, 17, 17, 1)`. Fully
transparent pixels count as one color whatever their RGB. The decoder handles
every PNG the [PNG specification](https://www.w3.org/TR/png-3/) allows
(grayscale, truecolor, and indexed, with or without alpha or `tRNS`, at every
bit depth, interlaced or not), inflates with `node:zlib` capped at the size the
header declares, and fails a file it cannot decode rather than passing it.

JPEG is decoded without a dependency too. Baseline, extended, and progressive
Huffman JPEGs are supported, with any chroma subsampling, restart markers,
grayscale, and Adobe CMYK. The check reads the DCT coefficients directly: a
JPEG is blank when every 8x8 block of every channel carries the same flat
value, which decodes to one color, so a card with any detail is never
failed. The reported color can differ by one from a decoder's output.
Lossless, hierarchical, and arithmetic-coded JPEGs fail as undecodable.

WebP and GIF are not decoded: with the flag, they fail with
`--require-content decodes PNG and JPEG only`. For those formats, use the
plate's `guards: { blank: "error" }`, which runs the same check on the pixels
as the card renders. Like the plate's `blank`
[render guard](rendering.md#render-guards), it catches a uniform image, not
a gradient or photograph whose text is missing.

### Compare against a baseline

Guards and checks say nothing is broken, not that nothing changed. Upgrading
Satori, Resvg, a font, or metaplate itself can move every card by a few pixels
with no code change: a headline renders slightly larger, letter spacing
shifts, a rotated element lands at a different angle. `--baseline` compares
each PNG or JPEG with the file at the same relative path in a baseline
directory:

```sh
# Record the current cards once, and commit or cache the directory.
npx metaplate verify --baseline og-baseline --update-baseline --size 1200x630 out/og

# After an upgrade: fail any card that changed, and write a picture of each change.
npx metaplate verify --baseline og-baseline --write-diff og-diff --size 1200x630 out/og
```

Files match by their path relative to their operand: a directory's files
relative to the directory, a glob's relative to the path before its first
wildcard, and a file by its name. So `out/og/home/og-image.jpg` matches
`og-baseline/home/og-image.jpg`. Every file runs the usual checks first, and
the comparison only after they pass.

A card fails when it changed, when it has no baseline, or when a baseline
file has no current card. Each changed card reports the share of pixels that
changed, such as
`differs from og-baseline/home/og-image.jpg: 3.21% of pixels changed by more than 16/255 (--max-diff 0%)`.

| Option | Effect |
| --- | --- |
| `--max-diff PCT` | Pass a card when at most `PCT` percent of its pixels changed, such as `--max-diff 0.5%`. The default, `0`, fails any change. |
| `--threshold N` | Count a pixel as changed when any channel moves more than `N` of 255. The default is `0` when both files are PNG, and `16` when either is a JPEG, so re-encoding noise is not a change. |
| `--write-diff DIR` | For each changed card, write `DIR/<path>.png`: the baseline, the current card, and the current card faded with every changed pixel in red, side by side. |
| `--update-baseline` | After review, rewrite the baseline from the current cards: add new ones, replace changed ones, and delete baseline files with no card. Nothing fails for a difference. |

Color is compared premultiplied by alpha, so two fully transparent pixels are
equal whatever their RGB. Cards of different sizes count as entirely
changed. With `--json`, each file's report has a `baseline` object with its
`status` (`unchanged`, `within`, `changed`, `missing-baseline`, `added`, or
`updated`), `changedPixels`, `changedRatio`, `meanDifference`,
`maxDifference`, `threshold`, and `diff` when one was written, and the report
lists baseline files with no card under `baseline.unmatched` (or
`baseline.removed` with `--update-baseline`).

Both formats decode without a dependency. JPEGs go through a full decode
(inverse DCT and chroma upsampling) that stays within a few levels of
libjpeg; both sides of a comparison use the same decoder, so that difference
never counts as a change. WebP and GIF are not decoded and fail the
comparison.

For tests, `compareImages(baseline, current, options)` from `metaplate/node`
is the same comparison on bytes. It takes `threshold` and `diffImage: true`,
and returns the counts above plus `diffImage`, the side-by-side PNG:

```ts
import { readFile } from "node:fs/promises";
import { compareImages } from "metaplate/node";

const result = compareImages(await readFile("og-baseline/home.png"), await og.render({ title: "Home" }));
expect(result.changedRatio).toBeLessThanOrEqual(0.005);
```

`decodeImagePixels(bytes)` returns a PNG or JPEG's pixels as 8-bit RGBA, and
`JPEG_COMPARE_THRESHOLD` is the JPEG default, `16`.

### Verify a deployed URL

`metaplate verify-url` fetches an image over http(s) and runs it through the
same checks as `verify`, so a deployment pipeline can confirm what a crawler
will actually receive:

```sh
npx metaplate verify-url --format png --size 1200x630 https://example.com/og.png
```

It takes the same `--json`, `--target`, `--alt`, `--max-file-size`, `--format`,
and repeatable `--size` groups as `verify`, with URLs in place of files.
`--target` checks evaluate the requested URL as it would be published. Beyond
the `verify` checks, the response `Content-Type` must name the format the bytes
really are. A success line reports the byte count and, after redirects, the
final URL; `--json` prints `{ "schemaVersion": 1, "urls": [...] }`, where each
entry carries the `verify` fields plus `url`, `finalUrl`, `redirects`,
`contentType`, and `bytes`. A fetch that fails has only `url`, `valid: false`,
empty `targets`, and one global issue whose `code` is the `RemoteImageError`
code below; a size or format mismatch in fetched bytes has a `message` but no
`code`.

Fetching a URL someone else controls from a CI runner is a server-side request
forgery risk, so the fetcher refuses by default anything that is not plainly a
public image:

- **Schemes and ports.** Only `http:` and `https:` on their default ports.
  `file:`, `data:`, `ftp:`, and every other scheme are refused, as is any other
  port unless it is allowed with `--allow-port PORT` (repeatable).
- **Credentials.** URLs with user information (`https://user:pass@host/`) are
  refused, and the password is never echoed into logs or reports. Requests
  carry no cookies or `Authorization` header, `Set-Cookie` is ignored, and the
  only headers sent are `Host`, `User-Agent: metaplate-verify/<version>`,
  `Accept: image/*`, and `Accept-Encoding: identity`. A server may compress
  anyway (an object stored with `Content-Encoding: gzip`, for example), and
  crawlers decode it, so a `gzip`, `deflate`, or `br` body is decoded before
  any check; any other coding fails the fetch.
- **Addresses.** The hostname is resolved once per hop, and the fetch is
  refused if *any* resolved address is loopback, private (10/8, 172.16/12,
  192.168/16), carrier-grade NAT, link-local (including 169.254.169.254 cloud
  metadata), unique-local, unspecified, multicast, reserved, documentation
  (192.0.2/24, 198.51.100/24, 203.0.113/24, 2001:db8::/32), benchmarking,
  discard-only, Teredo, local-use NAT64 (64:ff9b:1::/48), or any other block the
  IANA [IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/) and
  [IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/)
  special-purpose registries mark "Globally Reachable: False", or an
  IPv4-mapped, NAT64, or 6to4 form of one. The connection is then made to the checked
  address itself, with the original name in `Host` and TLS SNI, so a DNS answer
  that changes between check and connect cannot move the request.
- **Redirects.** At most `--max-redirects N` (0 to 20, default 3) are followed, and every
  hop gets the full scheme, credential, port, and address check again.
- **Limits.** The body is capped at `--max-bytes N` (default 16 MiB) while it
  streams, and the whole fetch, redirects included, must finish within
  `--timeout MS` (default 10000). Each connection, from connect to the last
  body byte, has that same budget, so raising `--timeout` also lets one slow
  connection use it. Only a `200` response is verified.

`--allow-private` lifts the address check so you can verify a local server
such as `http://127.0.0.1:3000`. It exists for local development only; do not
pass it in a pipeline that fetches URLs you do not control:

```sh
npx metaplate verify-url --allow-private --allow-port 3000 --size 1200x630 http://127.0.0.1:3000/og.png
```

The same fetcher is available from `metaplate/node` as `verifyRemoteImage` and
`fetchRemoteImage`. Failures throw `RemoteImageError` with a stable `code`:
`invalid-url`, `scheme`, `credentials`, `port`, `dns`, `address`, `redirect`,
`too-many-redirects`, `status` (with the HTTP `status`), `byte-limit`,
`timeout`, `network`, `content-type`, or, from `remoteImageLoader`'s origin
allowlist, `origin`:

```ts
import { RemoteImageError, verifyRemoteImage } from "metaplate/node";

try {
  const checked = await verifyRemoteImage(
    "https://example.com/og.png",
    { width: 1200, height: 630, format: "png" },
    { maxBytes: 5_000_000, timeoutMs: 5_000 },
  );
  console.log(checked.finalUrl, checked.byteLength, checked.image);
} catch (error) {
  if (error instanceof RemoteImageError) console.error(error.code, error.message);
  throw error;
}
```

Options mirror the CLI flags: `allowPrivate`, `allowedPorts`, `maxRedirects`,
`maxBytes`, `timeoutMs`, plus `connectionTimeoutMs` for the per-connection
ceiling and `resolve` to replace `dns.lookup` (its answers are still checked).

To audit a whole page rather than one image URL, `metaplate verify-page` reads
the page's social tags and verifies every image they name; see
[the page audit guide](verify-page.md).
