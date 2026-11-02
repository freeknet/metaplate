import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { releaseCommitSha } from "./run-script.mjs";
import {
  CLI_IMAGE_FIXTURES,
  FONTSOURCE_FONT_FIXTURE,
  FRAMEWORK_DEPENDENCIES,
  PACKAGE_FONT_FIXTURE,
  REQUIRED_RENDERER_PEERS,
  SERVER_FIXTURE,
  SOCIAL_CARD_FIXTURE,
  commonJsResolutionSmoke,
  esmImportSmoke,
  nextPeerGuidanceSmoke,
  packageEntrySpecifiers,
} from "./package-fixtures.mjs";
import { npmPackResult } from "./npm-pack-result.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), "metaplate-package-"));
const commitSha = releaseCommitSha();
const routeEvidence = { schemaVersion: 1, commitSha, routes: {} };
const consumer = join(temporary, "consumer");
const standalone = join(temporary, "standalone");
const bare = join(temporary, "bare");
const nextApp = join(temporary, "next-app");
const astroApp = join(temporary, "astro-app");
const astroServerApp = join(temporary, "astro-server-app");
const expressApp = join(temporary, "express-app");
const routerApp = join(temporary, "router-app");
const svelteApp = join(temporary, "svelte-app");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const packageEntries = packageEntrySpecifiers(manifest.exports);
const cardSize = Object.freeze({
  width: SOCIAL_CARD_FIXTURE.width,
  height: SOCIAL_CARD_FIXTURE.height,
});
const cardSizeSource = JSON.stringify(cardSize);
const packageFontSource = JSON.stringify(PACKAGE_FONT_FIXTURE);
const fontsourceFontSource = JSON.stringify(FONTSOURCE_FONT_FIXTURE);
const cardSizeArgument = `${cardSize.width}x${cardSize.height}`;
const iconSizeArgument = `${CLI_IMAGE_FIXTURES.iconWidth}x${CLI_IMAGE_FIXTURES.iconHeight}`;
const absoluteFixtureImage = new URL(
  SOCIAL_CARD_FIXTURE.imagePath,
  `${SOCIAL_CARD_FIXTURE.origin}/`,
).href;
const npmCli = process.env.npm_execpath;
// Node 20+ provides the WHATWG fetch globals the server fixtures use.
const { AbortSignal, fetch } = globalThis;
// One Satori-compatible plate component shared by the generated fixtures.
const plateComponentSource = `(copy: { title: string }) => ({
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        background: "#111827",
        color: "#ffffff",
        fontFamily: "Inter",
        fontSize: 64,
      },
      children: copy.title,
    },
  })`;
const astroPlateSource = `import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

export const og = createNodeOg({
  alt: (copy: { title: string }) => \`${"${copy.title}"} social card\`,
  fonts: fontsourceFontLoader([${fontsourceFontSource}]),
  imagePath: ${JSON.stringify(SOCIAL_CARD_FIXTURE.imagePath)},
  origin: ${JSON.stringify(SOCIAL_CARD_FIXTURE.origin)},
  component: ${plateComponentSource},
});
`;
// `verifyImage` from the installed tarball, loaded once the consumer exists.
let verifyPackedImage;

if (!npmCli) {
  throw new Error("Run package verification through `npm run check:package`.");
}

function run(args, options = {}) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
}

function install(directory, specifiers, { offline = true } = {}) {
  run(
    [
      "install",
      ...specifiers,
      "--prefix",
      directory,
      "--ignore-scripts",
      ...(offline ? ["--offline"] : []),
      "--no-audit",
      "--no-fund",
    ],
    { cwd: temporary },
  );
}

function runModule(source, cwd) {
  execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd,
    stdio: "inherit",
  });
}

/** Finds an exported file without assuming a Next version's output layout. */
function findExportedFile(directory, name) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      const nested = findExportedFile(path, name);
      if (nested) return nested;
    } else if (entry === name) {
      return path;
    }
  }
  return undefined;
}

/** Resolves and verifies one installed dependency against package-lock.json. */
function lockedDependency(name) {
  const entry = lockfile.packages[`node_modules/${name}`];
  if (!entry?.version) throw new Error(`No locked version available for ${name}.`);
  const source = join(root, "node_modules", ...name.split("/"));
  const installed = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (installed.version !== entry.version) {
    throw new Error(
      `${name} installation ${installed.version} does not match lockfile ${entry.version}.`,
    );
  }
  return { source, installed };
}

function dependencyDestination(directory, name) {
  const destination = join(directory, "node_modules", ...name.split("/"));
  mkdirSync(resolve(destination, ".."), { recursive: true });
  return destination;
}

/** Links exactly the dependency tree npm ci verified from package-lock.json. */
function linkLockedDependency(directory, name) {
  const { source } = lockedDependency(name);
  const destination = dependencyDestination(directory, name);
  symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
}

/**
 * Turbopack requires `next` itself to physically live beneath its workspace,
 * unlike ordinary Node resolution where a junction is sufficient. Copy the
 * lockfile-verified package into the temporary workspace.
 */
function copyLockedDependency(directory, name) {
  const { source } = lockedDependency(name);
  const destination = dependencyDestination(directory, name);
  cpSync(source, destination, { recursive: true });
}

/**
 * Copies an installed, lockfile-verified runtime dependency closure offline.
 * Optional dependencies are followed only when npm installed them here, which
 * is how platform binaries (Next's SWC, sharp's libvips) arrive: npm can keep
 * several candidates, such as glibc and musl builds on Linux, and the package
 * selects the one for the current runtime.
 */
function copyLockedDependencyTree(directory, name, copied = new Set()) {
  if (copied.has(name)) return copied;
  copyLockedDependency(directory, name);
  copied.add(name);

  const { installed } = lockedDependency(name);
  const installedOptional = Object.keys(installed.optionalDependencies ?? {}).filter(
    (dependency) => existsSync(join(root, "node_modules", ...dependency.split("/"))),
  );
  for (const dependency of [...Object.keys(installed.dependencies ?? {}), ...installedOptional]) {
    copyLockedDependencyTree(directory, dependency, copied);
  }
  return copied;
}

/** Runs a framework's production build and surfaces its output on failure. */
function buildFixture(label, cli, cwd, env) {
  try {
    execFileSync(process.execPath, [cli, "build"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
  } catch (error) {
    const details = error instanceof Error && "stderr" in error
      ? `${error.stdout ?? ""}${error.stderr ?? ""}`
      : error;
    throw new Error(`${label} failed: ${details}`, { cause: error });
  }
}

/** Writes an Astro app around the shared plate from the packed artifact. */
function writeAstroApp(directory, archive, dependencies, { config, pages }) {
  install(directory, [archive]);
  for (const dependency of dependencies) {
    linkLockedDependency(directory, dependency);
  }
  mkdirSync(join(directory, "src", "lib"), { recursive: true });
  writeFileSync(join(directory, "astro.config.mjs"), config);
  writeFileSync(join(directory, "src", "lib", "og.ts"), astroPlateSource);
  for (const [page, source] of Object.entries(pages)) {
    const file = join(directory, "src", "pages", page);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return join(directory, "node_modules", "astro", "bin", "astro.mjs");
}

/** An Astro page emitting the social tags `socialImageMetadata` derives for a route. */
function astroSocialPage(routeExpression, body) {
  return `---
import { socialImageMetadata } from "metaplate";
const social = socialImageMetadata(${routeExpression}, "Metaplate Astro smoke card", {
  origin: ${JSON.stringify(SOCIAL_CARD_FIXTURE.origin)},
  imagePath: ${JSON.stringify(SOCIAL_CARD_FIXTURE.imagePath)},
  type: ${JSON.stringify(SOCIAL_CARD_FIXTURE.contentType)},
});
const image = social.openGraph.images[0];
---
<html><head>
  <meta property="og:image" content={image.url} />
  <meta property="og:image:width" content={String(image.width)} />
  <meta property="og:image:height" content={String(image.height)} />
  <meta property="og:image:type" content={image.type} />
  <meta property="og:image:alt" content={image.alt} />
  <meta name="twitter:card" content={social.twitter.card} />
  <meta name="twitter:image" content={social.twitter.images[0].url} />
</head><body>${body}</body></html>
`;
}

/** Reserves a free loopback port for server CLIs that reject port 0. */
async function freePort() {
  const server = createServer();
  await new Promise((listening, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", listening);
  });
  const { port } = server.address();
  await new Promise((closed) => server.close(closed));
  return port;
}

/**
 * Stops a production server and every process it spawned. Windows has no
 * process groups, so `taskkill /T` walks the tree; on POSIX the server was
 * started as its own process-group leader and the whole group is signalled.
 */
async function stopProcessTree(child, exited) {
  const signalTree = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group exited between the check and the signal.
    }
  };
  const settled = (milliseconds) =>
    Promise.race([exited, delay(milliseconds, "timeout", { ref: false })]);

  signalTree("SIGTERM");
  if ((await settled(10_000)) !== "timeout") return;
  signalTree("SIGKILL");
  if ((await settled(5_000)) === "timeout") {
    throw new Error(`Production server process ${child.pid} did not exit.`);
  }
}

/** Polls until the server answers any HTTP response, or fails fast if it exits. */
async function waitForServer(url, exited, timeoutMilliseconds = 90_000) {
  let exit;
  void exited.then((result) => {
    exit = result;
  });
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (exit) {
      throw new Error(`Server exited before it was ready (code ${exit.code}, signal ${exit.signal}).`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      await response.arrayBuffer();
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Server did not answer ${url} within ${timeoutMilliseconds} ms.`);
}

/**
 * Starts a built framework's production server on a free loopback port,
 * waits until it answers, runs `verify(base)` against it, and always stops
 * the whole process tree, including when the build output fails verification.
 */
async function withProductionServer({ label, cwd, readyPath, start }, verify) {
  const port = await freePort();
  const { args, env } = start(port);
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let output = "";
  const capture = (chunk) => {
    output += chunk;
  };
  child.stdout.setEncoding("utf8").on("data", capture);
  child.stderr.setEncoding("utf8").on("data", capture);
  const exited = new Promise((stopped) => {
    child.once("exit", (code, signal) => stopped({ code, signal }));
    child.once("error", (error) => stopped({ code: null, signal: String(error) }));
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(`${base}${readyPath}`, exited);
    return await verify(base);
  } catch (error) {
    throw new Error(`${label} production server verification failed: ${error.message}\n${output}`, {
      cause: error,
    });
  } finally {
    await stopProcessTree(child, exited);
  }
}

/** Reads one rendered `<meta>` tag by property or name. */
function metaContent(html, key) {
  const match = new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html);
  if (!match) throw new Error(`Page did not emit ${key} metadata.`);
  return match[1].replaceAll("&amp;", "&");
}

/**
 * Fetches each fixture slug's page and checks that its Open Graph and X image
 * tags are absolute fixture-origin URLs at the expected per-slug paths.
 */
async function verifySocialPages(base, expected) {
  const pages = [];
  for (const slug of SERVER_FIXTURE.slugs) {
    const response = await fetch(`${base}/${slug}`);
    if (!response.ok) throw new Error(`/${slug} returned ${response.status}.`);
    const html = await response.text();
    const { ogImagePath, ogImageType, twitterImagePath } = expected(slug);
    const ogImage = new URL(metaContent(html, "og:image"));
    const twitterImage = new URL(metaContent(html, "twitter:image"));
    for (const [tag, url, path] of [
      ["og:image", ogImage, ogImagePath],
      ["twitter:image", twitterImage, twitterImagePath],
    ]) {
      if (url.origin !== SOCIAL_CARD_FIXTURE.origin || url.pathname !== path) {
        throw new Error(`/${slug} advertised ${tag} ${url.href}; expected ${SOCIAL_CARD_FIXTURE.origin}${path}.`);
      }
    }
    if (
      metaContent(html, "og:image:type") !== ogImageType ||
      metaContent(html, "og:image:width") !== String(cardSize.width) ||
      metaContent(html, "og:image:height") !== String(cardSize.height)
    ) {
      throw new Error(`/${slug} advertised the wrong og:image type or dimensions.`);
    }
    pages.push({ ogImage, twitterImage });
  }
  return pages;
}

/**
 * Fetches a dynamic image route for each slug and verifies status, media type,
 * length, cache policy, format, and dimensions with the packed `verifyImage`.
 * Identical bytes for different slugs would mean the route never resolved
 * its copy from the request.
 */
async function verifyDynamicImageRoute(base, paths, { contentType, format, cacheControl }) {
  const results = [];
  for (const path of paths) {
    const response = await fetch(`${base}${path}`);
    if (!response.ok) throw new Error(`${path} returned ${response.status}.`);
    const servedType = response.headers.get("content-type");
    if (servedType !== contentType) {
      throw new Error(`${path} returned content type ${servedType}; expected ${contentType}.`);
    }
    if (cacheControl && response.headers.get("cache-control") !== cacheControl) {
      throw new Error(`${path} returned cache policy ${response.headers.get("cache-control")}.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) !== bytes.byteLength) {
      throw new Error(`${path} declared ${contentLength} bytes but sent ${bytes.byteLength}.`);
    }
    const image = verifyPackedImage(bytes, cardSize, format);
    results.push({ path, response, bytes, image });
  }
  const [first, second] = results;
  if (Buffer.from(first.bytes).equals(Buffer.from(second.bytes))) {
    throw new Error(`${second.path} rendered the same bytes as ${first.path}; the route did not resolve its copy per request.`);
  }
  return {
    imageVerification: {
      verified: true,
      format: first.image.format,
      width: first.image.width,
      height: first.image.height,
      byteLength: first.bytes.byteLength,
    },
    responseVerification: {
      verified: true,
      paths,
      contentType: first.response.headers.get("content-type"),
      cacheControl: first.response.headers.get("cache-control"),
      contentLength: first.response.headers.get("content-length"),
      queryOrPathResolved: true,
      distinctSlugByteLengths: results.map(({ bytes }) => bytes.byteLength),
    },
  };
}

try {
  const packed = npmPackResult(run(["pack", "--json", "--pack-destination", temporary]));
  const archive = join(temporary, packed.filename);
  const paths = new Set(packed.files.map((file) => file.path));

  if (!paths.has(manifest.bin.metaplate.replace(/^\.\//, ""))) {
    throw new Error(`Package is missing its CLI entry: ${manifest.bin.metaplate}`);
  }

  for (const [entry, target] of Object.entries(manifest.exports)) {
    for (const kind of ["types", "import", "default"]) {
      const path = target[kind].replace(/^\.\//, "");
      if (!paths.has(path)) {
        throw new Error(`Package export ${entry} is missing its ${kind} file: ${path}`);
      }
    }
  }

  writeFileSync(
    join(temporary, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );

  // One package install must provide the complete framework-neutral renderer
  // stack. Next stays optional because only Next applications need it.
  // This is intentionally the verifier's one online install: it proves npm's
  // normal peer auto-install behavior from exactly the tarball users receive.
  // It also primes npm's cache so every framework fixture below stays offline.
  install(consumer, [archive], { offline: false });

  for (const peer of REQUIRED_RENDERER_PEERS) {
    const peerDirectory = join(consumer, "node_modules", ...peer.split("/"));
    if (!existsSync(peerDirectory)) {
      throw new Error(`The one-command install did not provide required peer ${peer}.`);
    }
    const installed = JSON.parse(
      readFileSync(join(peerDirectory, "package.json"), "utf8"),
    );
    const locked = lockfile.packages[`node_modules/${peer}`];
    if (installed.version !== locked?.version) {
      throw new Error(
        `The one-command install selected ${peer} ${installed.version}; expected audited ${locked?.version}.`,
      );
    }
  }
  if (existsSync(join(consumer, "node_modules", "next"))) {
    throw new Error("The one-command install pulled optional framework peer next.");
  }

  ({ verifyImage: verifyPackedImage } = await import(
    pathToFileURL(join(consumer, "node_modules", manifest.name, manifest.exports["./image"].import)).href
  ));
  runModule(esmImportSmoke(packageEntries), consumer);
  runModule(nextPeerGuidanceSmoke(), consumer);

  const portableFontEntry = join(
    consumer,
    "node_modules",
    manifest.name,
    manifest.exports["./font-data"].import,
  );
  const portableFontSource = readFileSync(portableFontEntry, "utf8");
  if (/\bnode:/.test(portableFontSource)) {
    throw new Error("metaplate/font-data unexpectedly imports a Node built-in.");
  }
  runModule(
    `
      const { fontLoader } = await import(${JSON.stringify(`${manifest.name}/font-data`)});
      let calls = 0;
      const fonts = fontLoader([{
        name: "Portable",
        weight: 400,
        data: () => { calls += 1; return Uint8Array.of(0x77, 0x4f, 0x46, 0x46, 1, 2, 3); },
      }]);
      const first = await fonts();
      const second = await fonts();
      if (first !== second || calls !== 1 || first[0].data.byteLength !== 7) {
        throw new Error("The portable font loader did not normalize and memoize bytes.");
      }
    `,
    consumer,
  );
  // metaplate/emoji is the runtime-neutral half of emoji rendering, so it is
  // held to the same no-Node-built-ins rule as metaplate/font-data.
  const portableEmojiSource = readFileSync(
    join(consumer, "node_modules", manifest.name, manifest.exports["./emoji"].import),
    "utf8",
  );
  if (/\bnode:/.test(portableEmojiSource)) {
    throw new Error("metaplate/emoji unexpectedly imports a Node built-in.");
  }
  runModule(
    `
      const { emojiLoader, twemojiName } = await import(${JSON.stringify(`${manifest.name}/emoji`)});
      let calls = 0;
      const emoji = emojiLoader(({ grapheme }) => {
        calls += 1;
        return twemojiName(grapheme) === "1f44b-1f3fd" ? '<svg xmlns="http://www.w3.org/2000/svg"/>' : undefined;
      });
      const first = await emoji("👋🏽");
      const second = await emoji("👋🏽");
      if (first !== second || calls !== 1 || !first.startsWith("data:image/svg+xml;base64,")) {
        throw new Error("The portable emoji loader did not encode and memoize an image.");
      }
    `,
    consumer,
  );
  // metaplate/image embeds image bytes for edge plates too, so imageAsset is
  // held to the same no-Node-built-ins rule; metaplate/assets is its Node
  // reader and must work without loading a renderer peer.
  const portableImageSource = readFileSync(
    join(consumer, "node_modules", manifest.name, manifest.exports["./image"].import),
    "utf8",
  );
  if (/\bnode:/.test(portableImageSource)) {
    throw new Error("metaplate/image unexpectedly imports a Node built-in.");
  }
  writeFileSync(
    join(consumer, "logo.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20"/></svg>',
  );
  runModule(
    `
      const { imageAsset, imageAssetLoader } = await import(${JSON.stringify(`${manifest.name}/image`)});
      const { fileImageLoader, remoteImageLoader } = await import(${JSON.stringify(`${manifest.name}/assets`)});
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4"/>');
      const asset = imageAsset(svg);
      if (asset.width !== 8 || asset.height !== 4 || !asset.src.startsWith("data:image/svg+xml;base64,")) {
        throw new Error("The portable imageAsset did not embed an SVG.");
      }
      let calls = 0;
      const memoized = imageAssetLoader(() => { calls += 1; return svg; });
      if ((await memoized()) !== (await memoized()) || calls !== 1) {
        throw new Error("The portable image asset loader did not memoize.");
      }
      const logo = fileImageLoader("logo.svg");
      const read = await logo();
      if (read !== (await logo()) || read.width !== 40 || read.height !== 20) {
        throw new Error("metaplate/assets did not read and memoize a project image.");
      }
      try {
        remoteImageLoader({ origins: [] });
        throw new Error("remoteImageLoader accepted an empty origins allowlist.");
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    `,
    consumer,
  );
  (await import("./package-fixtures-edge.mjs")).verifyEdgeFixture({ archive, consumer, temporary, manifest, lockfile, install, runModule, linkLockedDependency });

  // The Next adapter must work in an actual static export, not merely in a
  // mocked response or a plain Node process (which cannot resolve Next's
  // extensionless `next/og` module). Install only the packed tarball, then
  // copy the exact local runtime closure `npm ci` already verified from the
  // lockfile. Turbopack deliberately does not follow dependencies linked
  // outside its workspace root.
  install(nextApp, [archive]);
  const copiedNextPackages = new Set();
  for (const dependency of FRAMEWORK_DEPENDENCIES.next) {
    copyLockedDependencyTree(nextApp, dependency, copiedNextPackages);
  }
  // The closure follows Next's installed optional dependencies, so every
  // installed SWC candidate arrives with it; Next selects the binary for the
  // current runtime rather than the verifier assuming exactly one.
  if (![...copiedNextPackages].some((dependency) => dependency.startsWith("@next/swc-"))) {
    throw new Error(
      "Expected at least one locally installed Next SWC package, found none.",
    );
  }

  mkdirSync(join(nextApp, "app"));
  writeFileSync(join(nextApp, "next.config.mjs"), "export default { output: 'export' };\n");
  writeFileSync(
    join(nextApp, "app", "layout.js"),
    `import { createElement as h } from "react";
export default function Layout({ children }) {
  return h("html", null, h("body", null, children));
}
`,
  );
  writeFileSync(
    join(nextApp, "app", "page.js"),
    `import { createElement as h } from "react";
export default function Page() {
  return h("main", null, "Metaplate packed-package Next smoke");
}
`,
  );
  writeFileSync(
    join(nextApp, "app", "opengraph-image.js"),
    `import { createElement as h } from "react";
import { createNextOg } from "metaplate/next";

const copy = { title: "Metaplate package smoke", alt: "Metaplate package smoke card" };
const og = createNextOg({
  component: (value) => h(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        background: "#111827",
        color: "#ffffff",
        fontSize: 64,
      },
    },
    value.title,
  ),
  alt: (value) => value.alt,
});

export const dynamic = "force-static";
export const size = og.size;
export const contentType = og.contentType;
export default function Image() {
  return og.render(copy);
}
`,
  );

  const nextCli = join(nextApp, "node_modules", "next", "dist", "bin", "next");
  buildFixture("Packed-package Next static export", nextCli, nextApp, {
    NEXT_TELEMETRY_DISABLED: "1",
  });

  const exportedImage = findExportedFile(join(nextApp, "out"), "opengraph-image");
  if (!exportedImage) {
    throw new Error("Next static export did not emit the Open Graph image artifact.");
  }
  const exportedIndex = readFileSync(join(nextApp, "out", "index.html"), "utf8");
  if (!exportedIndex.includes("opengraph-image")) {
    throw new Error("Next static export did not emit Open Graph image metadata.");
  }
  runModule(
    `
      import { readFile } from "node:fs/promises";
      import { verifyImage } from "metaplate/image";
      const result = verifyImage(
        await readFile(${JSON.stringify(exportedImage)}),
        ${cardSizeSource},
        "png",
      );
      if (result.format !== "png" || result.width !== ${cardSize.width} || result.height !== ${cardSize.height}) {
        throw new Error("Next static export image dimensions or content type were incorrect.");
      }
    `,
    nextApp,
  );

  // Next's default server output is a separate production path from the
  // static export above: the metadata image route and route handlers render
  // per request under `next start`. Reuse the copied closure (Turbopack needs
  // `next` physically inside its workspace, and the copy is the slowest step)
  // once the export's artifacts are verified, and configure the server app
  // exactly as the README's "JPEG or WebP cards in Next.js" section does.
  // sharp, the README's JPEG encoder, is one of Next's optional dependencies.
  if (!copiedNextPackages.has("sharp")) {
    throw new Error("Next's optional sharp dependency is not installed; the JPEG route encodes with it.");
  }
  for (const staticOutput of ["app", "out", ".next", "next.config.mjs"]) {
    rmSync(join(nextApp, staticOutput), { recursive: true, force: true });
  }
  for (const dependency of FRAMEWORK_DEPENDENCIES.nextServer) {
    linkLockedDependency(nextApp, dependency);
  }
  const jpegImagePath = SERVER_FIXTURE.jpegImagePath;
  mkdirSync(join(nextApp, "app", "[slug]", jpegImagePath), { recursive: true });
  mkdirSync(join(nextApp, "lib"));
  writeFileSync(
    join(nextApp, "next.config.ts"),
    `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@resvg/resvg-js", "satori"],
};

export default nextConfig;
`,
  );
  writeFileSync(
    join(nextApp, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["dom", "dom.iterable", "esnext"],
        strict: true,
        noEmit: true,
        module: "esnext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        isolatedModules: true,
        esModuleInterop: true,
        skipLibCheck: true,
        plugins: [{ name: "next" }],
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
      exclude: ["node_modules"],
    }),
  );
  writeFileSync(
    join(nextApp, "lib", "og.ts"),
    `import sharp from "sharp";
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

export const jpegOg = createNodeOg({
  alt: (copy: { title: string }) => \`${"${copy.title}"} social card\`,
  fonts: fontsourceFontLoader([${fontsourceFontSource}]),
  imagePath: ${JSON.stringify(jpegImagePath)},
  origin: ${JSON.stringify(SOCIAL_CARD_FIXTURE.origin)},
  headers: { "Cache-Control": ${JSON.stringify(SERVER_FIXTURE.cacheControl)} },
  output: {
    format: "jpeg",
    encode: ({ pixels, width, height }) =>
      sharp(pixels, { raw: { width, height, channels: 4 } }).jpeg({ quality: 80 }).toBuffer(),
  },
  component: ${plateComponentSource},
});
`,
  );
  writeFileSync(
    join(nextApp, "app", "layout.tsx"),
    `import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { metadataBase: new URL(${JSON.stringify(SOCIAL_CARD_FIXTURE.origin)}) };

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
  );
  // The page imports the metaplate/node plate only for metadata, which the
  // README warns still makes the bundler trace the renderer peers.
  writeFileSync(
    join(nextApp, "app", "[slug]", "page.tsx"),
    `import type { Metadata } from "next";
import { jpegOg } from "../../lib/og";

type Props = { params: Promise<{ slug: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: slug, twitter: jpegOg.metadata(\`/${"${slug}"}\`, { title: slug }).twitter };
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  return <main>Metaplate Next server fixture: {slug}</main>;
}
`,
  );
  writeFileSync(
    join(nextApp, "app", "[slug]", "opengraph-image.tsx"),
    `import { createNextOg } from "metaplate/next";

const og = createNextOg({
  component: (copy: { title: string }) => (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", background: "#111827", color: "#ffffff", fontSize: 64 }}>
      {copy.title}
    </div>
  ),
  alt: (copy) => \`${"${copy.title}"} metadata card\`,
});

export const dynamic = "force-dynamic";
export const size = og.size;
export const contentType = og.contentType;

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return og.render({ title: slug.slice(0, 80) });
}
`,
  );
  writeFileSync(
    join(nextApp, "app", "[slug]", jpegImagePath, "route.ts"),
    `import { jpegOg } from "../../../lib/og";

type Context = { params: Promise<{ slug: string }> };

export const dynamic = "force-dynamic";
export const GET = jpegOg.handlerFrom(async (_request: Request, { params }: Context) => ({
  title: (await params).slug.slice(0, 80),
}));
`,
  );
  buildFixture("Packed-package Next server build", nextCli, nextApp, {
    NEXT_TELEMETRY_DISABLED: "1",
  });
  routeEvidence.routes["next-server"] = await withProductionServer(
    {
      label: "Next",
      cwd: nextApp,
      readyPath: `/${SERVER_FIXTURE.slugs[0]}`,
      start: (port) => ({
        args: [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(port)],
        env: { NEXT_TELEMETRY_DISABLED: "1" },
      }),
    },
    async (base) => {
      const pages = await verifySocialPages(base, (slug) => ({
        ogImagePath: `/${slug}/opengraph-image`,
        ogImageType: "image/png",
        twitterImagePath: `/${slug}/${jpegImagePath}`,
      }));
      // Next appends a cache-busting query to metadata image URLs; fetch the
      // exact advertised URL rather than reconstructing it.
      const metadataFile = await verifyDynamicImageRoute(
        base,
        pages.map(({ ogImage }) => `${ogImage.pathname}${ogImage.search}`),
        { contentType: "image/png", format: "png" },
      );
      const routeHandler = await verifyDynamicImageRoute(
        base,
        pages.map(({ twitterImage }) => twitterImage.pathname),
        { contentType: "image/jpeg", format: "jpeg", cacheControl: SERVER_FIXTURE.cacheControl },
      );
      return {
        packedArtifact: true,
        productionBuild: true,
        servedOutput: true,
        imageVerification: {
          verified: true,
          metadataFile: metadataFile.imageVerification,
          routeHandler: routeHandler.imageVerification,
        },
        responseVerification: {
          verified: true,
          metadataFile: metadataFile.responseVerification,
          routeHandler: routeHandler.responseVerification,
        },
      };
    },
  );

  // Build an actual Astro static site from the packed artifact. This proves
  // the APIRoute handler contract, production bundling of the optional native
  // renderer boundary, emitted image path, bytes, dimensions, and page tags.
  const astroCli = writeAstroApp(astroApp, archive, FRAMEWORK_DEPENDENCIES.astro, {
    config: "export default {};\n",
    pages: {
      [`${SOCIAL_CARD_FIXTURE.imagePath}.ts`]: `import type { APIRoute } from "astro";
import { og } from "../lib/og";

export const prerender = true;
export const GET = og.handler({ title: "Metaplate Astro smoke" }) satisfies APIRoute;
`,
      "index.astro": astroSocialPage(JSON.stringify("/"), "Metaplate Astro fixture"),
    },
  });
  buildFixture("Packed-package Astro static build", astroCli, astroApp, {
    ASTRO_TELEMETRY_DISABLED: "1",
  });
  const astroImage = join(astroApp, "dist", SOCIAL_CARD_FIXTURE.imagePath);
  const astroIndex = readFileSync(join(astroApp, "dist", "index.html"), "utf8");
  if (
    !astroIndex.includes(`content="${absoluteFixtureImage}"`) ||
    !astroIndex.includes(`content="${cardSize.width}"`) ||
    !astroIndex.includes(`content="${cardSize.height}"`) ||
    !astroIndex.includes(`content="${SOCIAL_CARD_FIXTURE.contentType}"`)
  ) {
    throw new Error("Astro static build did not emit the expected absolute social metadata.");
  }
  verifyPackedImage(readFileSync(astroImage), cardSize, "png");

  // Serve the same plate on demand through Astro's official Node adapter in
  // standalone mode: a dynamic `[slug]` endpoint whose GET is `handlerFrom`,
  // and a server-rendered page emitting its social tags, from the built
  // `dist/server/entry.mjs` rather than the dev server.
  const astroServerCli = writeAstroApp(astroServerApp, archive, FRAMEWORK_DEPENDENCIES.astroServer, {
    config: `import node from "@astrojs/node";

export default { output: "server", adapter: node({ mode: "standalone" }) };
`,
    pages: {
      [`[slug]/${SOCIAL_CARD_FIXTURE.imagePath}.ts`]: `import type { APIContext, APIRoute } from "astro";
import { og } from "../../lib/og";

export const GET = og.handlerFrom(({ params }: APIContext) => ({
  title: (params.slug ?? "missing").slice(0, 80),
})) satisfies APIRoute;
`,
      "[slug]/index.astro": astroSocialPage("`/${Astro.params.slug}`", "Metaplate Astro server fixture"),
    },
  });
  buildFixture("Packed-package Astro server build", astroServerCli, astroServerApp, {
    ASTRO_TELEMETRY_DISABLED: "1",
  });
  routeEvidence.routes["astro-server"] = await withProductionServer(
    {
      label: "Astro",
      cwd: astroServerApp,
      readyPath: `/${SERVER_FIXTURE.slugs[0]}`,
      start: (port) => ({
        args: [join(astroServerApp, "dist", "server", "entry.mjs")],
        env: { HOST: "127.0.0.1", PORT: String(port), ASTRO_TELEMETRY_DISABLED: "1" },
      }),
    },
    async (base) => {
      const pages = await verifySocialPages(base, (slug) => ({
        ogImagePath: `/${slug}/${SOCIAL_CARD_FIXTURE.imagePath}`,
        ogImageType: SOCIAL_CARD_FIXTURE.contentType,
        twitterImagePath: `/${slug}/${SOCIAL_CARD_FIXTURE.imagePath}`,
      }));
      const endpoint = await verifyDynamicImageRoute(
        base,
        pages.map(({ ogImage }) => ogImage.pathname),
        { contentType: SOCIAL_CARD_FIXTURE.contentType, format: "png" },
      );
      return { packedArtifact: true, productionBuild: true, servedOutput: true, ...endpoint };
    },
  );

  // Exercise the documented raw-byte bridge through a real Express 5 server,
  // including its async error boundary and externally observed headers.
  install(expressApp, [archive]);
  for (const dependency of FRAMEWORK_DEPENDENCIES.express) {
    linkLockedDependency(expressApp, dependency);
  }
  runModule(
    `
      import express from "express";
      import { writeFileSync } from "node:fs";
      import { fontsourceFontLoader } from "metaplate/fonts";
      import { verifyImage } from "metaplate/image";
      import { createNodeOg } from "metaplate/node";

      const routeEvidence = { schemaVersion: 1, commitSha: ${JSON.stringify(commitSha)}, routes: {} };
      const og = createNodeOg({
        alt: () => "Express smoke card",
        fonts: fontsourceFontLoader([${fontsourceFontSource}]),
        component: () => ({
          type: "div",
          props: {
            style: {
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              background: "#111827",
              color: "#ffffff",
              fontFamily: "Inter",
              fontSize: 64,
            },
            children: "Metaplate Express smoke",
          },
        }),
      });
      const app = express();
      app.get(${JSON.stringify(`/${SOCIAL_CARD_FIXTURE.imagePath}`)}, async (_request, response, next) => {
        try {
          response.type(og.contentType);
          response.set("Cache-Control", "public, max-age=86400");
          response.send(Buffer.from(await og.render({})));
        } catch (error) {
          next(error);
        }
      });
      const server = await new Promise((resolve) => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Express did not bind TCP.");
        const response = await fetch(\`http://127.0.0.1:\${address.port}/${SOCIAL_CARD_FIXTURE.imagePath}\`);
        if (!response.ok) throw new Error(\`Express returned \${response.status}.\`);
        if (response.headers.get("content-type") !== ${JSON.stringify(SOCIAL_CARD_FIXTURE.contentType)}) {
          throw new Error("Express returned the wrong image content type.");
        }
        if (response.headers.get("cache-control") !== "public, max-age=86400") {
          throw new Error("Express returned the wrong cache policy.");
        }
        const imageBytes = new Uint8Array(await response.arrayBuffer());
        const image = verifyImage(imageBytes, ${cardSizeSource}, "png");
        routeEvidence.routes["node-service"] = {
          packedArtifact: true,
          servedOutput: true,
          imageVerification: { verified: true, format: image.format, width: image.width, height: image.height, byteLength: imageBytes.byteLength },
          responseVerification: { verified: true, contentType: response.headers.get("content-type"), cacheControl: response.headers.get("cache-control") },
        };
      } finally {
        await new Promise((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()),
        );
      }
      writeFileSync(${JSON.stringify(join(expressApp, "node-route-evidence.json"))}, JSON.stringify(routeEvidence));
    `,
    expressApp,
  );
  Object.assign(routeEvidence.routes, JSON.parse(readFileSync(join(expressApp, "node-route-evidence.json"), "utf8")).routes);

  // Exercise provider-shaped Web Standard handlers from the exact packed
  // artifact. These fixtures intentionally model provider contracts without
  // importing provider SDKs: Vercel's Node function shape is a GET export over
  // Request/Response, while Netlify supplies named path params in context.
  runModule(
    `
      import http from "node:http";
      import { fontsourceFontLoader } from "metaplate/fonts";
      import { verifyImage } from "metaplate/image";
      import { createNodeOg } from "metaplate/node";
      import { writeFileSync } from "node:fs";

      const routeEvidence = { schemaVersion: 1, commitSha: ${JSON.stringify(commitSha)}, routes: {} };
      const og = createNodeOg({
        alt: (copy) => \`${"${copy.title}"} deployment card\`,
        fonts: fontsourceFontLoader([${fontsourceFontSource}]),
        headers: { "Cache-Control": "public, max-age=86400" },
        component: (copy) => ({
          type: "div",
          props: {
            style: {
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              background: "#111827",
              color: "#ffffff",
              fontFamily: "Inter",
              fontSize: 64,
            },
            children: copy.title,
          },
        }),
      });

      const vercelGet = og.handlerFrom((request) => {
        const slug = new URL(request.url).searchParams.get("slug")?.slice(0, 80) || "home";
        return { title: slug };
      });
      const vercelFetchable = og.fetchableFrom((request) => {
        const slug = new URL(request.url).searchParams.get("slug")?.slice(0, 80) || "home";
        return { title: slug };
      });
      const netlifyFunction = og.handlerFrom((_request, { params }) => ({
        title: (params.slug ?? "home").slice(0, 80),
      }));
      const netlifyConfig = { path: "/netlify/:slug", method: "GET" };
      if (netlifyConfig.path !== "/netlify/:slug" || netlifyConfig.method !== "GET") {
        throw new Error("Netlify fixture config did not preserve its custom route contract.");
      }

      const server = http.createServer(async (request, response) => {
        try {
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          let result;
          if (url.pathname === "/vercel-fetchable") {
            result = await vercelFetchable.fetch(new Request(url));
          } else if (url.pathname.startsWith("/vercel/")) {
            result = await vercelGet(new Request(url));
          } else if (url.pathname.startsWith("/netlify/")) {
            result = await netlifyFunction(new Request(url), {
              params: { slug: url.pathname.slice("/netlify/".length) },
            });
          } else if (url.pathname === "/health") {
            result = new Response(JSON.stringify({ ok: true }), {
              headers: { "Content-Type": "application/json" },
            });
          } else {
            result = new Response("Not found", { status: 404 });
          }
          response.writeHead(result.status, Object.fromEntries(result.headers));
          response.end(Buffer.from(await result.arrayBuffer()));
        } catch (error) {
          response.writeHead(500, { "Content-Type": "text/plain" });
          response.end(String(error));
        }
      });
      await new Promise((resolve) => server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Deployment fixture did not bind TCP.");
        const base = \`http://127.0.0.1:\${address.port}\`;
        const health = await fetch(base + "/health");
        if (!health.ok || (await health.json()).ok !== true) throw new Error("Node health endpoint failed.");
        // Each route is fetched twice with different slugs; identical bytes
        // would mean the request never reached the copy resolver.
        const routePairs = [
          ["/vercel/packed?slug=query", "/vercel/packed?slug=other"],
          ["/vercel-fetchable?slug=query", "/vercel-fetchable?slug=other"],
          ["/netlify/packed", "/netlify/other"],
        ];
        for (const [path, alternatePath] of routePairs) {
          const result = await fetch(base + path);
          const alternate = await fetch(base + alternatePath);
          if (!alternate.ok) throw new Error(\`${"${alternatePath}"} returned \${alternate.status}.\`);
          const alternateBytes = new Uint8Array(await alternate.arrayBuffer());
          if (!result.ok) throw new Error(\`${"${path}"} returned \${result.status}.\`);
          if (result.headers.get("content-type") !== ${JSON.stringify(SOCIAL_CARD_FIXTURE.contentType)}) {
            throw new Error(\`${"${path}"} returned the wrong content type.\`);
          }
          if (result.headers.get("cache-control") !== "public, max-age=86400") {
            throw new Error(\`${"${path}"} returned the wrong cache policy.\`);
          }
          const imageBytes = new Uint8Array(await result.arrayBuffer());
          const image = verifyImage(imageBytes, ${cardSizeSource}, "png");
          verifyImage(alternateBytes, ${cardSizeSource}, "png");
          if (Buffer.from(imageBytes).equals(Buffer.from(alternateBytes))) {
            throw new Error(\`${"${path}"} rendered the same bytes for a different slug; the route did not resolve its copy from the request.\`);
          }
          const routeId = path.startsWith("/netlify/") ? "netlify-node" : "vercel-node";
          routeEvidence.routes[routeId] = {
            packedArtifact: true,
            servedOutput: true,
            imageVerification: { verified: true, format: image.format, width: image.width, height: image.height, byteLength: imageBytes.byteLength },
            responseVerification: { verified: true, contentType: result.headers.get("content-type"), queryOrPathResolved: true, distinctSlugByteLengths: [imageBytes.byteLength, alternateBytes.byteLength] },
          };
        }
      } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      writeFileSync(${JSON.stringify(join(expressApp, "provider-route-evidence.json"))}, JSON.stringify(routeEvidence));
    `,
    expressApp,
  );
  Object.assign(routeEvidence.routes, JSON.parse(readFileSync(join(expressApp, "provider-route-evidence.json"), "utf8")).routes);

  // Build and serve a current React Router framework-mode resource route.
  // This verifies its loader(args) convention and generated route types from
  // the tarball instead of treating it as an old Remix-style GET handler.
  install(routerApp, [archive]);
  for (const dependency of FRAMEWORK_DEPENDENCIES.reactRouter) {
    linkLockedDependency(routerApp, dependency);
  }
  writeFileSync(
    join(routerApp, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        metaplate: manifest.version,
        ...Object.fromEntries(
          FRAMEWORK_DEPENDENCIES.reactRouter.map((dependency) => [
            dependency,
            lockfile.packages[`node_modules/${dependency}`].version,
          ]),
        ),
      },
    }),
  );
  mkdirSync(join(routerApp, "app", "lib"), { recursive: true });
  mkdirSync(join(routerApp, "app", "routes"), { recursive: true });
  writeFileSync(
    join(routerApp, "react-router.config.ts"),
    `import type { Config } from "@react-router/dev/config";
export default { ssr: true } satisfies Config;
`,
  );
  writeFileSync(
    join(routerApp, "vite.config.ts"),
    `import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [reactRouter()] });
`,
  );
  writeFileSync(
    join(routerApp, "tsconfig.json"),
    JSON.stringify({
      include: ["**/*", ".react-router/types/**/*"],
      compilerOptions: {
        strict: true,
        target: "ES2022",
        lib: ["DOM", "DOM.Iterable", "ES2022"],
        jsx: "react-jsx",
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        rootDirs: [".", "./.react-router/types"],
        types: ["node"],
      },
    }),
  );
  writeFileSync(
    join(routerApp, "app", "routes.ts"),
    `import { type RouteConfig, index, route } from "@react-router/dev/routes";
export default [
  index("routes/home.tsx"),
  route(${JSON.stringify(`:slug/${SOCIAL_CARD_FIXTURE.imagePath}`)}, "routes/og-image.ts"),
] satisfies RouteConfig;
`,
  );
  writeFileSync(
    join(routerApp, "app", "root.tsx"),
    `import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
export function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><head><Meta /><Links /></head><body>{children}<ScrollRestoration /><Scripts /></body></html>;
}
export default function Root() { return <Outlet />; }
`,
  );
  writeFileSync(
    join(routerApp, "app", "routes", "home.tsx"),
    `import type { MetaFunction } from "react-router";
import { socialImageMetadata } from "metaplate";
const social = socialImageMetadata("/guide", "Guide card", {
  origin: ${JSON.stringify(SOCIAL_CARD_FIXTURE.origin)},
  imagePath: ${JSON.stringify(SOCIAL_CARD_FIXTURE.imagePath)},
  type: ${JSON.stringify(SOCIAL_CARD_FIXTURE.contentType)},
});
const image = social.openGraph.images[0];
export const meta: MetaFunction = () => [
  { property: "og:image", content: image.url },
  { property: "og:image:width", content: String(image.width) },
  { property: "og:image:height", content: String(image.height) },
  { name: "twitter:card", content: social.twitter.card },
];
export default function Home() { return <main>Metaplate React Router fixture</main>; }
`,
  );
  writeFileSync(
    join(routerApp, "app", "lib", "og.ts"),
    `import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";
export const og = createNodeOg({
  alt: (copy: { title: string }) => \`${"${copy.title}"} social card\`,
  fonts: fontsourceFontLoader([${fontsourceFontSource}]),
  component: (copy: { title: string }) => ({
    type: "div",
    props: {
      style: { width: "100%", height: "100%", display: "flex", fontFamily: "Inter", fontSize: 64 },
      children: copy.title,
    },
  }),
});
`,
  );
  writeFileSync(
    join(routerApp, "app", "routes", "og-image.ts"),
    `import type { Route } from "./+types/og-image";
import { og } from "../lib/og";
export const loader = og.handlerFrom(({ params }: Route.LoaderArgs) => ({
  title: (params.slug ?? "missing").slice(0, 80),
}));
`,
  );
  // Resolve the CLI from the package manifest: React Router 7 shipped
  // `bin.js` and React Router 8 ships `bin.cjs`.
  const routerDevRoot = join(routerApp, "node_modules", "@react-router", "dev");
  const routerDevManifest = JSON.parse(readFileSync(join(routerDevRoot, "package.json"), "utf8"));
  const routerCli = join(routerDevRoot, routerDevManifest.bin["react-router"]);
  const runRouterCli = (command) => {
    const result = spawnSync(process.execPath, [routerCli, command], {
      cwd: routerApp,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      throw new Error(`React Router ${command} failed with status ${result.status}.`);
    }
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (output.includes("The `envFile` option is deprecated")) {
      throw new Error(
        `React Router ${command} used Vite's deprecated envFile option.`,
      );
    }
  };
  runRouterCli("typegen");
  const routerTsc = join(routerApp, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [routerTsc, "--noEmit"], { cwd: routerApp, stdio: "inherit" });
  runRouterCli("build");
  runModule(
    `
      import express from "express";
      import { createRequestHandler } from "@react-router/express";
      import { verifyImage } from "metaplate/image";
      import * as build from "./build/server/index.js";
      const app = express();
      app.use(express.static("build/client"));
      app.use(createRequestHandler({ build, mode: "production" }));
      const server = await new Promise((resolve) => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("React Router did not bind TCP.");
        const base = \`http://127.0.0.1:\${address.port}\`;
        const page = await fetch(base);
        const html = await page.text();
        if (!html.includes(${JSON.stringify(`${SOCIAL_CARD_FIXTURE.origin}/guide/${SOCIAL_CARD_FIXTURE.imagePath}`)})) {
          throw new Error("React Router page did not emit absolute social metadata.");
        }
        const response = await fetch(base + ${JSON.stringify(`/guide/${SOCIAL_CARD_FIXTURE.imagePath}`)});
        if (!response.ok || response.headers.get("content-type") !== ${JSON.stringify(SOCIAL_CARD_FIXTURE.contentType)}) {
          throw new Error("React Router resource route returned the wrong status or content type.");
        }
        verifyImage(new Uint8Array(await response.arrayBuffer()), ${cardSizeSource}, "png");
      } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    `,
    routerApp,
  );

  // Build and serve a SvelteKit 3 `+server` route through the official Node
  // adapter. Kit 3 reads its configuration from the `sveltekit()` Vite plugin
  // (svelte.config.js is no longer supported) and resolves `#lib` through
  // package.json subpath imports, so the fixture uses exactly those contracts.
  install(svelteApp, [archive]);
  for (const dependency of FRAMEWORK_DEPENDENCIES.sveltekit) {
    linkLockedDependency(svelteApp, dependency);
  }
  // adapter-node bundles everything except production dependencies, so the
  // packed artifact stays an external runtime import with its native renderer.
  writeFileSync(
    join(svelteApp, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      imports: { "#lib": "./src/lib/index.js", "#lib/*": "./src/lib/*" },
      dependencies: { metaplate: manifest.version },
      devDependencies: Object.fromEntries(
        FRAMEWORK_DEPENDENCIES.sveltekit.map((dependency) => [
          dependency,
          lockfile.packages[`node_modules/${dependency}`].version,
        ]),
      ),
    }),
  );
  const svelteImageRoute = join(svelteApp, "src", "routes", "[slug]", SOCIAL_CARD_FIXTURE.imagePath);
  mkdirSync(join(svelteApp, "src", "lib"), { recursive: true });
  mkdirSync(svelteImageRoute, { recursive: true });
  writeFileSync(
    join(svelteApp, "vite.config.js"),
    `import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [sveltekit({ adapter: adapter() })] });
`,
  );
  writeFileSync(
    join(svelteApp, "tsconfig.json"),
    JSON.stringify({
      extends: "$app/tsconfig",
      include: ["src"],
      compilerOptions: { strict: true, types: ["$app/types", "node"] },
    }),
  );
  writeFileSync(
    join(svelteApp, "src", "app.html"),
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />%sveltekit.head%</head>
<body><div style="display: contents">%sveltekit.body%</div></body></html>
`,
  );
  writeFileSync(
    join(svelteApp, "src", "routes", "+page.svelte"),
    `<script>
  import { socialImageMetadata } from "metaplate";
  const social = socialImageMetadata("/guide", "Guide card", {
    origin: ${JSON.stringify(SOCIAL_CARD_FIXTURE.origin)},
    imagePath: ${JSON.stringify(SOCIAL_CARD_FIXTURE.imagePath)},
    type: ${JSON.stringify(SOCIAL_CARD_FIXTURE.contentType)},
  });
  const image = social.openGraph.images[0];
</script>

<svelte:head>
  <meta property="og:image" content={image.url} />
  <meta property="og:image:width" content={String(image.width)} />
  <meta property="og:image:height" content={String(image.height)} />
  <meta property="og:image:type" content={image.type} />
  <meta property="og:image:alt" content={image.alt} />
  <meta name="twitter:card" content={social.twitter.card} />
  <meta name="twitter:image" content={social.twitter.images[0].url} />
</svelte:head>

<main>Metaplate SvelteKit fixture</main>
`,
  );
  writeFileSync(
    join(svelteApp, "src", "lib", "og.ts"),
    `import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";
type Copy = { title: string; alt: string };
export const og = createNodeOg({
  alt: (copy: Copy) => copy.alt,
  fonts: fontsourceFontLoader([${fontsourceFontSource}]),
  headers: { "Cache-Control": "public, max-age=86400" },
  component: (copy: Copy) => ({
    type: "div",
    props: {
      style: { width: "100%", height: "100%", display: "flex", alignItems: "center", fontFamily: "Inter", fontSize: 64 },
      children: copy.title,
    },
  }),
});
`,
  );
  // The route body is the README's SvelteKit example: `GET` is typed by the
  // generated `RequestHandler`, which is what types `params.slug`.
  writeFileSync(
    join(svelteImageRoute, "+server.ts"),
    `import type { RequestHandler } from "./$types";
import { og } from "#lib/og.js";

const titleFor = (slug: string) => slug.slice(0, 80);

export const GET: RequestHandler = og.handlerFrom(({ params }) => ({
  title: titleFor(params.slug),
  alt: \`${"${params.slug}"} card\`,
}));
`,
  );
  const svelteNode = (label, args) => {
    const result = spawnSync(process.execPath, args, { cwd: svelteApp, encoding: "utf8" });
    if (result.status !== 0) {
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      throw new Error(`SvelteKit ${label} failed with status ${result.status}.`);
    }
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (output.includes("tsconfig_invalid") || output.includes("tsconfig_extends_missing")) {
      throw new Error(`SvelteKit ${label} rejected the fixture tsconfig:\n${output}`);
    }
  };
  const kitRoot = join(svelteApp, "node_modules", "@sveltejs", "kit");
  const kitManifest = JSON.parse(readFileSync(join(kitRoot, "package.json"), "utf8"));
  svelteNode("sync", [join(kitRoot, kitManifest.bin["svelte-kit"]), "sync"]);
  svelteNode("typecheck", [join(svelteApp, "node_modules", "typescript", "bin", "tsc"), "--noEmit"]);
  svelteNode("build", [join(svelteApp, "node_modules", "vite", "bin", "vite.js"), "build"]);
  runModule(
    `
      import { once } from "node:events";
      import { writeFileSync } from "node:fs";
      import { verifyImage } from "metaplate/image";
      process.env.HOST = "127.0.0.1";
      process.env.PORT = "0";
      const routeEvidence = { schemaVersion: 1, commitSha: ${JSON.stringify(commitSha)}, routes: {} };
      // adapter-node's entry listens on import and exports its http.Server.
      const { server } = await import("./build/index.js");
      if (!server.listening) await once(server, "listening");
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("SvelteKit did not bind TCP.");
        const base = \`http://127.0.0.1:\${address.port}\`;
        const page = await fetch(base);
        const html = await page.text();
        if (
          !page.ok ||
          !html.includes(${JSON.stringify(`content="${SOCIAL_CARD_FIXTURE.origin}/guide/${SOCIAL_CARD_FIXTURE.imagePath}"`)}) ||
          !html.includes(${JSON.stringify(`content="${cardSize.width}"`)}) ||
          !html.includes(${JSON.stringify(`content="${SOCIAL_CARD_FIXTURE.contentType}"`)})
        ) {
          throw new Error("SvelteKit page did not emit absolute social metadata.");
        }
        const response = await fetch(base + ${JSON.stringify(`/guide/${SOCIAL_CARD_FIXTURE.imagePath}`)});
        const other = await fetch(base + ${JSON.stringify(`/other/${SOCIAL_CARD_FIXTURE.imagePath}`)});
        if (!response.ok || !other.ok) {
          throw new Error(\`SvelteKit +server route returned \${response.status}/\${other.status}.\`);
        }
        const contentType = response.headers.get("content-type");
        const cacheControl = response.headers.get("cache-control");
        if (contentType !== ${JSON.stringify(SOCIAL_CARD_FIXTURE.contentType)} || cacheControl !== "public, max-age=86400") {
          throw new Error(\`SvelteKit +server route returned \${contentType} with cache policy \${cacheControl}.\`);
        }
        const imageBytes = new Uint8Array(await response.arrayBuffer());
        const otherBytes = new Uint8Array(await other.arrayBuffer());
        const image = verifyImage(imageBytes, ${cardSizeSource}, "png");
        verifyImage(otherBytes, ${cardSizeSource}, "png");
        if (Buffer.from(imageBytes).equals(Buffer.from(otherBytes))) {
          throw new Error("SvelteKit rendered identical bytes for different slugs; params did not reach the resolver.");
        }
        routeEvidence.routes["sveltekit-node"] = {
          packedArtifact: true,
          productionBuild: true,
          servedOutput: true,
          imageVerification: { verified: true, format: image.format, width: image.width, height: image.height, byteLength: imageBytes.byteLength },
          responseVerification: { verified: true, contentType, cacheControl, pageMetadata: true, distinctSlugByteLengths: [imageBytes.byteLength, otherBytes.byteLength] },
        };
      } finally {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      writeFileSync(${JSON.stringify(join(svelteApp, "sveltekit-route-evidence.json"))}, JSON.stringify(routeEvidence));
    `,
    svelteApp,
  );
  Object.assign(routeEvidence.routes, JSON.parse(readFileSync(join(svelteApp, "sveltekit-route-evidence.json"), "utf8")).routes);

  execFileSync(
    process.execPath,
    ["--input-type=commonjs", "--eval", commonJsResolutionSmoke(packageEntries)],
    { cwd: consumer, stdio: "inherit" },
  );

  const cliPath = join(consumer, "node_modules", "metaplate", "dist", "cli.js");

  const usage = spawnSync(process.execPath, [cliPath], {
    cwd: consumer,
    encoding: "utf8",
  });
  if (usage.status !== 1 || !usage.stderr.includes("Usage: metaplate verify")) {
    throw new Error("Installed CLI did not return its expected usage error.");
  }

  // The CLI's happy path had never run against real files outside the repo.
  // Copy the fixtures beside the consumer and verify a mixed-format group.
  for (const fixture of [
    CLI_IMAGE_FIXTURES.cardJpeg,
    CLI_IMAGE_FIXTURES.iconJpeg,
    CLI_IMAGE_FIXTURES.cardWebp,
  ]) {
    copyFileSync(join(root, "tests", "fixtures", fixture), join(consumer, fixture));
  }

  const verified = spawnSync(
    process.execPath,
    [
      cliPath,
      "verify",
      "--size",
      cardSizeArgument,
      CLI_IMAGE_FIXTURES.cardJpeg,
      CLI_IMAGE_FIXTURES.cardWebp,
      "--size",
      iconSizeArgument,
      CLI_IMAGE_FIXTURES.iconJpeg,
    ],
    { cwd: consumer, encoding: "utf8" },
  );
  const expected = [
    `✓ ${CLI_IMAGE_FIXTURES.cardJpeg} ${cardSizeArgument}`,
    `✓ ${CLI_IMAGE_FIXTURES.cardWebp} ${cardSizeArgument}`,
    `✓ ${CLI_IMAGE_FIXTURES.iconJpeg} ${iconSizeArgument}`,
  ];
  if (verified.status !== 0 || !expected.every((line) => verified.stdout.includes(line))) {
    throw new Error(
      `Installed CLI did not verify a mixed-format group: ${verified.stdout}${verified.stderr}`,
    );
  }

  const mismatch = spawnSync(
    process.execPath,
    [cliPath, "verify", "--size", cardSizeArgument, CLI_IMAGE_FIXTURES.iconJpeg],
    { cwd: consumer, encoding: "utf8" },
  );
  if (
    mismatch.status !== 1 ||
    !mismatch.stderr.includes(`Expected ${cardSizeArgument}, received ${iconSizeArgument}`)
  ) {
    throw new Error("Installed CLI did not report a dimension mismatch.");
  }

  const jsonCheck = spawnSync(
    process.execPath,
    [
      cliPath,
      "verify",
      "--json",
      "--target",
      "universal",
      "--url",
      absoluteFixtureImage,
      "--alt",
      "Packed card",
      "--size",
      cardSizeArgument,
      CLI_IMAGE_FIXTURES.cardJpeg,
    ],
    { cwd: consumer, encoding: "utf8" },
  );
  if (jsonCheck.status !== 0) {
    throw new Error(`Installed CLI JSON verification failed: ${jsonCheck.stdout}${jsonCheck.stderr}`);
  }
  const jsonReport = JSON.parse(jsonCheck.stdout);
  if (jsonReport.schemaVersion !== 1 || jsonReport.files[0]?.targets?.universal?.compatible !== true) {
    throw new Error("Installed CLI JSON verification did not report universal compatibility.");
  }

  const formatCheck = spawnSync(
    process.execPath,
    [
      cliPath,
      "verify",
      "--format",
      "jpeg",
      "--size",
      cardSizeArgument,
      CLI_IMAGE_FIXTURES.cardWebp,
    ],
    { cwd: consumer, encoding: "utf8" },
  );
  if (
    formatCheck.status !== 1 ||
    !formatCheck.stderr.includes(`Expected jpeg ${cardSizeArgument}, received webp`)
  ) {
    throw new Error("Installed CLI did not reject a format mismatch.");
  }

  // Issue #55: one bad file must not hide the rest. A truncated WebP plus a
  // good JPEG in one run has to report both outcomes in one invocation.
  const truncated = readFileSync(
    join(root, "tests", "fixtures", CLI_IMAGE_FIXTURES.cardWebp),
  ).subarray(
    0,
    250,
  );
  writeFileSync(join(consumer, "truncated.webp"), truncated);
  const aggregate = spawnSync(
    process.execPath,
    [
      cliPath,
      "verify",
      "--size",
      cardSizeArgument,
      "truncated.webp",
      CLI_IMAGE_FIXTURES.cardJpeg,
      "does-not-exist.webp",
    ],
    { cwd: consumer, encoding: "utf8" },
  );
  const report = `${aggregate.stdout}${aggregate.stderr}`;
  if (
    aggregate.status !== 1 ||
    !report.includes(`✓ ${CLI_IMAGE_FIXTURES.cardJpeg} ${cardSizeArgument}`) ||
    !report.includes("✗ truncated.webp") ||
    !report.includes("✗ does-not-exist.webp") ||
    !report.includes("2 of 3 files failed verification")
  ) {
    throw new Error(
      `Installed CLI did not aggregate failures across targets: ${report}`,
    );
  }

  // Shape two proves the one-command install can produce real PNG bytes from
  // the packed tarball; only the fixture font and compiler are test tooling.
  install(standalone, [archive]);
  for (const dependency of FRAMEWORK_DEPENDENCIES.standalone) {
    linkLockedDependency(standalone, dependency);
  }

  const standaloneSmoke = `
    const { fontsourceFontLoader } = await import("metaplate/fonts");
    const { createNodeOg } = await import("metaplate/node");
    const { verifyPng } = await import("metaplate/png");

    const plate = createNodeOg({
      alt: () => "card",
      fonts: fontsourceFontLoader([${fontsourceFontSource}]),
      component: (copy) => ({
        type: "div",
        props: {
          style: {
            width: "100%",
            height: "100%",
            display: "flex",
            fontFamily: "Inter",
            fontSize: 64,
          },
          children: copy.title,
        },
      }),
    });

    verifyPng(await plate.render({ title: "Standalone" }), plate.size);
    const fetchable = plate.fetchableFrom(async (request, context) => ({
      title: context.slug + ":" + new URL(request.url).pathname,
    }));
    const fetchableResponse = await fetchable.fetch(new Request("https://example.com/cards/packed"), { slug: "packed" });
    verifyPng(await fetchableResponse.arrayBuffer(), plate.size);
    const artifact = await plate.artifact("/cards/packed", { title: "Artifact" });
    if (artifact.byteLength !== artifact.bytes.byteLength || artifact.image.format !== "png" || artifact.metadata.openGraph.images[0].url !== "/cards/packed/og-image") {
      throw new Error("Packed artifact did not keep bytes, image facts, and metadata together.");
    }
  `;
  runModule(standaloneSmoke, standalone);

  // `metaplate render` end to end from the packed bin: a real plate with a
  // variant, a basePath that must not reach the file tree, nested routes, and
  // a manifest whose every hash and size must match the files on disk.
  const renderCliPath = join(standalone, "node_modules", "metaplate", "dist", "cli.js");
  const renderPlateSource = `
    import { fontsourceFontLoader } from "metaplate/fonts";
    import { createNodeOg } from "metaplate/node";

    export const og = createNodeOg({
      alt: (copy) => copy.title,
      fonts: fontsourceFontLoader([${fontsourceFontSource}]),
      imagePath: "og-image.png",
      basePath: "/project",
      origin: "https://example.com",
      variants: { square: { size: { width: 1080, height: 1080 } } },
      component: (copy) => ({
        type: "div",
        props: {
          style: { width: "100%", height: "100%", display: "flex", fontFamily: "Inter", fontSize: 64 },
          children: copy.title,
        },
      }),
    });
  `;
  writeFileSync(join(standalone, "og-plate.mjs"), renderPlateSource);
  writeFileSync(
    join(standalone, "og.render.mjs"),
    `import { og } from "./og-plate.mjs";
    export default async () => [
      { plate: og, pages: [{ copy: { title: "Home" } }, { route: "/posts/caf%C3%A9", copy: { title: "Cafe" } }] },
    ];`,
  );
  const expectedRenderImages = [
    ["og-image.png", "https://example.com/project/og-image.png", cardSize],
    ["og-image-square.png", "https://example.com/project/og-image-square.png", { width: 1080, height: 1080 }],
    ["posts/café/og-image.png", "https://example.com/project/posts/caf%C3%A9/og-image.png", cardSize],
    ["posts/café/og-image-square.png", "https://example.com/project/posts/caf%C3%A9/og-image-square.png", { width: 1080, height: 1080 }],
  ];
  const { verifyImage: packedVerifyImage } = await import(
    pathToFileURL(join(standalone, "node_modules", "metaplate", "dist", "image.js")).href
  );

  function verifyRenderedSite(label, module, extraArgs = []) {
    const out = join(standalone, `site-${label}`);
    const rendered = spawnSync(
      process.execPath,
      [renderCliPath, "render", "--json", "--out", out, "--concurrency", "2", ...extraArgs, module],
      { cwd: standalone, encoding: "utf8" },
    );
    if (rendered.status !== 0) {
      throw new Error(`Packed metaplate render (${label}) failed: ${rendered.stdout}${rendered.stderr}`);
    }
    const report = JSON.parse(rendered.stdout);
    const manifest = JSON.parse(readFileSync(join(out, "metaplate-manifest.json"), "utf8"));
    if (report.schemaVersion !== 1 || manifest.schemaVersion !== 1 || manifest.images.length !== expectedRenderImages.length) {
      throw new Error(`Packed metaplate render (${label}) reported an unexpected image set: ${rendered.stdout}`);
    }
    expectedRenderImages.forEach(([path, url, size], index) => {
      const entry = manifest.images[index];
      const bytes = readFileSync(join(out, ...path.split("/")));
      const image = packedVerifyImage(bytes, size, "png");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (
        entry.path !== path ||
        entry.url !== url ||
        entry.format !== "png" ||
        entry.verified !== true ||
        entry.bytes !== bytes.byteLength ||
        entry.sha256 !== sha256 ||
        entry.size.width !== image.width ||
        entry.size.height !== image.height ||
        report.images[index]?.valid !== true
      ) {
        throw new Error(`Packed metaplate render (${label}) manifest disagrees with ${path}: ${JSON.stringify(entry)}`);
      }
    });
    if (existsSync(join(out, "project"))) {
      throw new Error(`Packed metaplate render (${label}) wrote the basePath into the file tree.`);
    }
  }
  verifyRenderedSite("mjs", "og.render.mjs");

  // Node strips types by default on every version the full gate runs (22.18+),
  // so the packed CLI must load a TypeScript module with no compiler at all.
  if (process.features.typescript) {
    writeFileSync(
      join(standalone, "og.render.ts"),
      `import type { RenderJob } from "metaplate/node";
      import { og } from "./og-plate.mjs";
      type Copy = { title: string };
      const pages: RenderJob<Copy>["pages"] = [{ copy: { title: "Home" } }, { route: "/posts/caf%C3%A9", copy: { title: "Cafe" } }];
      export default { plate: og, pages };`,
    );
    verifyRenderedSite("ts", "og.render.ts");
  }

  writeFileSync(
    join(standalone, "escape.render.mjs"),
    `import { og } from "./og-plate.mjs";
    export default { plate: og, pages: [{ route: "/posts/%2e%2e%2F..%2Fescape", copy: { title: "Escape" } }] };`,
  );
  const escaped = spawnSync(
    process.execPath,
    [renderCliPath, "render", "--out", join(standalone, "site-escape"), "escape.render.mjs"],
    { cwd: standalone, encoding: "utf8" },
  );
  if (escaped.status !== 1 || !escaped.stderr.includes("not a portable file name") || existsSync(join(standalone, "escape"))) {
    throw new Error(`Packed metaplate render did not refuse a path outside --out: ${escaped.stdout}${escaped.stderr}`);
  }

  // Plain-object authoring still has no React type dependency even though the
  // batteries-included install now supplies the React runtime for JSX users.
  // `skipLibCheck` is deliberately off so a declaration leak remains visible.
  writeFileSync(
    join(standalone, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: "nodenext",
        moduleResolution: "nodenext",
        types: ["node"],
      },
      include: ["react-free.tsx"],
    }),
  );
  writeFileSync(
    join(standalone, "react-free.tsx"),
    `
    import {
      createSvgOg,
      type SatoriFont,
      type SatoriLayoutNode,
      type SatoriNode,
    } from "metaplate/render";
    import { socialImageMetadata } from "metaplate";

    const plain: SatoriNode = {
      type: "div",
      props: {
        style: { display: "flex", width: "100%", height: "100%" },
        children: "card",
      },
    };

    // Exercise the React-free type surface: a Buffer-backed font (Node typed
    // fonts were valid through Satori's re-export), the layout node passed to
    // onNodeDetected, and the async loadAdditionalAsset callback.
    const font: SatoriFont = {
      name: "Inter",
      data: Buffer.from("font bytes"),
      weight: 700,
    };
    let detected: SatoriLayoutNode | undefined;

    // A plain-object component must satisfy the definition without React.
    const plate = createSvgOg({
      component: () => plain,
      alt: () => "card",
      fonts: () => [font],
      satori: {
        onNodeDetected: (node) => {
          detected = node;
        },
        loadAdditionalAsset: (lang, segment) => Promise.resolve(segment + lang),
      },
    });

    export const metadata = socialImageMetadata("/", "card");
    export default plate;
  `,
  );
  const tsc = execFileSync(
    process.execPath,
    [join(standalone, "node_modules", "typescript", "bin", "tsc"), "-p", join(standalone, "tsconfig.json")],
    { cwd: standalone, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).toString();
  if (tsc.includes("error")) {
    throw new Error(`TypeScript consumer failed to compile: ${tsc}`);
  }

  // Issue #59, round two: the React-free surface must not trade the React
  // type leak for a Node one. `SatoriFont.data` is declared as
  // `ArrayBuffer | Uint8Array` (never Node's bare `Buffer` global), so a
  // consumer with no @types/node or React types can load both
  // `metaplate/render` and `metaplate/node`, author a plain-object plate, and
  // use the public pixel/Resvg option shapes without installing Resvg yet.
  // Compile that second consumer here with `skipLibCheck` off, so a hidden
  // Node or React type dependency is a hard error rather than a suppressed one.
  install(bare, [archive]);
  for (const dependency of FRAMEWORK_DEPENDENCIES.bare) {
    linkLockedDependency(bare, dependency);
  }

  // Make the smoke airtight: `types: []` stops TypeScript from auto-including
  // any @types package that might arrive transitively, and the explicit
  // absence checks fail the run if React or Node declarations are pulled in.
  for (const forbidden of ["@types/react", "@types/node"]) {
    if (existsSync(join(bare, "node_modules", forbidden))) {
      throw new Error(`The isomorphic consumer pulled ${forbidden}.`);
    }
  }

  writeFileSync(
    join(bare, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: "nodenext",
        moduleResolution: "nodenext",
        types: [],
      },
      include: ["isomorphic.tsx"],
    }),
  );
  writeFileSync(
    join(bare, "isomorphic.tsx"),
    `
    import {
      createSvgOg,
      type SatoriFont,
      type SatoriLayoutNode,
    } from "metaplate/render";
    import {
      createNodeOg,
      type RenderedPixels,
      type ResvgRenderOptions,
    } from "metaplate/node";

    // An ArrayBuffer-backed font must type-check where Node's Buffer global
    // is unavailable; a Uint8Array would also satisfy the union.
    const font: SatoriFont = {
      name: "Inter",
      data: new ArrayBuffer(8),
      weight: 700,
    };
    let detected: SatoriLayoutNode | undefined;

    const plate = createSvgOg({
      component: () => ({
        type: "div",
        props: {
          style: { display: "flex", width: "100%", height: "100%" },
          children: "card",
        },
      }),
      alt: () => "card",
      fonts: () => [font],
      satori: {
        onNodeDetected: (node) => {
          detected = node;
        },
        loadAdditionalAsset: (lang, segment) => Promise.resolve(segment + lang),
      },
    });

    const resvg: ResvgRenderOptions = {
      background: "transparent",
      fitTo: { mode: "width", value: ${cardSize.width} },
    };
    const nodePlate = createNodeOg({
      component: () => ({ type: "div", props: { children: "card" } }),
      alt: () => "card",
      fonts: () => [font],
      resvg,
    });
    type PixelResult = Awaited<ReturnType<typeof nodePlate.renderPixels>>;
    const acceptsPixels = (pixels: RenderedPixels): PixelResult => pixels;
    void acceptsPixels;

    export { nodePlate };
    export default plate;
  `,
  );
  const bareTsc = execFileSync(
    process.execPath,
    [join(bare, "node_modules", "typescript", "bin", "tsc"), "-p", join(bare, "tsconfig.json")],
    { cwd: bare, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).toString();
  if (bareTsc.includes("error")) {
    throw new Error(`Isomorphic TypeScript consumer failed to compile: ${bareTsc}`);
  }

  // Issue #58: a resolver-injection smoke — a font resolved through a
  // supplied `resolvePackage` hook rather than node_modules.
  const resolverSmoke = `
    const { createRequire } = await import("node:module");
    const { packageFontLoader } = await import("metaplate/fonts");
    const { createNodeOg } = await import("metaplate/node");
    const requireFrom = createRequire(import.meta.url);

    const loader = packageFontLoader(
      [${packageFontSource}],
      {
        resolvePackage: () =>
          requireFrom.resolve(${JSON.stringify(`${PACKAGE_FONT_FIXTURE.package}/package.json`)}).replace(
            /[\\\\/]package\\.json$/,
            "",
          ),
      },
    );

    const plate = createNodeOg({
      alt: () => "card",
      fonts: loader,
      component: () => ({
        type: "div",
        props: {
          style: {
            width: "100%",
            height: "100%",
            display: "flex",
            fontFamily: "Inter",
            fontSize: 64,
          },
          children: "Resolver",
        },
      }),
    });

    await plate.render({ title: "Resolver" });
  `;
  runModule(resolverSmoke, standalone);

  writeFileSync(join(root, "deployment-contract-evidence.json"), `${JSON.stringify(routeEvidence, null, 2)}\n`);
  process.stdout.write(
    `Verified ${packed.filename} exports, CLI, and all consumer installs.\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
