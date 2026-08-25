import { execFileSync, spawnSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  CLI_IMAGE_FIXTURES,
  FONTSOURCE_FONT_FIXTURE,
  FRAMEWORK_DEPENDENCIES,
  PACKAGE_FONT_FIXTURE,
  REQUIRED_RENDERER_PEERS,
  SOCIAL_CARD_FIXTURE,
  commonJsResolutionSmoke,
  esmImportSmoke,
  nextPeerGuidanceSmoke,
  packageEntrySpecifiers,
} from "./package-fixtures.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), "metaplate-package-"));
const consumer = join(temporary, "consumer");
const standalone = join(temporary, "standalone");
const bare = join(temporary, "bare");
const nextApp = join(temporary, "next-app");
const astroApp = join(temporary, "astro-app");
const expressApp = join(temporary, "express-app");
const routerApp = join(temporary, "router-app");
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

/** Copies an installed, lockfile-verified runtime dependency closure offline. */
function copyLockedDependencyTree(directory, name, copied = new Set()) {
  if (copied.has(name)) return copied;
  copyLockedDependency(directory, name);
  copied.add(name);

  const { installed } = lockedDependency(name);
  for (const dependency of Object.keys(installed.dependencies ?? {})) {
    copyLockedDependencyTree(directory, dependency, copied);
  }
  return copied;
}

try {
  const packed = JSON.parse(
    run(["pack", "--json", "--pack-destination", temporary]),
  );
  const archive = join(temporary, packed[0].filename);
  const paths = new Set(packed[0].files.map((file) => file.path));

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
        data: () => { calls += 1; return Uint8Array.of(1, 2, 3); },
      }]);
      const first = await fonts();
      const second = await fonts();
      if (first !== second || calls !== 1 || first[0].data.byteLength !== 3) {
        throw new Error("The portable font loader did not normalize and memoize bytes.");
      }
    `,
    consumer,
  );

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
  const nextManifest = JSON.parse(
    readFileSync(join(root, "node_modules", "next", "package.json"), "utf8"),
  );
  const installedSwc = Object.keys(nextManifest.optionalDependencies ?? {}).filter(
    (dependency) =>
      dependency.startsWith("@next/swc-") &&
      existsSync(join(root, "node_modules", ...dependency.split("/"))),
  );
  if (installedSwc.length === 0) {
    throw new Error(
      "Expected at least one locally installed Next SWC package, found none.",
    );
  }
  // npm can retain both glibc and musl candidates on Linux. Copy every
  // installed, lockfile-verified candidate and let Next select the binary for
  // the current runtime rather than assuming the install contains exactly one.
  for (const swcPackage of installedSwc) {
    copyLockedDependencyTree(nextApp, swcPackage, copiedNextPackages);
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
  try {
    execFileSync(process.execPath, [nextCli, "build"], {
      cwd: nextApp,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });
  } catch (error) {
    const details = error instanceof Error && "stderr" in error ? error.stderr : error;
    throw new Error(`Packed-package Next static export failed: ${details}`, { cause: error });
  }

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

  // Build an actual Astro static site from the packed artifact. This proves
  // the APIRoute handler contract, production bundling of the optional native
  // renderer boundary, emitted image path, bytes, dimensions, and page tags.
  install(astroApp, [archive]);
  for (const dependency of FRAMEWORK_DEPENDENCIES.astro) {
    linkLockedDependency(astroApp, dependency);
  }
  mkdirSync(join(astroApp, "src", "lib"), { recursive: true });
  mkdirSync(join(astroApp, "src", "pages"), { recursive: true });
  writeFileSync(join(astroApp, "astro.config.mjs"), "export default {};\n");
  writeFileSync(
    join(astroApp, "src", "lib", "og.ts"),
    `import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

export const og = createNodeOg({
  alt: (copy: { title: string }) => \`${"${copy.title}"} social card\`,
  fonts: fontsourceFontLoader([${fontsourceFontSource}]),
  imagePath: ${JSON.stringify(SOCIAL_CARD_FIXTURE.imagePath)},
  origin: ${JSON.stringify(SOCIAL_CARD_FIXTURE.origin)},
  component: (copy: { title: string }) => ({
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
`,
  );
  writeFileSync(
    join(astroApp, "src", "pages", `${SOCIAL_CARD_FIXTURE.imagePath}.ts`),
    `import type { APIRoute } from "astro";
import { og } from "../lib/og";

export const prerender = true;
export const GET = og.handler({ title: "Metaplate Astro smoke" }) satisfies APIRoute;
`,
  );
  writeFileSync(
    join(astroApp, "src", "pages", "index.astro"),
    `---
import { socialImageMetadata } from "metaplate";
const social = socialImageMetadata("/", "Metaplate Astro smoke card", {
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
</head><body>Metaplate Astro fixture</body></html>
`,
  );
  const astroCli = join(astroApp, "node_modules", "astro", "bin", "astro.mjs");
  try {
    execFileSync(process.execPath, [astroCli, "build"], {
      cwd: astroApp,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
    });
  } catch (error) {
    const details = error instanceof Error && "stderr" in error ? error.stderr : error;
    throw new Error(`Packed-package Astro static build failed: ${details}`, { cause: error });
  }
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
  runModule(
    `
      import { readFile } from "node:fs/promises";
      import { verifyImage } from "metaplate/image";
      const result = verifyImage(
        await readFile(${JSON.stringify(astroImage)}),
        ${cardSizeSource},
        "png",
      );
      if (result.format !== "png") throw new Error("Astro endpoint did not emit PNG bytes.");
    `,
    astroApp,
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
      import { fontsourceFontLoader } from "metaplate/fonts";
      import { verifyImage } from "metaplate/image";
      import { createNodeOg } from "metaplate/node";

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
        verifyImage(new Uint8Array(await response.arrayBuffer()), ${cardSizeSource}, "png");
      } finally {
        await new Promise((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()),
        );
      }
    `,
    expressApp,
  );

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
        const slug = new URL(request.url).pathname.split("/").pop()?.slice(0, 80) || "home";
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
          if (url.pathname.startsWith("/vercel/")) {
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
        for (const path of ["/vercel/packed", "/netlify/packed"]) {
          const result = await fetch(base + path);
          if (!result.ok) throw new Error(\`${"${path}"} returned \${result.status}.\`);
          if (result.headers.get("content-type") !== ${JSON.stringify(SOCIAL_CARD_FIXTURE.contentType)}) {
            throw new Error(\`${"${path}"} returned the wrong content type.\`);
          }
          if (result.headers.get("cache-control") !== "public, max-age=86400") {
            throw new Error(\`${"${path}"} returned the wrong cache policy.\`);
          }
          verifyImage(new Uint8Array(await result.arrayBuffer()), ${cardSizeSource}, "png");
        }
      } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    `,
    expressApp,
  );

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
  const routerCli = join(routerApp, "node_modules", "@react-router", "dev", "bin.js");
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
  `;
  runModule(standaloneSmoke, standalone);

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

  process.stdout.write(
    `Verified ${packed[0].filename} exports, CLI, and all consumer installs.\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
