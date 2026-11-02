import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_FONT_FIXTURE, SOCIAL_CARD_FIXTURE } from "./package-fixtures.mjs";

export const EDGE_RENDERER_PEER = "@resvg/resvg-wasm";

/**
 * A module-resolution hook that fails any Node built-in import made by
 * `metaplate/edge` itself, plus a probe specifier proving the hook is active.
 */
const EDGE_IMPORT_GUARD = `
  import { isBuiltin } from "node:module";
  export async function resolve(specifier, context, next) {
    if (specifier === "metaplate-edge-guard:probe") {
      return { url: "data:text/javascript,export const active = true;", shortCircuit: true };
    }
    if (/\\/metaplate\\/dist\\/edge\\.js$/.test(context.parentURL ?? "") &&
        (specifier.startsWith("node:") || isBuiltin(specifier))) {
      throw new Error("metaplate/edge imported the Node built-in " + specifier);
    }
    return next(specifier, context);
  }
`;

function edgeEntrySource(directory, manifest) {
  return readFileSync(
    join(directory, "node_modules", manifest.name, manifest.exports["./edge"].import),
    "utf8",
  );
}

/**
 * Proves the packed `metaplate/edge` entry: the optional Wasm peer is absent
 * from the one-command install and named in its guidance, the built entry is
 * free of Node built-ins, CommonJS, and Satori's default build, and a consumer
 * holding the lockfile-verified `@resvg/resvg-wasm` renders a verified PNG
 * through `satori/standalone` from the two Wasm modules it supplies, after a
 * render without `satori/layout.wasm` fails with guidance naming it.
 */
export function verifyEdgeFixture({
  archive,
  consumer,
  temporary,
  manifest,
  lockfile,
  install,
  runModule,
  linkLockedDependency,
}) {
  const locked = lockfile.packages[`node_modules/${EDGE_RENDERER_PEER}`];
  if (!locked?.dev || manifest.peerDependenciesMeta?.[EDGE_RENDERER_PEER]?.optional !== true) {
    throw new Error(`${EDGE_RENDERER_PEER} must be an optional peer locked only as a dev dependency.`);
  }
  if (existsSync(join(consumer, "node_modules", ...EDGE_RENDERER_PEER.split("/")))) {
    throw new Error(`The one-command install pulled optional renderer peer ${EDGE_RENDERER_PEER}.`);
  }

  const source = edgeEntrySource(consumer, manifest);
  if (/\bnode:/.test(source) || /\brequire\(/.test(source)) {
    throw new Error("metaplate/edge unexpectedly imports a Node built-in or uses require().");
  }
  // Edge bundlers follow every dynamic import, so a reference to Satori's
  // default build would ship it beside satori/standalone.
  if (
    !source.includes('import("satori/standalone")') ||
    /\b(?:import\s*\(\s*|from\s*|import\s*)(["'`])satori\1/.test(source)
  ) {
    throw new Error("metaplate/edge must import satori/standalone and never Satori's default build.");
  }

  runModule(
    `
      const { createEdgeOg } = await import(${JSON.stringify(`${manifest.name}/edge`)});
      const plate = createEdgeOg({ component: () => null, alt: () => "card", fonts: () => [] });
      try {
        await plate.render({});
      } catch (error) {
        if (!error.message.includes(${JSON.stringify(`npm install ${EDGE_RENDERER_PEER}`)})) throw error;
        process.exit(0);
      }
      throw new Error("metaplate/edge rendered without its ${EDGE_RENDERER_PEER} peer.");
    `,
    consumer,
  );

  const edgeApp = join(temporary, "edge-app");
  install(edgeApp, [archive]);
  for (const dependency of [EDGE_RENDERER_PEER, PACKAGE_FONT_FIXTURE.package]) {
    linkLockedDependency(edgeApp, dependency);
  }

  runModule(
    `
      import { register } from "node:module";
      import { readFile } from "node:fs/promises";
      import { createRequire } from "node:module";

      register("data:text/javascript," + encodeURIComponent(${JSON.stringify(EDGE_IMPORT_GUARD)}));
      const { active } = await import("metaplate-edge-guard:probe");
      if (active !== true) throw new Error("The metaplate/edge import guard is not active.");

      const { createEdgeOg } = await import(${JSON.stringify(`${manifest.name}/edge`)});
      const { fontLoader } = await import(${JSON.stringify(`${manifest.name}/font-data`)});
      const { verifyImage } = await import(${JSON.stringify(`${manifest.name}/image`)});

      // The consumer, not metaplate/edge, reads the bytes: an edge runtime
      // would import or fetch them instead.
      const require = createRequire(import.meta.url);
      const bytes = (specifier) => readFile(require.resolve(specifier));
      const resvgWasm = await bytes(${JSON.stringify(`${EDGE_RENDERER_PEER}/index_bg.wasm`)});
      const layoutWasm = await bytes("satori/layout.wasm");
      const fonts = fontLoader([{
        name: ${JSON.stringify(PACKAGE_FONT_FIXTURE.name)},
        weight: ${PACKAGE_FONT_FIXTURE.weight},
        data: () => bytes(${JSON.stringify(`${PACKAGE_FONT_FIXTURE.package}/${PACKAGE_FONT_FIXTURE.file}`)}),
      }]);
      const size = { width: ${SOCIAL_CARD_FIXTURE.width}, height: ${SOCIAL_CARD_FIXTURE.height} };
      const definition = {
        alt: (copy) => copy.title + " social card",
        fonts,
        size,
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
              fontFamily: ${JSON.stringify(PACKAGE_FONT_FIXTURE.name)},
              fontSize: 64,
            },
            children: copy.title,
          },
        }),
      };

      // Without satori/layout.wasm there is nothing to lay out with: the
      // render fails with guidance naming the module and where to pass it.
      const unsupplied = createEdgeOg({ ...definition, resvg: { wasm: resvgWasm } });
      try {
        await unsupplied.render({ title: "No layout" });
        throw new Error("metaplate/edge rendered without satori/layout.wasm.");
      } catch (error) {
        if (
          !error.message.includes("satori/layout.wasm") ||
          !error.message.includes("layout.wasm to createEdgeOg or to initEdgeRenderer")
        ) {
          throw error;
        }
      }

      // Both Wasm modules supplied, as a Cloudflare Worker imports them; the
      // plate that failed renders too once the layout module exists.
      const plates = [
        createEdgeOg({ ...definition, resvg: { wasm: resvgWasm }, layout: { wasm: layoutWasm }, etag: true }),
        unsupplied,
      ];
      for (const [index, plate] of plates.entries()) {
        const response = await plate.fetchable({ title: "Metaplate edge smoke " + index }).fetch();
        const png = new Uint8Array(await response.arrayBuffer());
        const result = verifyImage(png, size, "png");
        if (
          response.headers.get("content-type") !== ${JSON.stringify(SOCIAL_CARD_FIXTURE.contentType)} ||
          response.headers.get("content-length") !== String(png.byteLength) ||
          result.width !== size.width ||
          result.height !== size.height
        ) {
          throw new Error("metaplate/edge served the wrong PNG representation.");
        }
        if (index === 0 && !/^"[0-9a-f]{64}"$/.test(response.headers.get("etag") ?? "")) {
          throw new Error("metaplate/edge did not compute a strong SHA-256 ETag.");
        }
      }
    `,
    edgeApp,
  );
}
