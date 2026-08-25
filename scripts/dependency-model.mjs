import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const INSTALL_SCRIPTS = new Set(["preinstall", "install", "postinstall", "prepare"]);
const NATIVE_PATTERN = /(?:resvg|sharp|swc|compiler-binding|wasm|napi|canvas|esbuild)/i;

export function packageNameFromLockPath(lockPath) {
  const normalized = lockPath.replaceAll("\\\\", "/");
  const marker = normalized.lastIndexOf("node_modules/");
  if (marker === -1) return undefined;
  const remainder = normalized.slice(marker + "node_modules/".length);
  const parts = remainder.split("/");
  if (!parts[0]) return undefined;
  return parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function isRemoteSpecifier(specifier) {
  return /^(?:git(?:\\+|:)|https?:|ssh:|file:)/i.test(specifier);
}

function packagePathCandidates(parentPath, dependency) {
  const candidates = [];
  let base = parentPath;
  while (true) {
    candidates.push(`${base}/node_modules/${dependency}`);
    const marker = base.lastIndexOf("/node_modules/");
    if (marker >= 0) {
      base = base.slice(0, marker);
    } else if (base.startsWith("node_modules/")) {
      candidates.push(`node_modules/${dependency}`);
      break;
    } else {
      candidates.push(`node_modules/${dependency}`);
      break;
    }
  }
  return [...new Set(candidates)];
}

function resolveLockPackage(packages, parentPath, dependency) {
  for (const candidate of packagePathCandidates(parentPath, dependency)) {
    if (packages[candidate]) return candidate;
  }
  return undefined;
}

function packageHasInstallScript(root, lockPath, entry) {
  if (typeof entry.hasInstallScript === "boolean") return entry.hasInstallScript;
  const manifestPath = join(root, lockPath, "package.json");
  if (!existsSync(manifestPath)) return false;
  const installed = JSON.parse(readFileSync(manifestPath, "utf8"));
  return Object.keys(installed.scripts ?? {}).some((script) => INSTALL_SCRIPTS.has(script));
}

function isNative(name, entry) {
  return Boolean(
    NATIVE_PATTERN.test(name) ||
      Object.keys(entry.optionalDependencies ?? {}).some((dependency) => NATIVE_PATTERN.test(dependency)),
  );
}

function directDependencyKinds(manifest) {
  const kinds = new Map();
  for (const name of Object.keys(manifest.dependencies ?? {})) kinds.set(name, "dependency");
  for (const name of Object.keys(manifest.peerDependencies ?? {})) kinds.set(name, "runtime-peer");
  for (const name of Object.keys(manifest.devDependencies ?? {})) {
    if (!kinds.has(name)) kinds.set(name, "development");
  }
  return kinds;
}

/**
 * Builds a useful reachability classification from npm's physical lock tree.
 * Runtime roots are regular dependencies and peers; development roots are only
 * used when a package is not already reachable from a runtime root.
 */
export function classifyLockPackages({ root, manifest, lockfile }) {
  const packages = lockfile.packages ?? {};
  const directKinds = directDependencyKinds(manifest);
  const classifications = new Map();
  const visited = new Set();

  function walk(path, classification, edgeOptional = false) {
    const key = `${classification}:${path}:${edgeOptional}`;
    if (visited.has(key)) return;
    visited.add(key);
    const entry = packages[path];
    if (!entry) return;

    const optional = edgeOptional || entry.optional === true;
    const current = classifications.get(path);
    const effective = optional
      ? "optional-platform"
      : current === "published-runtime" || current === "runtime-peer"
        ? current
        : classification;
    if (!current || current === "development-only" || effective === "published-runtime" || effective === "runtime-peer") {
      classifications.set(path, effective);
    }

    for (const [dependency, specifier] of Object.entries(entry.dependencies ?? {})) {
      const child = resolveLockPackage(packages, path, dependency);
      if (child) {
        walk(child, classification === "runtime-peer" ? "published-runtime" : classification, false);
      } else if (isRemoteSpecifier(specifier)) {
        classifications.set(`${path}:${dependency}`, "unknown");
      }
    }
    for (const dependency of Object.keys(entry.optionalDependencies ?? {})) {
      const child = resolveLockPackage(packages, path, dependency);
      if (child) walk(child, "optional-platform", true);
    }
  }

  for (const [name, kind] of directKinds) {
    const path = `node_modules/${name}`;
    if (!packages[path]) continue;
    walk(path, kind === "runtime-peer" ? "runtime-peer" : kind === "dependency" ? "published-runtime" : "development-only");
  }

  const rows = [];
  for (const [path, entry] of Object.entries(packages)) {
    if (!path.startsWith("node_modules/")) continue;
    const name = packageNameFromLockPath(path);
    if (!name) continue;
    const isDirect = path === `node_modules/${name}` && directKinds.has(name);
    const directKind = isDirect ? directKinds.get(name) : undefined;
    const classification = classifications.get(path) ?? "unknown";
    rows.push({
      name,
      path,
      version: entry.version ?? null,
      direct: isDirect,
      directKind: directKind ?? null,
      classification,
      reachability: classification,
      dev: entry.dev === true,
      optional: entry.optional === true,
      devOptional: entry.devOptional === true,
      peer: entry.peer === true,
      native: isNative(name, entry),
      installScript: packageHasInstallScript(root, path, entry),
      resolved: entry.resolved ?? null,
      remoteDependency: Object.values(entry.dependencies ?? {}).some(isRemoteSpecifier),
    });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
