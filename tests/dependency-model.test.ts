import { describe, expect, it } from "vitest";
import { classifyLockPackages } from "../scripts/dependency-model.mjs";

function packageEntry(overrides: Record<string, unknown> = {}) {
  return { version: "1.0.0", ...overrides };
}

function classify(manifest: Record<string, unknown>, packages: Record<string, unknown>) {
  return classifyLockPackages({
    root: process.cwd(),
    manifest,
    lockfile: { lockfileVersion: 3, packages },
  });
}

describe("dependency reachability model", () => {
  it("preserves required and optional peer ancestry through every edge type", () => {
    const rows = classify({
      name: "metaplate",
      dependencies: {},
      peerDependencies: { requiredPeer: "1", optionalPeer: "1" },
      peerDependenciesMeta: { optionalPeer: { optional: true } },
      devDependencies: { devRoot: "1" },
    }, {
      "node_modules/requiredPeer": packageEntry({
        dependencies: { requiredChild: "1" },
        optionalDependencies: { requiredOptionalChild: "1" },
        peerDependencies: { requiredPeerChild: "1", optionalPeerChild: "1" },
        peerDependenciesMeta: { optionalPeerChild: { optional: true } },
      }),
      "node_modules/optionalPeer": packageEntry({
        dependencies: { optionalChild: "1" },
        optionalDependencies: { optionalOptionalChild: "1" },
        peerDependencies: { optionalPeerChild: "1" },
      }),
      "node_modules/requiredChild": packageEntry(),
      "node_modules/requiredOptionalChild": packageEntry({ optional: true }),
      "node_modules/requiredPeerChild": packageEntry(),
      "node_modules/optionalPeerChild": packageEntry(),
      "node_modules/optionalChild": packageEntry(),
      "node_modules/optionalOptionalChild": packageEntry({ optional: true }),
      "node_modules/devRoot": packageEntry({ dependencies: { devChild: "1", shared: "1" } }),
      "node_modules/devChild": packageEntry(),
      "node_modules/shared": packageEntry(),
    });
    const byName = (name: string) => rows.find((row) => row.name === name);

    expect(byName("requiredPeer")?.classification).toBe("runtime-peer");
    expect(byName("optionalPeer")?.classification).toBe("runtime-peer-optional");
    expect(byName("requiredChild")?.classification).toBe("runtime-peer");
    expect(byName("requiredOptionalChild")?.classification).toBe("runtime-peer-optional");
    expect(byName("requiredPeerChild")?.classification).toBe("runtime-peer");
    expect(byName("optionalPeerChild")?.classification).toBe("runtime-peer-optional");
    expect(byName("optionalChild")?.classification).toBe("runtime-peer-optional");
    expect(byName("optionalOptionalChild")?.classification).toBe("runtime-peer-optional");
    expect(byName("devChild")?.classification).toBe("development-only");
    expect(byName("shared")?.classification).toBe("development-only");
  });

  it("lets the strongest consumer path win deterministically", () => {
    const rows = classify({
      name: "metaplate",
      dependencies: { runtime: "1" },
      peerDependencies: { optionalPeer: "1" },
      peerDependenciesMeta: { optionalPeer: { optional: true } },
      devDependencies: { devRoot: "1" },
    }, {
      "node_modules/runtime": packageEntry({ dependencies: { shared: "1" } }),
      "node_modules/optionalPeer": packageEntry({ dependencies: { shared: "1" } }),
      "node_modules/devRoot": packageEntry({ dependencies: { shared: "1" } }),
      "node_modules/shared": packageEntry(),
    });
    expect(rows.find((row) => row.name === "shared")?.classification).toBe("published-runtime");
    expect(rows.find((row) => row.name === "shared")?.dependencyPaths).toEqual([
      "metaplate > devRoot > shared",
      "metaplate > optionalPeer > shared",
      "metaplate > runtime > shared",
    ]);
  });
});
