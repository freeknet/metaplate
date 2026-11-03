// Runs a pinned Deno from npm, so the fixture needs nothing installed globally.
//
//   node scripts/deno.mjs run -A main.ts     any Deno command
//   node scripts/deno.mjs login              sign in to Deno Deploy once
//   node scripts/deno.mjs create [--trace]   create the GitHub-built app
//
// `login` and `create` run Deno's built-in `deno deploy`, which keeps its
// sign-in in the system keyring: signing in opens the browser once, and later
// runs reuse the saved sign-in. A sign-in page expires after five minutes, so
// `login` opens a fresh one each time the last expires, until one is
// approved. The built-in command loads scripts/deploy-cli.ts in place of the
// CLI it would fetch (DENO_DEPLOY_CLI_SPECIFIER); that file pins the CLI
// version and works around Deno 2.9.6 passing the CLI its arguments twice.
//
// `create` makes an app that Deno Deploy builds from this repository's
// GitHub checkout, with this directory as the app directory. deno.json names
// the org and app and sets the build, which Deno Deploy reads on every build:
// install the repository root from its lockfile, build and pack metaplate
// into this directory (`npm run setup`), then run main.ts. Every push to the
// repository then deploys.
//
// Local uploads (`deno deploy` from a directory) are not used, so every
// deployment is built from a commit. They stalled when this was set up, a
// Deno-side regression fixed on 2026-11-02 (denoland/deploy_feedback#954).
import { execSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deployToken } from "./deploy-token.mjs";

const DENO = "deno@2.9.6";
const DEPLOY_CLI_VERSION = "0.0.9908";
const DEPLOY_CLI = `jsr:@deno/deploy@${DEPLOY_CLI_VERSION}`;
const DEPLOY_AUTH = `https://jsr.io/@deno/deploy/${DEPLOY_CLI_VERSION}/auth.ts`;

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(app, "../../..");
const [command, ...rest] = process.argv.slice(2);

function deno(args, cwd, env = {}) {
  const quote = (argument) =>
    process.platform === "win32" ? `"${argument.replaceAll('"', '\\"')}"` : `'${argument.replaceAll("'", "'\''")}'`;
  const result = spawnSync(`npx --yes ${DENO} ${args.map(quote).join(" ")}`, {
    cwd,
    env: { ...process.env, ...env },
    shell: true,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

// `deno deploy` resolves config next to the CLI entry it is given, so the
// wrapper runs from its own directory, away from this app's deno.json.
function deployCli(args, { trace = false, login = false } = {}) {
  const cliDir = mkdtempSync(join(tmpdir(), "metaplate-deploy-cli-"));
  const cliEntry = join(cliDir, "deploy-cli.ts");
  copyFileSync(join(app, "scripts", "deploy-cli.ts"), cliEntry);
  const token = login ? undefined : deployToken();
  return deno(["deploy", ...args], cliDir, {
    ...(token ? { DENO_DEPLOY_TOKEN: token } : {}),
    DENO_DEPLOY_CLI_SPECIFIER: pathToFileURL(cliEntry).href,
    METAPLATE_DEPLOY_CLI: DEPLOY_CLI,
    ...(trace ? { METAPLATE_DEPLOY_TRACE: "1" } : {}),
    ...(login ? { METAPLATE_DEPLOY_LOGIN: "1", METAPLATE_DEPLOY_AUTH: DEPLOY_AUTH } : {}),
  });
}

if (command === "login") {
  for (let attempt = 1; attempt <= 12; attempt++) {
    if (deployCli([], { login: true }) === 0) process.exit(0);
    process.stderr.write("Not signed in yet; opening a fresh sign-in page.\n");
  }
  process.exit(1);
}

if (command === "create") {
  // owner/repo of the GitHub repository this checkout pushes to.
  const remote = execSync("git remote get-url origin", { cwd: root, encoding: "utf8" }).trim();
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  if (!match) throw new Error(`origin is not a GitHub repository: ${remote}`);
  const { deploy } = JSON.parse(readFileSync(join(app, "deno.json"), "utf8"));
  process.exit(deployCli([
    "create", "--org", deploy.org, "--app", deploy.app,
    "--source", "github", "--owner", match[1], "--repo", match[2],
    "--app-directory", relative(root, app).replaceAll("\\", "/"),
    "--do-not-use-detected-build-config", "--install-command", deploy.install,
    "--runtime-mode", deploy.runtime.type, "--entrypoint", deploy.runtime.entrypoint,
    // Where the app runs: us, eu, or global. deno.json has no field for it.
    "--region", "global",
    ...rest.filter((argument) => argument !== "--trace"),
  ], { trace: rest.includes("--trace") }));
}

process.exit(deno([command, ...rest], app));
