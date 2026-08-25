import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const packages = lockfile.packages ?? {};

function packageName(path) {
  return path.replace(/^node_modules[\\/]/, "");
}

function hasInstallScript(entry) {
  return Boolean(
    entry?.scripts &&
      Object.keys(entry.scripts).some((script) =>
        ["preinstall", "install", "postinstall", "prepare"].includes(script),
      ),
  );
}

function isRemoteSpecifier(specifier) {
  return /^(?:git(?:\+|:)|https?:|ssh:)/i.test(specifier);
}

function isNative(name, entry) {
  return Boolean(
    /(?:resvg|sharp|swc|compiler-binding|wasm|napi|canvas|esbuild)/i.test(name) ||
      Object.keys(entry?.optionalDependencies ?? {}).some((dependency) =>
        /(?:resvg|sharp|swc|compiler-binding|wasm|napi|canvas|esbuild)/i.test(dependency),
      ),
  );
}

const direct = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);
const runtimePeers = Object.keys(manifest.peerDependencies ?? {});
const optionalPeers = Object.entries(manifest.peerDependenciesMeta ?? {})
  .filter(([, value]) => value.optional)
  .map(([name]) => name);
const lockPackages = Object.entries(packages)
  .filter(([name]) => name.startsWith("node_modules/"))
  .map(([path, entry]) => {
    const name = packageName(path);
    const packageManifestPath = join(root, path, "package.json");
    let installed;
    if (existsSync(packageManifestPath)) {
      installed = JSON.parse(readFileSync(packageManifestPath, "utf8"));
    }
    return {
      name,
      version: entry.version,
      direct: direct.has(name),
      runtimePeer: runtimePeers.includes(name),
      optionalPeer: optionalPeers.includes(name),
      native: isNative(name, entry),
      installScript: hasInstallScript(installed ?? entry),
      resolved: entry.resolved ?? null,
      remoteDependency: Object.values(entry.dependencies ?? {}).some(isRemoteSpecifier),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  package: {
    name: manifest.name,
    version: manifest.version,
    publishedFiles: manifest.files ?? [],
    regularDependencies: Object.keys(manifest.dependencies ?? {}),
    runtimePeers,
    optionalPeers,
    developmentDependencies: Object.keys(manifest.devDependencies ?? {}),
  },
  summary: {
    lockfilePackages: lockPackages.length,
    directPackages: lockPackages.filter((entry) => entry.direct).length,
    runtimePeers: lockPackages.filter((entry) => entry.runtimePeer).length,
    nativePackages: lockPackages.filter((entry) => entry.native).length,
    installScriptPackages: lockPackages.filter((entry) => entry.installScript).length,
    remoteDependencyPackages: lockPackages.filter((entry) => entry.remoteDependency).length,
  },
  controls: {
    lifecycleScriptsDisabledInCi: true,
    lockfileVersion: lockfile.lockfileVersion,
    registryOnlyExpected: true,
  },
  packages: lockPackages,
};

if (process.argv.includes("--summary")) {
  process.stdout.write(`${JSON.stringify({ ...report, packages: undefined }, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
