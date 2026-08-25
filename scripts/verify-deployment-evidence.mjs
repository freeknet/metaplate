import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "deployment-evidence.json"), "utf8"));

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.release, "0.7.0");
assert.equal(manifest.policy.edgeNativeRendererRequired, true);
assert.ok(Array.isArray(manifest.routes) && manifest.routes.length > 0);

for (const route of manifest.routes) {
  assert.ok(route.id && route.provider && route.runtime && route.status);
  assert.ok(route.evidence);
  if (/edge/i.test(route.runtime) || route.id === "edge") {
    assert.notEqual(route.status, "certified");
    assert.match(route.reason ?? "", /native|Wasm|renderer/i);
  }
  if (/^https:\/\//.test(route.officialDocs ?? "")) {
    assert.match(route.officialDocs, /^https:\/\//);
  }
}

const certified = manifest.routes.filter((route) => route.status === "certified");
const localContracts = manifest.routes.filter((route) => route.status === "certified-local-contract");
assert.equal(certified.length, 0, "provider claims need real provider evidence before certification");

process.stdout.write(
  `Verified deployment evidence manifest: ${manifest.routes.length} routes, ${localContracts.length} local contracts, ${certified.length} provider-certified.\n`,
);
