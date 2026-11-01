// Prepares a clean consumer project for the runtime smoke from the packed
// tarball, so Bun and Deno are certified against exactly what npm users
// install rather than against this checkout's dist/.
//
//   npm run build
//   node scripts/prepare-runtime-consumer.mjs <consumer-dir>
//
// The consumer gets the tarball as its only metaplate source, the renderer
// peers and the font package at the exact versions in package-lock.json, and
// a copy of scripts/verify-runtime.mjs. It prints a JSON summary (tarball
// name, SHA-256, package version, consumer path) and writes the same summary
// to runtime-consumer.json inside the consumer.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (!target) {
  process.stderr.write("Usage: node scripts/prepare-runtime-consumer.mjs <consumer-dir>\n");
  process.exit(2);
}
const consumer = resolve(target);

/** The packages the smoke loads besides metaplate itself, pinned to the lockfile. */
const LOCKED_DEPENDENCIES = ["@resvg/resvg-js", "satori", "react", "@fontsource/inter"];

/** Quotes one argument for the platform shell that resolves the npm shim. */
function quote(argument) {
  return process.platform === "win32" ? `"${argument.replaceAll('"', '\\"')}"` : `'${argument.replaceAll("'", "'\\''")}'`;
}

function npm(args, cwd) {
  // One command string through the shell finds npm's .cmd shim on Windows
  // and the npm script elsewhere, without Node's args-plus-shell warning.
  const result = spawnSync(`npm ${args.map(quote).join(" ")}`, {
    cwd,
    encoding: "utf8",
    shell: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed with status ${result.status}`);
  }
  return result.stdout;
}

if (!existsSync(join(root, "dist", "index.js"))) {
  throw new Error("dist/ is missing; run `npm run build` before preparing the runtime consumer.");
}

rmSync(consumer, { recursive: true, force: true });
mkdirSync(consumer, { recursive: true });

const [packed] = JSON.parse(npm(["pack", "--json", "--pack-destination", consumer], root));
const tarball = join(consumer, packed.filename);
const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");

const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const dependencies = { metaplate: `file:./${packed.filename}` };
for (const name of LOCKED_DEPENDENCIES) {
  const version = lockfile.packages[`node_modules/${name}`]?.version;
  if (!version) throw new Error(`package-lock.json has no locked version of ${name}`);
  dependencies[name] = version;
}

writeFileSync(
  join(consumer, "package.json"),
  `${JSON.stringify({ name: "metaplate-runtime-consumer", private: true, type: "module", dependencies }, null, 2)}\n`,
);
// Lifecycle scripts stay disabled, as in every other install this repository
// runs; Resvg's platform binary arrives as an optional dependency, not a script.
npm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
copyFileSync(join(root, "scripts", "verify-runtime.mjs"), join(consumer, "verify-runtime.mjs"));

const summary = {
  consumer,
  tarball: packed.filename,
  sha256,
  version: packed.version,
  files: packed.entryCount,
  dependencies,
};
writeFileSync(join(consumer, "runtime-consumer.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
