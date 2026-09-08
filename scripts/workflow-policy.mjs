import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { runScript } from "./run-script.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflowsDirectory = join(root, ".github", "workflows");

// GitHub Actions `uses:` references. Docker and local (`./`) actions are
// exempt from SHA pinning because they are not resolved through a mutable tag.
const USES_LINE = /^\s*(?:-\s+)?uses:\s*["']?([^\s"'#]+)["']?\s*(?:#\s*(\S+))?\s*$/;
const NPM_CI_LINE = /(?:^|\s)npm\s+ci(?:\s|$)/;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

export function listWorkflowFiles(directory = workflowsDirectory) {
  return readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => join(directory, name));
}

/**
 * Every third-party action must be pinned to a full commit SHA with a trailing
 * version comment so Dependabot can keep the two in sync.
 */
export function workflowPinErrors(source, label) {
  const errors = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const match = USES_LINE.exec(line);
    if (!match) continue;
    const [, reference, comment] = match;
    if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
    const at = reference.lastIndexOf("@");
    const pin = at === -1 ? "" : reference.slice(at + 1);
    if (!FULL_COMMIT_SHA.test(pin)) {
      errors.push(`${label}:${index + 1}: ${reference} is not pinned to a full commit SHA`);
    } else if (!comment || !/^v?\d/.test(comment)) {
      errors.push(`${label}:${index + 1}: ${reference} needs a trailing version comment`);
    }
  }
  return errors;
}

/** Every `npm ci` in CI must run with lifecycle scripts disabled. */
export function lifecycleScriptErrors(source, label) {
  const errors = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (NPM_CI_LINE.test(line) && !/--ignore-scripts/.test(line)) {
      errors.push(`${label}:${index + 1}: npm ci must pass --ignore-scripts`);
    }
  }
  return errors;
}

export function validateWorkflows(files = listWorkflowFiles()) {
  const errors = [];
  let installs = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const label = file.slice(root.length + 1).split("\\").join("/");
    errors.push(...workflowPinErrors(source, label), ...lifecycleScriptErrors(source, label));
    installs += source.split(/\r?\n/).filter((line) => NPM_CI_LINE.test(line)).length;
  }
  if (installs === 0) errors.push("no workflow installs dependencies with npm ci");
  return errors;
}

export function lifecycleScriptsDisabledInCi(files = listWorkflowFiles()) {
  return validateWorkflows(files).every((error) => !/npm ci|no workflow installs/.test(error));
}

function main() {
  const files = listWorkflowFiles();
  const errors = validateWorkflows(files);
  if (errors.length > 0) throw new Error(`Invalid workflow policy:\n- ${errors.join("\n- ")}`);
  process.stdout.write(`Verified workflow policy: ${files.length} workflows pinned with lifecycle scripts disabled.\n`);
}

runScript(main, import.meta.url);
