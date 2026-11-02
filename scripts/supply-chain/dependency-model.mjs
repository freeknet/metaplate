const NATIVE_PATTERN = /(?:resvg|sharp|swc|compiler-binding|wasm|napi|canvas|esbuild)/i;

export function packageNameFromLockPath(lockPath) {
  const normalized = lockPath.replaceAll("\\", "/");
  const marker = normalized.lastIndexOf("node_modules/");
  if (marker === -1) return undefined;
  const remainder = normalized.slice(marker + "node_modules/".length);
  const parts = remainder.split("/");
  if (!parts[0]) return undefined;
  return parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function packageIdentityFromExample(example) {
  if (typeof example !== "string") return {};
  const value = example.replace(/^npm\//, "");
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return { package: value };
  return { package: value.slice(0, at), version: value.slice(at + 1) };
}

/**
 * Specifiers npm resolves outside the registry: git URLs and shorthands,
 * direct tarball URLs, and local files. Registry ranges, tags, and aliases
 * (`npm:name@range`) are not remote.
 */
export const REMOTE_SPECIFIER_PATTERN = /^(?:git(?:\+[a-z]+)?:|github:|gitlab:|bitbucket:|gist:|https?:|ssh:|file:)/i;

export function isRemoteSpecifier(specifier) {
  return typeof specifier === "string" && REMOTE_SPECIFIER_PATTERN.test(specifier);
}

function packagePathCandidates(parentPath, dependency) {
  const candidates = [];
  let base = parentPath;
  while (true) {
    candidates.push(`${base}/node_modules/${dependency}`);
    const marker = base.lastIndexOf("/node_modules/");
    if (marker === -1) {
      candidates.push(`node_modules/${dependency}`);
      break;
    }
    base = base.slice(0, marker);
  }
  return [...new Set(candidates)];
}

function resolveLockPackage(packages, parentPath, dependency) {
  for (const candidate of packagePathCandidates(parentPath, dependency)) {
    if (packages[candidate]) return candidate;
  }
  return undefined;
}

/**
 * npm's lockfile records `hasInstallScript` for every package whose
 * preinstall/install/postinstall would run. Reading installed manifests
 * instead would make the inventory depend on which optional platform
 * packages happen to be present on the machine that generated it.
 */
function packageHasInstallScript(entry) {
  return entry.hasInstallScript === true;
}

function nativeEvidence(name, entry) {
  const evidence = [];
  if (NATIVE_PATTERN.test(name)) evidence.push("known native/binary package naming");
  if (Object.keys(entry.optionalDependencies ?? {}).some((dependency) => NATIVE_PATTERN.test(dependency))) {
    evidence.push("native optional dependency metadata");
  }
  return evidence;
}

function binaryEvidence(name, entry) {
  const evidence = [...nativeEvidence(name, entry)];
  if (Array.isArray(entry.os) || Array.isArray(entry.cpu) || Array.isArray(entry.libc)) {
    evidence.push("lockfile platform constraints");
  }
  if (isPlatformSpecific(name)) evidence.push("platform-qualified package name");
  return evidence;
}

function isNative(name, entry) {
  return nativeEvidence(name, entry).length > 0;
}

function isPlatformSpecific(name) {
  return /(?:darwin|linux|win32|freebsd|openbsd|netbsd|sunos|aix|android|haiku|wasm32|arm64|x64|ia32|ppc64|s390x|riscv64|musl|gnu|msvc)/i.test(name);
}

function directDependencyKinds(manifest) {
  const kinds = new Map();
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    kinds.set(name, { origin: "published-runtime", optional: false });
  }
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    kinds.set(name, {
      origin: "runtime-peer",
      optional: manifest.peerDependenciesMeta?.[name]?.optional === true,
    });
  }
  for (const name of Object.keys(manifest.devDependencies ?? {})) {
    if (!kinds.has(name)) kinds.set(name, { origin: "development", optional: false });
  }
  return kinds;
}

export const REACHABILITY_RANK = Object.freeze({
  "development-optional": 0,
  "development-only": 1,
  "runtime-optional": 2,
  "runtime-peer-optional": 3,
  "runtime-peer": 4,
  "published-runtime": 5,
});

export function compareReachability(left, right) {
  return (REACHABILITY_RANK[left] ?? -1) - (REACHABILITY_RANK[right] ?? -1);
}

export function strongestReachability(values) {
  return [...values].sort((left, right) => compareReachability(right, left))[0];
}

function mergeState(current, next) {
  if (!current) return next;
  const currentRank = REACHABILITY_RANK[displayClassification(current)] ?? -1;
  const nextRank = REACHABILITY_RANK[displayClassification(next)] ?? -1;
  if (nextRank > currentRank) return next;
  if (nextRank < currentRank) return current;
  return { origin: current.origin, optional: current.optional && next.optional };
}

function displayClassification(state) {
  if (!state) return "unknown";
  if (state.origin === "published-runtime") return state.optional ? "runtime-optional" : "published-runtime";
  if (state.origin === "runtime-peer") return state.optional ? "runtime-peer-optional" : "runtime-peer";
  return state.optional ? "development-optional" : "development-only";
}

/**
 * Builds a useful reachability classification from npm's physical lock tree.
 * Runtime roots are regular dependencies and peers; development roots are only
 * used when a package is not already reachable from a runtime root.
 */
export function classifyLockPackages({ manifest, lockfile }) {
  const packages = lockfile.packages ?? {};
  const directKinds = directDependencyKinds(manifest);
  const classifications = new Map();
  const dependencyPaths = new Map();

  function walk(path, state, edgeOptional = false, lineage = "", ancestry = new Set()) {
    const nextState = { ...state, optional: state.optional || edgeOptional };
    if (ancestry.has(path)) return;
    const nextAncestry = new Set(ancestry).add(path);
    const entry = packages[path];
    if (!entry) return;

    const name = packageNameFromLockPath(path);
    const currentLineage = lineage || manifest.name;
    const currentPath = `${currentLineage} > ${name}`;
    if (name) {
      const paths = dependencyPaths.get(path) ?? new Set();
      paths.add(currentPath);
      dependencyPaths.set(path, paths);
    }

    const current = classifications.get(path);
    const merged = mergeState(current, { ...nextState, optional: nextState.optional || entry.optional === true });
    classifications.set(path, merged);

    for (const dependency of Object.keys(entry.dependencies ?? {})) {
      const child = resolveLockPackage(packages, path, dependency);
      if (child) walk(child, nextState, false, currentPath, nextAncestry);
    }
    for (const dependency of Object.keys(entry.optionalDependencies ?? {})) {
      const child = resolveLockPackage(packages, path, dependency);
      if (child) walk(child, nextState, true, currentPath, nextAncestry);
    }
    for (const dependency of Object.keys(entry.peerDependencies ?? {})) {
      const child = resolveLockPackage(packages, path, dependency);
      const optionalPeer = entry.peerDependenciesMeta?.[dependency]?.optional === true;
      if (child) walk(child, { ...nextState, optional: nextState.optional || optionalPeer }, false, currentPath, nextAncestry);
    }
  }

  for (const [name, kind] of directKinds) {
    const path = `node_modules/${name}`;
    if (!packages[path]) continue;
    walk(path, kind);
  }

  const rows = [];
  for (const [path, entry] of Object.entries(packages)) {
    if (!path.startsWith("node_modules/")) continue;
    const name = packageNameFromLockPath(path);
    if (!name) continue;
    const isDirect = path === `node_modules/${name}` && directKinds.has(name);
    const directKind = isDirect ? directKinds.get(name) : undefined;
    const classification = displayClassification(classifications.get(path));
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
      binaryCandidate: binaryEvidence(name, entry).length > 0,
      binaryEvidence: binaryEvidence(name, entry),
      platformSpecific: isPlatformSpecific(name),
      platformBinary: isPlatformSpecific(name) && binaryEvidence(name, entry).length > 0,
      installScript: packageHasInstallScript(entry),
      resolved: entry.resolved ?? null,
      integrity: entry.integrity ?? null,
      remoteDependency: Object.values(entry.dependencies ?? {}).some(isRemoteSpecifier),
      dependencyPaths: [...(dependencyPaths.get(path) ?? [])].sort(),
    });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
