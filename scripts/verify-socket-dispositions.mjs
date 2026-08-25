import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const report = JSON.parse(readFileSync(join(root, "socket-dispositions.json"), "utf8"));

assert.equal(report.schemaVersion, 1);
assert.equal(report.package, "metaplate");
assert.match(report.source, /^https:\/\/socket\.dev\//);
assert.ok(Array.isArray(report.alerts));
assert.ok(report.releasePolicy.blockSeverities.includes("critical"));
assert.ok(report.releasePolicy.requireDispositionSeverities.includes("high"));

for (const alert of report.alerts) {
  assert.ok(alert.type && alert.severity && alert.package && alert.version);
  assert.ok(alert.path && alert.reachability && alert.disposition);
  assert.ok(alert.evidence && alert.verification);
  if (["high", "critical"].includes(alert.severity)) {
    assert.ok(
      ["upgrade", "replace", "remove", "isolate", "accepted-with-evidence"].includes(alert.disposition),
    );
    if (alert.disposition === "accepted-with-evidence") {
      assert.ok(alert.owner && alert.reason && alert.expiry);
    }
  }
}

if (report.status !== "complete") {
  assert.equal(report.alerts.length, 0, "incomplete reports must not contain partial alert dispositions");
}

process.stdout.write(`Verified Socket disposition report: ${report.alerts.length} alerts, status ${report.status}.\n`);
