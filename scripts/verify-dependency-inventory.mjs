import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageSource = readFileSync(join(root, "package.json"));
const lockfileSource = readFileSync(join(root, "package-lock.json"));
const packageJson = JSON.parse(packageSource.toString("utf8"));
const lockfile = JSON.parse(lockfileSource.toString("utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const output = execFileSync(process.execPath, [join(root, "scripts/dependency-inventory.mjs")], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
const report = JSON.parse(output);

assert.equal(report.schemaVersion, 2);
assert.equal(report.summary.unknown, 0, "release inventory must not contain unexplained unknown packages");
assert.equal(report.package.name, packageJson.name);
assert.equal(report.package.version, packageJson.version);
assert.equal(report.controls.lockfileVersion, lockfile.lockfileVersion);
assert.equal(report.controls.lockfileInstallScriptField, true, "lockfile must record hasInstallScript");
assert.equal(report.controls.lifecycleScriptsDisabledInCi, true, "every CI npm ci must pass --ignore-scripts");
assert.equal(report.controls.registryOnly, true, "every lockfile package must resolve to the npm registry");
assert.equal(report.controls.integrityComplete, true, "every lockfile package must carry a sha512 integrity");
assert.equal(report.controls.manifestSha256, sha256(packageSource));
assert.equal(report.controls.lockfileSha256, sha256(lockfileSource));
assert.equal(report.summary.remoteDependencyPackages, 0, "no package may declare a git, URL, or file dependency");
for (const name of Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies, ...packageJson.peerDependencies })) {
  assert.ok(report.packages.some((entry) => entry.direct && entry.name === name), `direct dependency ${name} is missing from the lockfile`);
}
assert.deepEqual(
  [...report.package.runtimePeers].sort(),
  Object.keys(packageJson.peerDependencies).sort(),
);
assert.ok(report.packages.length > 0);
assert.ok(report.packages.some((entry) => entry.name === "@resvg/resvg-js" && entry.classification === "runtime-peer" && entry.native));
assert.equal(report.summary.publishedRuntime, 0);
assert.ok(report.packages.some((entry) => entry.name === "next" && entry.direct && entry.classification === "runtime-peer-optional"));
assert.ok(report.packages.some((entry) => entry.name === "esbuild" && entry.installScript === true));
assert.ok(report.packages.some((entry) => entry.name === "fsevents" && entry.optional === true && entry.installScript === true));
assert.ok(report.summary.platformBinary > 0);
assert.ok(report.summary.binaryCandidates >= report.summary.platformBinary);
assert.ok(report.packages.some((entry) => entry.platformSpecific === true && entry.native === true));
assert.ok(report.packages.some((entry) => entry.classification === "development-only"));
assert.ok(report.packages.some((entry) => entry.classification === "runtime-peer-optional" || entry.classification === "runtime-optional" || entry.classification === "development-optional"));
assert.ok(report.packages.every((entry) => entry.version));
assert.ok(report.packages.every((entry) => !entry.path.includes("node_modules/node_modules/")));
assert.ok(
  report.packages.every((entry) => typeof entry.resolved === "string" && entry.resolved.startsWith("https://registry.npmjs.org/")),
  "lockfile inventory must identify non-registry resolutions",
);

process.stdout.write(
  `Verified dependency inventory: ${report.summary.lockfilePackages} lockfile packages, ${report.summary.publishedRuntime} published-runtime, ${report.summary.nativePackages} native candidates.\n`,
);
