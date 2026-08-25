import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { createRequire } from "node:module";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = process.argv[2] ?? process.env.METAPLATE_PUBLISHED_VERSION;
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Usage: node scripts/verify-published-package.mjs <version>");
}

const packageSpec = `${sourceManifest.name}@${version}`;
const installSpec = process.env.METAPLATE_PACKAGE_SPEC ?? version;
const registryVerification = process.env.METAPLATE_PACKAGE_SPEC === undefined;
const consumer = mkdtempSync(join(tmpdir(), "metaplate-published-"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, {
    cwd: consumer,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    ...options,
  });
}

function runNpm(arguments_) {
  return run(npmCommand, arguments_);
}

try {
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { [sourceManifest.name]: installSpec },
    }),
  );
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact"]);

  const packageRoot = join(consumer, "node_modules", sourceManifest.name);
  const installed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(installed.version, version, `Registry install resolved ${installed.version}.`);

  const requireFromPackage = createRequire(join(packageRoot, "published-verifier.cjs"));
  for (const peer of ["satori", "@resvg/resvg-js", "react"]) {
    assert.doesNotThrow(
      () => requireFromPackage.resolve(peer),
      `Required renderer peer ${peer} is not resolvable from Metaplate.`,
    );
  }
  assert.throws(
    () => requireFromPackage.resolve("next"),
    /Cannot find module|MODULE_NOT_FOUND/,
    "The optional Next peer was installed unexpectedly.",
  );

  const entries = Object.keys(installed.exports).map((entry) =>
    entry === "." ? installed.name : `${installed.name}/${entry.slice(2)}`,
  );
  const runtimeSmoke = `
    import assert from "node:assert/strict";
    ${entries.map((entry) => `await import(${JSON.stringify(entry)});`).join("\n")}
    const core = await import(${JSON.stringify(installed.name)});
    const portable = await import(${JSON.stringify(`${installed.name}/font-data`)});
    assert.equal(
      core.socialImagePath("/guide", "card.png", "/docs", "https://example.com"),
      "https://example.com/docs/guide/card.png",
    );
    let calls = 0;
    const fonts = portable.fontLoader([{
      name: "Portable",
      weight: 400,
      data: () => { calls += 1; return Uint8Array.of(1, 2, 3); },
    }]);
    const first = await fonts();
    assert.equal(first, await fonts());
    assert.equal(calls, 1);
    assert.equal(first[0].data.byteLength, 3);
  `;
  run(process.execPath, ["--input-type=module", "--eval", runtimeSmoke]);

  const cliPath = join(packageRoot, installed.bin.metaplate);
  assert.equal(run(process.execPath, [cliPath, "--version"]).trim(), version);
  assert.match(run(process.execPath, [cliPath, "--help"]), /^Usage: metaplate verify/);

  if (registryVerification) {
    // npm verifies both registry signatures and provenance attestations for the
    // exact packages installed above. A missing or invalid signature exits nonzero.
    runNpm(["audit", "signatures"]);
    const predicate = runNpm([
      "view",
      packageSpec,
      "dist.attestations.provenance.predicateType",
    ]).trim();
    assert.equal(predicate, "https://slsa.dev/provenance/v1");
  }

  process.stdout.write(
    registryVerification
      ? `Verified ${packageSpec} registry install, ${entries.length} exports, peers, CLI, signatures, and provenance.\n`
      : `Verified local ${sourceManifest.name}@${version} artifact, ${entries.length} exports, peers, and CLI.\n`,
  );
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
