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

  it("preserves same-state paths and descendants while terminating cycles", () => {
    const rows = classify({
      name: "metaplate",
      dependencies: {},
      peerDependencies: { peerA: "1", peerB: "1", optionalA: "1", optionalB: "1" },
      peerDependenciesMeta: { optionalA: { optional: true }, optionalB: { optional: true } },
    }, {
      "node_modules/peerA": packageEntry({ dependencies: { shared: "1" } }),
      "node_modules/peerB": packageEntry({ dependencies: { shared: "1" } }),
      "node_modules/optionalA": packageEntry({ dependencies: { optionalShared: "1" } }),
      "node_modules/optionalB": packageEntry({ dependencies: { optionalShared: "1" } }),
      "node_modules/shared": packageEntry({ dependencies: { nested: "1" } }),
      "node_modules/nested": packageEntry({ dependencies: { shared: "1" } }),
      "node_modules/optionalShared": packageEntry({ dependencies: { optionalNested: "1" } }),
      "node_modules/optionalNested": packageEntry(),
    });
    const row = (name: string) => rows.find((entry) => entry.name === name);
    expect(row("shared")?.dependencyPaths).toEqual([
      "metaplate > peerA > shared",
      "metaplate > peerB > shared",
    ]);
    expect(row("nested")?.dependencyPaths).toEqual([
      "metaplate > peerA > shared > nested",
      "metaplate > peerB > shared > nested",
    ]);
    expect(row("optionalShared")?.dependencyPaths).toEqual([
      "metaplate > optionalA > optionalShared",
      "metaplate > optionalB > optionalShared",
    ]);
    expect(row("optionalShared")?.classification).toBe("runtime-peer-optional");
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
