// The Deno Deploy organization access token, from DENO_DEPLOY_TOKEN. On
// Windows a user environment variable saved after this shell started is read
// from the user environment. Returns undefined when there is none. Callers
// only pass the token on (an Authorization header, a child environment) and
// never print it.
import { execFileSync } from "node:child_process";
import process from "node:process";

export function deployToken() {
  if (process.env.DENO_DEPLOY_TOKEN) return process.env.DENO_DEPLOY_TOKEN;
  if (process.platform !== "win32") return undefined;
  const saved = execFileSync("powershell.exe", [
    "-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('DENO_DEPLOY_TOKEN','User')",
  ], { encoding: "utf8" }).trim();
  return saved || undefined;
}
