import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { runScript } from "./run-script.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;

const requiredSections = [
  "Why upgrade",
  "Highlights",
  "Breaking changes",
  "Install or upgrade",
  "Verification",
  "Documentation and support",
  "Full changelog",
];

export function validateReleaseNotes(body, version) {
  const errors = [];
  const expectedTitle = `# Metaplate v${version}`;
  if (body.split(/\r?\n/, 1)[0] !== expectedTitle) {
    errors.push(`first line must be: ${expectedTitle}`);
  }

  let previousOffset = -1;
  for (const section of requiredSections) {
    const heading = `## ${section}`;
    const offset = body.indexOf(heading);
    if (offset === -1) errors.push(`missing required section: ${heading}`);
    else if (offset <= previousOffset) errors.push(`section is out of order: ${heading}`);
    else previousOffset = offset;
  }

  if (body.length < 1_000) errors.push("release notes must contain at least 1,000 characters");
  if (/\b(?:TODO|TBD|CHANGEME)\b|vX\.Y\.Z|vPREVIOUS/i.test(body)) {
    errors.push("release notes still contain template placeholders");
  }
  if (!body.includes(`npm install metaplate@${version}`)) {
    errors.push(`install section must pin metaplate@${version}`);
  }
  if (
    version !== "0.1.0" &&
    (!body.includes(`/compare/`) || !body.includes(`...v${version}`))
  ) {
    errors.push("full changelog must link a comparison ending at this version");
  }
  if (/^## What's Changed\s*$/m.test(body) && body.indexOf("## What's Changed") < 200) {
    errors.push("release notes must lead with user highlights, not GitHub's generated list");
  }

  return errors;
}

function main() {
  const [fileArgument, versionArgument] = process.argv.slice(2);
  const version = versionArgument ?? packageVersion;
  const file = resolve(root, fileArgument ?? `.github/releases/v${version}.md`);
  if (!existsSync(file)) {
    throw new Error(`Missing release notes for v${version}: ${file}`);
  }
  const errors = validateReleaseNotes(readFileSync(file, "utf8"), version);
  if (errors.length > 0) {
    throw new Error(`Invalid release notes for v${version}:\n- ${errors.join("\n- ")}`);
  }
  process.stdout.write(`Release notes for v${version} are complete: ${file}\n`);
}

runScript(main, import.meta.url);
