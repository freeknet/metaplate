import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { REMOTE_SPECIFIER_PATTERN, classifyLockPackages } from "./dependency-model.mjs";
import { lifecycleScriptsDisabledInCi } from "./workflow-policy.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestSource = readFileSync(join(root, "package.json"));
const lockfileSource = readFileSync(join(root, "package-lock.json"));
const manifest = JSON.parse(manifestSource.toString("utf8"));
const lockfile = JSON.parse(lockfileSource.toString("utf8"));
const lockPackages = classifyLockPackages({ manifest, lockfile });
const REGISTRY = "https://registry.npmjs.org/";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
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
    platformBinary: lockPackages.filter((entry) => entry.platformBinary).length,
    binaryCandidates: lockPackages.filter((entry) => entry.binaryCandidate).length,
    unknown: lockPackages.filter((entry) => entry.classification === "unknown").length,
    nativePackages: lockPackages.filter((entry) => entry.native).length,
    installScriptPackages: lockPackages.filter((entry) => entry.installScript).length,
    remoteDependencyPackages: lockPackages.filter((entry) => entry.remoteDependency).length,
  },
  // Every control is observed, not asserted: a false value here fails
  // verify-dependency-inventory.mjs instead of being copied from a constant.
  controls: {
    lifecycleScriptsDisabledInCi: lifecycleScriptsDisabledInCi(),
    lockfileVersion: lockfile.lockfileVersion,
    lockfileInstallScriptField: Number(lockfile.lockfileVersion) >= 2,
    registryOnly: lockPackages.every(
      (entry) => typeof entry.resolved === "string" && entry.resolved.startsWith(REGISTRY),
    ),
    integrityComplete: lockPackages.every(
      (entry) => typeof entry.integrity === "string" && entry.integrity.startsWith("sha512-"),
    ),
    remoteSpecifierPattern: REMOTE_SPECIFIER_PATTERN.source,
    manifestSha256: sha256(manifestSource),
    lockfileSha256: sha256(lockfileSource),
  },
  packages: lockPackages,
};

if (process.argv.includes("--summary")) {
  process.stdout.write(`${JSON.stringify({ ...report, packages: undefined }, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
