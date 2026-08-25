import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runScript } from "./run-script.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowedStatuses = new Set([
  "documented",
  "documented-recipe",
  "certified-local-contract",
  "certified",
  "not-supported",
]);
const evidenceFieldByRequirement = new Map([
  ["packed-artifact", "packedArtifact"],
  ["production-build", "productionBuild"],
  ["served-or-published-output", "output"],
  ["image-format-and-dimension-check", "imageVerification"],
  ["page-metadata-check", "metadataVerification"],
]);
const requiredCertificationFields = [
  "packedArtifact",
  "productionBuild",
  "output",
  "imageVerification",
  "metadataVerification",
  "providerVersion",
  "runtimeVersion",
  "commitSha",
  "evidenceUrlOrArtifact",
];

function present(value) {
  return value !== undefined && value !== null && value !== "" && value !== false;
}

export function validateDeploymentManifest(manifest) {
  const errors = [];
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!Array.isArray(manifest.policy?.certifiedRequires) || manifest.policy.certifiedRequires.length < 5) {
    errors.push("policy.certifiedRequires must declare the certification evidence requirements");
  } else {
    for (const requirement of manifest.policy.certifiedRequires) {
      if (!evidenceFieldByRequirement.has(requirement)) {
        errors.push(`policy.certifiedRequires contains unknown requirement ${requirement}`);
      }
    }
  }
  if (manifest.release !== "0.7.0") errors.push("release must be 0.7.0");
  if (manifest.policy?.edgeNativeRendererRequired !== true) {
    errors.push("edgeNativeRendererRequired must be true");
  }
  if (!Array.isArray(manifest.routes) || manifest.routes.length === 0) {
    errors.push("routes must be a non-empty array");
    return errors;
  }

  for (const route of manifest.routes) {
    if (!route || !route.id || !route.provider || !route.runtime || !route.status) {
      errors.push("every route requires id, provider, runtime, and status");
      continue;
    }
    if (!allowedStatuses.has(route.status)) errors.push(`${route.id}: unknown status ${route.status}`);
    if (!present(route.evidence)) errors.push(`${route.id}: evidence is required`);
    if ((/edge/i.test(route.runtime) || route.id === "edge") && route.status === "certified") {
      errors.push(`${route.id}: native edge runtime cannot be certified without an edge renderer`);
    }
    if (route.status === "not-supported" && !present(route.reason)) {
      errors.push(`${route.id}: not-supported routes require a reason`);
    }
    if (route.officialDocs !== undefined && !/^https:\/\//.test(route.officialDocs)) {
      errors.push(`${route.id}: officialDocs must be an HTTPS URL`);
    }
    if (route.status === "certified") {
      if (!route.certification || typeof route.certification !== "object") {
        errors.push(`${route.id}: certified routes require a certification object`);
      } else {
        for (const requirement of manifest.policy.certifiedRequires) {
          const field = evidenceFieldByRequirement.get(requirement);
          if (field && !present(route.certification[field])) {
            errors.push(`${route.id}: certification.${field} is required by ${requirement}`);
          }
        }
        for (const field of requiredCertificationFields.slice(5)) {
          if (!present(route.certification[field])) {
            errors.push(`${route.id}: certification.${field} is required`);
          }
        }
        if (route.certification.imageVerification?.verified !== true) {
          errors.push(`${route.id}: imageVerification.verified must be true`);
        }
        if (route.certification.metadataVerification?.verified !== true) {
          errors.push(`${route.id}: metadataVerification.verified must be true`);
        }
      }
    }
  }
  return errors;
}

export function loadManifest(file = join(root, "deployment-evidence.json")) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function main() {
  const manifest = loadManifest(process.argv[2]);
  const errors = validateDeploymentManifest(manifest);
  if (errors.length > 0) throw new Error(`Invalid deployment evidence manifest:\n- ${errors.join("\n- ")}`);
  const certified = manifest.routes.filter((route) => route.status === "certified");
  const localContracts = manifest.routes.filter((route) => route.status === "certified-local-contract");
  process.stdout.write(
    `Verified deployment evidence manifest: ${manifest.routes.length} routes, ${localContracts.length} local contracts, ${certified.length} provider-certified.\n`,
  );
}

runScript(main, import.meta.url);
