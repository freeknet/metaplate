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

function install(directory, specifiers) {
  run(
    [
      "install",
      ...specifiers,
      "--prefix",
      directory,
      "--ignore-scripts",
      "--offline",
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

/** Links exactly the dependency tree npm ci verified from package-lock.json. */
function linkLockedDependency(directory, name) {
  const entry = lockfile.packages[`node_modules/${name}`];
  if (!entry?.version) throw new Error(`No locked version available for ${name}.`);
  const source = join(root, "node_modules", ...name.split("/"));
  const installed = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (installed.version !== entry.version) {
    throw new Error(
      `${name} installation ${installed.version} does not match lockfile ${entry.version}.`,
    );
  }
  const destination = join(directory, "node_modules", ...name.split("/"));
  mkdirSync(resolve(destination, ".."), { recursive: true });
  symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
}

/**
 * Turbopack requires `next` itself to physically live beneath its workspace,
 * unlike ordinary Node resolution where a junction is sufficient. Copy the
 * lockfile-verified package into the temporary workspace.
 */
function copyLockedDependency(directory, name) {
  const entry = lockfile.packages[`node_modules/${name}`];
  if (!entry?.version) throw new Error(`No locked version available for ${name}.`);
  const source = join(root, "node_modules", ...name.split("/"));
  const installed = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (installed.version !== entry.version) {
    throw new Error(
      `${name} installation ${installed.version} does not match lockfile ${entry.version}.`,
    );
  }
  const destination = join(directory, "node_modules", ...name.split("/"));
  mkdirSync(resolve(destination, ".."), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

/** Copies an installed, lockfile-verified runtime dependency closure offline. */
function copyLockedDependencyTree(directory, name, copied = new Set()) {
  if (copied.has(name)) return copied;
  copyLockedDependency(directory, name);
  copied.add(name);

  const source = join(root, "node_modules", ...name.split("/"));
  const installed = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
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

  // Shape one: metadata-only and Next.js consumers, which must never resolve
  // the standalone renderer or its native binaries.
  install(consumer, [archive]);

  for (const peer of ["satori", "@resvg/resvg-js", "next", "react"]) {
    if (existsSync(join(consumer, "node_modules", peer))) {
      throw new Error(`A lean install pulled the optional peer ${peer}.`);
    }
  }

  const smoke = `
    await import("metaplate");
    await import("metaplate/render");
    await import("metaplate/node");
    await import("metaplate/next");
    await import("metaplate/fonts");
    await import("metaplate/png");
    await import("metaplate/image");
  `;
  runModule(smoke, consumer);

  // Standalone entry points load without their peers; only rendering needs
  // them, and it has to say which package to install.
  const guidance = `
    const { createSvgOg } = await import("metaplate/render");
    const plate = createSvgOg({
      component: () => null,
      alt: () => "card",
      fonts: () => [],
    });

    try {
      await plate.renderSvg({});
    } catch (error) {
      if (!error.message.includes("npm install satori")) throw error;
      process.exit(0);
    }

    throw new Error("metaplate/render rendered without its satori peer.");
  `;
  runModule(guidance, consumer);

  const nextGuidance = `
    const { createNextOg } = await import("metaplate/next");
    const plate = createNextOg({ component: () => null, alt: () => "card" });

    try {
      await plate.render({});
    } catch (error) {
      if (!error.message.includes("npm install next")) throw error;
      process.exit(0);
    }

    throw new Error("metaplate/next rendered without its next peer.");
  `;
  runModule(nextGuidance, consumer);

  // The Next adapter must work in an actual static export, not merely in a
  // mocked response or a plain Node process (which cannot resolve Next's
  // extensionless `next/og` module). Install only the packed tarball, then
  // copy the exact local runtime closure `npm ci` already verified from the
  // lockfile. Turbopack deliberately does not follow dependencies linked
  // outside its workspace root.
  install(nextApp, [archive]);
  const copiedNextPackages = new Set();
  for (const dependency of ["next", "react", "react-dom"]) {
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
        { width: 1200, height: 630 },
        "png",
      );
      if (result.format !== "png" || result.width !== 1200 || result.height !== 630) {
        throw new Error("Next static export image dimensions or content type were incorrect.");
      }
    `,
    nextApp,
  );

  // Build an actual Astro static site from the packed artifact. This proves
  // the APIRoute handler contract, production bundling of the optional native
  // renderer boundary, emitted image path, bytes, dimensions, and page tags.
  install(astroApp, [archive]);
  for (const dependency of [
    "astro",
    "satori",
    "@resvg/resvg-js",
    "@fontsource/inter",
  ]) {
    linkLockedDependency(astroApp, dependency);
  }
  mkdirSync(join(astroApp, "src", "lib"), { recursive: true });
  mkdirSync(join(astroApp, "src", "pages"), { recursive: true });
  writeFileSync(join(astroApp, "astro.config.mjs"), "export default {};\n");
  writeFileSync(
    join(astroApp, "src", "lib", "og.ts"),
    `import { packageFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

export const og = createNodeOg({
  alt: (copy: { title: string }) => \`${"${copy.title}"} social card\`,
  fonts: packageFontLoader([{
    name: "Inter",
    package: "@fontsource/inter",
    file: "files/inter-latin-700-normal.woff",
    weight: 700,
  }]),
  imagePath: "og-image.png",
  origin: "https://example.com",
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
    join(astroApp, "src", "pages", "og-image.png.ts"),
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
  origin: "https://example.com",
  imagePath: "og-image.png",
  type: "image/png",
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
  const astroImage = join(astroApp, "dist", "og-image.png");
  const astroIndex = readFileSync(join(astroApp, "dist", "index.html"), "utf8");
  if (
    !astroIndex.includes('content="https://example.com/og-image.png"') ||
    !astroIndex.includes('content="1200"') ||
    !astroIndex.includes('content="630"') ||
    !astroIndex.includes('content="image/png"')
  ) {
    throw new Error("Astro static build did not emit the expected absolute social metadata.");
  }
  runModule(
    `
      import { readFile } from "node:fs/promises";
      import { verifyImage } from "metaplate/image";
      const result = verifyImage(
        await readFile(${JSON.stringify(astroImage)}),
        { width: 1200, height: 630 },
        "png",
      );
      if (result.format !== "png") throw new Error("Astro endpoint did not emit PNG bytes.");
    `,
    astroApp,
  );

  // Exercise the documented raw-byte bridge through a real Express 5 server,
  // including its async error boundary and externally observed headers.
  install(expressApp, [archive]);
  for (const dependency of [
    "express",
    "satori",
    "@resvg/resvg-js",
    "@fontsource/inter",
  ]) {
    linkLockedDependency(expressApp, dependency);
  }
  runModule(
    `
      import express from "express";
      import { packageFontLoader } from "metaplate/fonts";
      import { verifyImage } from "metaplate/image";
      import { createNodeOg } from "metaplate/node";

      const og = createNodeOg({
        alt: () => "Express smoke card",
        fonts: packageFontLoader([{
          name: "Inter",
          package: "@fontsource/inter",
          file: "files/inter-latin-700-normal.woff",
          weight: 700,
        }]),
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
      app.get("/og-image.png", async (_request, response, next) => {
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
        const response = await fetch(\`http://127.0.0.1:\${address.port}/og-image.png\`);
        if (!response.ok) throw new Error(\`Express returned \${response.status}.\`);
        if (response.headers.get("content-type") !== "image/png") {
          throw new Error("Express returned the wrong image content type.");
        }
        if (response.headers.get("cache-control") !== "public, max-age=86400") {
          throw new Error("Express returned the wrong cache policy.");
        }
        verifyImage(new Uint8Array(await response.arrayBuffer()), { width: 1200, height: 630 }, "png");
      } finally {
        await new Promise((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()),
        );
      }
    `,
    expressApp,
  );

  // Build and serve a current React Router framework-mode resource route.
  // This verifies its loader(args) convention and generated route types from
  // the tarball instead of treating it as an old Remix-style GET handler.
  install(routerApp, [archive]);
  const routerDependencies = [
    "@react-router/dev",
    "@react-router/node",
    "@react-router/serve",
    "@react-router/express",
    "react-router",
    "react",
    "react-dom",
    "express",
    "vite",
    "typescript",
    "@types/node",
    "@types/react",
    "satori",
    "@resvg/resvg-js",
    "@fontsource/inter",
    "isbot",
  ];
  for (const dependency of routerDependencies) {
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
          routerDependencies.map((dependency) => [
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
  route(":slug/og-image.png", "routes/og-image.ts"),
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
  origin: "https://example.com", imagePath: "og-image.png", type: "image/png",
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
    `import { packageFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";
export const og = createNodeOg({
  alt: (copy: { title: string }) => \`${"${copy.title}"} social card\`,
  fonts: packageFontLoader([{
    name: "Inter", package: "@fontsource/inter",
    file: "files/inter-latin-700-normal.woff", weight: 700,
  }]),
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
  execFileSync(process.execPath, [routerCli, "typegen"], { cwd: routerApp, stdio: "inherit" });
  const routerTsc = join(routerApp, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [routerTsc, "--noEmit"], { cwd: routerApp, stdio: "inherit" });
  execFileSync(process.execPath, [routerCli, "build"], {
    cwd: routerApp,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
        if (!html.includes("https://example.com/guide/og-image.png")) {
          throw new Error("React Router page did not emit absolute social metadata.");
        }
        const response = await fetch(base + "/guide/og-image.png");
        if (!response.ok || response.headers.get("content-type") !== "image/png") {
          throw new Error("React Router resource route returned the wrong status or content type.");
        }
        verifyImage(new Uint8Array(await response.arrayBuffer()), { width: 1200, height: 630 }, "png");
      } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    `,
    routerApp,
  );

  const nodeGuidance = `
    const { createNodeOg } = await import("metaplate/node");
    const plate = createNodeOg({
      component: () => null,
      alt: () => "card",
      fonts: () => [],
    });

    try {
      await plate.render({});
    } catch (error) {
      if (!error.message.includes("npm install satori @resvg/resvg-js")) throw error;
      process.exit(0);
    }

    throw new Error("metaplate/node rendered without its renderer peers.");
  `;
  runModule(nodeGuidance, consumer);

  const requireSmoke = `
    require.resolve("metaplate");
    require.resolve("metaplate/render");
    require.resolve("metaplate/node");
    require.resolve("metaplate/next");
    require.resolve("metaplate/fonts");
    require.resolve("metaplate/png");
    require.resolve("metaplate/image");
  `;
  execFileSync(
    process.execPath,
    ["--input-type=commonjs", "--eval", requireSmoke],
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
  for (const fixture of ["card.jpg", "icon.jpg", "card-lossy.webp"]) {
    copyFileSync(join(root, "tests", "fixtures", fixture), join(consumer, fixture));
  }

  const verified = spawnSync(
    process.execPath,
    [
      cliPath,
      "verify",
      "--size",
      "1200x630",
      "card.jpg",
      "card-lossy.webp",
      "--size",
      "512x512",
      "icon.jpg",
    ],
    { cwd: consumer, encoding: "utf8" },
  );
  const expected = [
    "✓ card.jpg 1200x630",
    "✓ card-lossy.webp 1200x630",
    "✓ icon.jpg 512x512",
  ];
  if (verified.status !== 0 || !expected.every((line) => verified.stdout.includes(line))) {
    throw new Error(
      `Installed CLI did not verify a mixed-format group: ${verified.stdout}${verified.stderr}`,
    );
  }

  const mismatch = spawnSync(
    process.execPath,
    [cliPath, "verify", "--size", "1200x630", "icon.jpg"],
    { cwd: consumer, encoding: "utf8" },
  );
  if (
    mismatch.status !== 1 ||
    !mismatch.stderr.includes("Expected 1200x630, received 512x512")
  ) {
    throw new Error("Installed CLI did not report a dimension mismatch.");
  }

  const formatCheck = spawnSync(
    process.execPath,
    [cliPath, "verify", "--format", "jpeg", "--size", "1200x630", "card-lossy.webp"],
    { cwd: consumer, encoding: "utf8" },
  );
  if (
    formatCheck.status !== 1 ||
    !formatCheck.stderr.includes("Expected jpeg 1200x630, received webp")
  ) {
    throw new Error("Installed CLI did not reject a format mismatch.");
  }

  // Issue #55: one bad file must not hide the rest. A truncated WebP plus a
  // good JPEG in one run has to report both outcomes in one invocation.
  const truncated = readFileSync(join(root, "tests", "fixtures", "card-lossy.webp")).subarray(
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
      "1200x630",
      "truncated.webp",
      "card.jpg",
      "does-not-exist.webp",
    ],
    { cwd: consumer, encoding: "utf8" },
  );
  const report = `${aggregate.stdout}${aggregate.stderr}`;
  if (
    aggregate.status !== 1 ||
    !report.includes("✓ card.jpg 1200x630") ||
    !report.includes("✗ truncated.webp") ||
    !report.includes("✗ does-not-exist.webp") ||
    !report.includes("2 of 3 files failed verification")
  ) {
    throw new Error(
      `Installed CLI did not aggregate failures across targets: ${report}`,
    );
  }

  // Shape two: the standalone consumer, which opts in to the renderer peers
  // and has to produce real PNG bytes from the packed tarball.
  install(standalone, [archive]);
  for (const dependency of [
    "satori",
    "@resvg/resvg-js",
    "@fontsource/inter",
    "typescript",
    "@types/node",
  ]) {
    linkLockedDependency(standalone, dependency);
  }

  const standaloneSmoke = `
    const { packageFontLoader } = await import("metaplate/fonts");
    const { createNodeOg } = await import("metaplate/node");
    const { verifyPng } = await import("metaplate/png");

    const plate = createNodeOg({
      alt: () => "card",
      fonts: packageFontLoader([
        {
          name: "Inter",
          package: "@fontsource/inter",
          file: "files/inter-latin-700-normal.woff",
          weight: 700,
        },
      ]),
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

  // Issue #59: the README promises plain `{ type, props }` authoring with no
  // React at all. Compile a TypeScript consumer against the packed package
  // with no React/@types/react installed and a plain-object component; the
  // type surface must carry it. `skipLibCheck` is deliberately off so that a
  // React dependency hiding in any declaration is a hard error rather than a
  // suppressed one.
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
  // consumer with no @types/node and no React types installed can load both
  // `metaplate/render` and `metaplate/node`, author a plain-object plate, and
  // use the public pixel/Resvg option shapes without installing Resvg yet.
  // Compile that second consumer here — only TypeScript and the renderer peer
  // installed, `skipLibCheck` off, so a hidden Node or React dependency in any
  // declaration is a hard error rather than a suppressed one.
  install(bare, [archive]);
  for (const dependency of ["satori", "typescript"]) {
    linkLockedDependency(bare, dependency);
  }

  // Make the smoke airtight: `types: []` stops TypeScript from auto-including
  // any @types package that might arrive transitively, and the explicit
  // absence checks fail the run if react, @types/react, or @types/node are
  // ever pulled in by the install (for example as a new peer).
  for (const forbidden of ["react", "@types/react", "@types/node"]) {
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
      fitTo: { mode: "width", value: 1200 },
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
      [{
        name: "Inter",
        package: "@fontsource/inter",
        file: "files/inter-latin-700-normal.woff",
        weight: 700,
      }],
      {
        resolvePackage: () =>
          requireFrom.resolve("@fontsource/inter/package.json").replace(
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
