import { readFileSync } from "node:fs";
import process from "node:process";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { classifyLockPackages } from "./dependency-model.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const lockPackages = classifyLockPackages({ root, manifest, lockfile });
const direct = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);
const runtimePeers = Object.keys(manifest.peerDependencies ?? {});
const optionalPeers = Object.entries(manifest.peerDependenciesMeta ?? {})
  .filter(([, value]) => value.optional)
  .map(([name]) => name);

const report = {
  schemaVersion: 2,
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
    directPackages: lockPackages.filter((entry) => direct.has(entry.name)).length,
    publishedRuntime: lockPackages.filter((entry) => entry.classification === "published-runtime").length,
    runtimePeers: lockPackages.filter((entry) => entry.classification === "runtime-peer").length,
    runtimePeerOptional: lockPackages.filter((entry) => entry.classification === "runtime-peer-optional").length,
    runtimeOptional: lockPackages.filter((entry) => entry.classification === "runtime-optional").length,
    developmentOnly: lockPackages.filter((entry) => entry.classification === "development-only").length,
    developmentOptional: lockPackages.filter((entry) => entry.classification === "development-optional").length,
    platformBinary: lockPackages.filter((entry) => entry.platformSpecific).length,
    unknown: lockPackages.filter((entry) => entry.classification === "unknown").length,
    nativePackages: lockPackages.filter((entry) => entry.native).length,
    installScriptPackages: lockPackages.filter((entry) => entry.installScript).length,
    remoteDependencyPackages: lockPackages.filter((entry) => entry.remoteDependency).length,
  },
  controls: {
    lifecycleScriptsDisabledInCi: true,
    lockfileVersion: lockfile.lockfileVersion,
    lockfileInstallScriptField: true,
    registryOnlyExpected: true,
    remoteSpecifierPattern: "git|http|https|ssh|file",
  },
  packages: lockPackages,
};

if (process.argv.includes("--summary")) {
  process.stdout.write(`${JSON.stringify({ ...report, packages: undefined }, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
