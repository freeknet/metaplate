// Reads build state and logs from the Deno Deploy REST API
// (https://api.deno.com/v2/docs), authenticated with an organization access
// token (console: Settings > Access Tokens) in DENO_DEPLOY_TOKEN.
//
//   node scripts/deploy-api.mjs revisions            this app's latest builds
//   node scripts/deploy-api.mjs revision <revision>      one build's record
//   node scripts/deploy-api.mjs logs <revision> [step]   a build's log
//
// The token is only ever sent in the Authorization header, never printed.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { deployToken } from "./deploy-token.mjs";

const API = "https://api.deno.com/v2";
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { deploy } = JSON.parse(readFileSync(join(app, "deno.json"), "utf8"));

function token() {
  const value = deployToken();
  if (!value) throw new Error("Set DENO_DEPLOY_TOKEN to a Deno Deploy organization access token.");
  return value;
}

async function api(path, accept = "application/json") {
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token()}`, Accept: accept } });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
}

const [command, revision, step] = process.argv.slice(2);
if (command === "revisions") {
  const revisions = await (await api(`/apps/${deploy.app}/revisions?limit=10`)).json();
  for (const item of revisions) {
    process.stdout.write(`${item.id}  ${item.status}  ${item.created_at ?? ""}  ${item.failure_reason ?? ""}\n`);
  }
} else if (command === "revision" && revision) {
  // Environment variable values are left out; everything else is build state.
  const { env_vars: _env, ...record } = await (await api(`/revisions/${revision}`)).json();
  process.stdout.write(`${JSON.stringify(record, null, 2)}
`);
} else if (command === "logs" && revision) {
  const query = step ? `?step=${encodeURIComponent(step)}` : "";
  const response = await api(`/revisions/${revision}/build_logs${query}`, "application/x-ndjson");
  let buffer = "";
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const entry = JSON.parse(line);
      process.stdout.write(`[${entry.step ?? ""}] ${entry.level ?? ""} ${entry.message ?? line}\n`);
    }
  }
} else {
  process.stderr.write("Usage: node scripts/deploy-api.mjs revisions | logs <revision> [step]\n");
  process.exit(2);
}
