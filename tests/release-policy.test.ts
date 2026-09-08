import { describe, expect, it } from "vitest";
import { packageNameFromLockPath } from "../scripts/dependency-model.mjs";
import { validateDeploymentManifest } from "../scripts/verify-deployment-evidence.mjs";
import { validateSocketReport } from "../scripts/verify-socket-dispositions.mjs";
import { REQUIRED_ARTIFACTS, validateCheckResults } from "../scripts/release-evidence-report.mjs";
import { validateEvidenceBundle } from "../scripts/verify-evidence-bundle.mjs";
import { isRemoteSpecifier } from "../scripts/dependency-model.mjs";
import { lifecycleScriptErrors, workflowPinErrors } from "../scripts/workflow-policy.mjs";

const baseDeployment = {
  schemaVersion: 1,
  release: "0.7.0",
  status: "in-progress",
  policy: {
    certifiedRequires: [
      "packed-artifact",
      "production-build",
      "served-or-published-output",
      "image-format-and-dimension-check",
      "response-header-check",
    ],
    edgeNativeRendererRequired: true,
  },
  routes: [],
};

const certifiedRoute = {
  id: "provider-node",
  provider: "Example",
  runtime: "Node.js",
  status: "certified",
  evidence: "claim",
  certification: {
    packedArtifact: true,
    productionBuild: true,
    output: true,
    imageVerification: { verified: true },
    responseVerification: { verified: true },
    providerVersion: "1.0",
    runtimeVersion: "node-24",
    commitSha: "abc123",
    evidenceUrlOrArtifact: "artifact.zip",
  },
};

const baseSocket = {
  schemaVersion: 2,
  package: "metaplate",
  source: "https://socket.dev/npm/package/metaplate/alerts/0.6.0",
  version: "0.6.0",
  status: "complete",
  releasePolicy: {
    blockSeverities: ["critical"],
    requireDispositionSeverities: ["high", "critical"],
    allowedDispositionTypes: ["upgrade", "replace", "remove", "isolate", "accepted-with-evidence"],
    acceptedExceptionRequires: ["owner", "reason", "expiry", "verification"],
  },
  alerts: [],
  export: {
    artifact: "missing-score-report.json",
    generatedAt: "2026-08-25",
    sha256: "placeholder",
  },
};

describe("deployment evidence policy", () => {
  it("accepts a certified route only with complete evidence", () => {
    const errors = validateDeploymentManifest({
      ...baseDeployment,
      routes: [{
        id: "provider-node",
        provider: "Example",
        runtime: "Node.js",
        status: "certified",
        evidence: "release runner",
        certification: {
          packedArtifact: true,
          productionBuild: true,
          output: true,
          imageVerification: { verified: true },
          responseVerification: { verified: true },
          providerVersion: "1.0",
          runtimeVersion: "node-24",
          commitSha: "abc123",
          evidenceUrlOrArtifact: "artifact.zip",
        },
      }],
    });
    expect(errors).toEqual([]);
  });

  it("enforces newly declared policy requirements", () => {
    const errors = validateDeploymentManifest({
      ...baseDeployment,
      policy: {
        ...baseDeployment.policy,
        certifiedRequires: [...baseDeployment.policy.certifiedRequires, "custom-evidence"],
      },
      routes: [certifiedRoute],
    });
    expect(errors).toContain("policy.certifiedRequires contains unknown requirement custom-evidence");
  });

  it("rejects duplicate or missing policy requirements and unknown manifest status", () => {
    const duplicated = validateDeploymentManifest({
      ...baseDeployment,
      policy: {
        ...baseDeployment.policy,
        certifiedRequires: Array.from({ length: 5 }, () => "packed-artifact"),
      },
      routes: [{ ...certifiedRoute, certification: { ...certifiedRoute.certification, productionBuild: false } }],
    });
    expect(duplicated).toContain("policy.certifiedRequires contains duplicate requirements");
    expect(duplicated).toContain("policy.certifiedRequires is missing requirement production-build");
    expect(validateDeploymentManifest({ ...baseDeployment, status: "done", routes: [certifiedRoute] })).toContain("status must be in-progress or complete");
    expect(validateDeploymentManifest({
      ...baseDeployment,
      routes: [{ ...certifiedRoute, id: "workers", runtime: "Cloudflare Workers" }],
    })).toContain("workers: native edge runtime cannot be certified without an edge renderer");
    expect(validateDeploymentManifest({
      ...baseDeployment,
      routes: [{ ...certifiedRoute, id: "flagged", runtime: "Custom", edgeRuntime: true }],
    })).toContain("flagged: native edge runtime cannot be certified without an edge renderer");
  });

  it("rejects certified routes with missing evidence and unknown statuses", () => {
    const missing = validateDeploymentManifest({
      ...baseDeployment,
      routes: [{
        id: "provider-node",
        provider: "Example",
        runtime: "Node.js",
        status: "certified",
        evidence: "claim",
        certification: {},
      }],
    });
    expect(missing.some((error) => error.includes("packedArtifact"))).toBe(true);
    expect(validateDeploymentManifest({ ...baseDeployment, routes: [{ id: "x", provider: "x", runtime: "Node", status: "claimed" }] })).toContain("x: unknown status claimed");
  });
});

describe("Socket release policy", () => {
  const alert = (overrides: Record<string, unknown> = {}) => ({
    type: "malware",
    severity: "high",
    package: "example",
    version: "1.0.0",
    path: "metaplate > example",
    reachability: "development-only",
    evidence: "socket.json",
    verification: "npm test",
    disposition: "upgrade",
    ...overrides,
  });

  it("requires dispositions for policy severities and rejects unknown values", () => {
    expect(validateSocketReport({ ...baseSocket, alerts: [alert({ disposition: undefined })] })).toContain("alert 0: disposition required for high");
    expect(validateSocketReport({ ...baseSocket, alerts: [alert({ severity: "urgent" })] }).some((e: string) => e.includes("severity") && e.includes("urgent"))).toBe(true);
    expect(validateSocketReport({ ...baseSocket, alerts: [alert({ disposition: "ignore" })] }).some((error: string) => error.includes("disposition") && error.includes("ignore"))).toBe(true);
  });

  it("blocks critical findings even with a syntactically valid disposition", () => {
    const errors = validateSocketReport({ ...baseSocket, alerts: [alert({ severity: "critical", disposition: "upgrade" })] });
    expect(errors.some((error) => error.includes("critical findings block release"))).toBe(true);
  });

  it("rejects tampered release policy that weakens the executable policy", () => {
    // blockSeverities emptied
    expect(validateSocketReport({ ...baseSocket, releasePolicy: { ...baseSocket.releasePolicy, blockSeverities: [] } })).toContain("blockSeverities has 0 entries, expected 1");
    // blockSeverities changed to high
    expect(validateSocketReport({ ...baseSocket, releasePolicy: { ...baseSocket.releasePolicy, blockSeverities: ["high"] } })).toContain("blockSeverities entry high is not in the expected set");
    // requireDispositionSeverities weakened
    expect(validateSocketReport({ ...baseSocket, releasePolicy: { ...baseSocket.releasePolicy, requireDispositionSeverities: ["high"] } })).toContain("requireDispositionSeverities has 1 entries, expected 2");
    // allowedDispositionTypes extended with ignore
    expect(validateSocketReport({ ...baseSocket, releasePolicy: { ...baseSocket.releasePolicy, allowedDispositionTypes: [...baseSocket.releasePolicy.allowedDispositionTypes, "ignore"] } }).some((e: string) => e.includes("allowedDispositionTypes") && e.includes("6 entries"))).toBe(true);
    // acceptedExceptionRequires weakened
    expect(validateSocketReport({ ...baseSocket, releasePolicy: { ...baseSocket.releasePolicy, acceptedExceptionRequires: ["verification"] } })).toContain("acceptedExceptionRequires has 1 entries, expected 4");
    // missing entirely
    expect(validateSocketReport({ ...baseSocket, releasePolicy: undefined })).toContain("releasePolicy is missing");
  });

  it("critical findings cannot be made releasable by editing blockSeverities", () => {
    // Even with empty blockSeverities, critical should still be checked against pinned policy
    const report = { ...baseSocket, releasePolicy: { ...baseSocket.releasePolicy, blockSeverities: [] } };
    const errors = validateSocketReport(report);
    expect(errors.some((e) => e.includes("blockSeverities"))).toBe(true);
  });

  it("rejects expired accepted exceptions", () => {
    const accepted = alert({
      disposition: "accepted-with-evidence",
      owner: "security",
      reason: "upstream fix pending",
      expiry: "2020-01-01T00:00:00Z",
      verification: "isolated in CI",
    });
    expect(validateSocketReport({ ...baseSocket, alerts: [accepted] }).some((error: string) => error.includes("accepted exception is expired"))).toBe(true);
  });
});

describe("release evidence consistency", () => {
  it("marks deployment policy errors as blocking", () => {
    const invalid = { ...baseDeployment, routes: [{ id: "bad", provider: "x", runtime: "Node", status: "claimed", evidence: "x" }] };
    expect(validateDeploymentManifest(invalid).length).toBeGreaterThan(0);
  });
});

const REQUIRED_CHECK_NAMES = [
  "production-build",
  "packed-artifact",
  "dependency-inventory",
  "deployment-evidence-policy",
  "socket-release-policy",
  "workflow-policy",
];

describe("release check evidence", () => {
  const checks = REQUIRED_CHECK_NAMES.map((name) => ({ name, status: "passed" }));

  it("requires every expected check exactly once and passed", () => {
    expect(validateCheckResults({ schemaVersion: 1, commitSha: "abc", releaseVersion: "0.6.0", checks }, { commitSha: "abc", releaseVersion: "0.6.0" })).toEqual(checks);
  });

  it("rejects incomplete, duplicate, unknown, and non-passed check sets", () => {
    const cases = [
      [],
      checks.slice(1),
      [...checks, checks[0]!],
      [...checks.slice(0, 5), { name: "unknown", status: "passed" }],
      [...checks.slice(0, 5), { name: "workflow-policy", status: "unknown" }],
    ];
    for (const invalidChecks of cases) {
      expect(() => validateCheckResults({ schemaVersion: 1, commitSha: "abc", releaseVersion: "0.6.0", checks: invalidChecks }, { commitSha: "abc", releaseVersion: "0.6.0" })).toThrow();
    }
  });
});

describe("retained evidence bundle", () => {
  const digest = (file: string) => (REQUIRED_ARTIFACTS.includes(file) ? "a".repeat(64) : undefined);
  const report = {
    schemaVersion: 1,
    verificationStatus: "passed",
    commitSha: "abc",
    releaseVersion: "0.6.0",
    checks: REQUIRED_CHECK_NAMES.map((name) => ({ name, status: "passed" })),
    artifacts: REQUIRED_ARTIFACTS.map((file) => ({ file, sha256: "a".repeat(64) })),
  };
  const context = { commitSha: "abc", releaseVersion: "0.6.0", digest };

  it("accepts a passed report whose artifacts all hash correctly", () => {
    expect(validateEvidenceBundle(report, context)).toEqual([]);
  });

  it("rejects failed, foreign, incomplete, or tampered bundles", () => {
    expect(validateEvidenceBundle({ ...report, verificationStatus: "failed" }, context)).toContain("release-evidence-report.json verificationStatus is failed, not passed");
    expect(validateEvidenceBundle(report, { ...context, commitSha: "other" })).toContain("release-evidence-report.json commitSha abc does not match other");
    expect(validateEvidenceBundle({ ...report, artifacts: report.artifacts.slice(1) }, context)).toContain(`release evidence does not retain ${REQUIRED_ARTIFACTS[0]}`);
    expect(validateEvidenceBundle({ ...report, checks: report.checks.slice(1) }, context)).toContain(`release-evidence-report.json is missing the ${REQUIRED_CHECK_NAMES[0]} check`);
    expect(validateEvidenceBundle(report, { ...context, digest: () => "b".repeat(64) })).toContain(`${REQUIRED_ARTIFACTS[0]} is missing or does not match its recorded SHA-256`);
  });
});

describe("remote dependency specifiers", () => {
  it("recognizes git, hosted shorthand, URL, and file specifiers", () => {
    for (const specifier of ["git+https://github.com/a/b.git", "git+ssh://git@github.com/a/b.git", "git://host/a.git", "github:a/b", "https://example.com/a.tgz", "file:../a", "ssh://git@host/a.git"]) {
      expect(isRemoteSpecifier(specifier), specifier).toBe(true);
    }
    for (const specifier of ["^1.0.0", "latest", "npm:react@^19", "workspace:*", "1.x", undefined]) {
      expect(isRemoteSpecifier(specifier), String(specifier)).toBe(false);
    }
  });
});

describe("workflow policy", () => {
  it("requires full-SHA pins with version comments and script-free installs", () => {
    const pinned = "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - run: npm ci --ignore-scripts\n";
    expect(workflowPinErrors(pinned, "ci.yml")).toEqual([]);
    expect(lifecycleScriptErrors(pinned, "ci.yml")).toEqual([]);
    expect(workflowPinErrors("      - uses: actions/checkout@v7\n", "ci.yml")).toEqual(["ci.yml:1: actions/checkout@v7 is not pinned to a full commit SHA"]);
    expect(workflowPinErrors("      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n", "ci.yml")).toEqual(["ci.yml:1: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 needs a trailing version comment"]);
    expect(workflowPinErrors("      - uses: ./.github/actions/local\n", "ci.yml")).toEqual([]);
    expect(lifecycleScriptErrors("      - run: npm ci\n", "ci.yml")).toEqual(["ci.yml:1: npm ci must pass --ignore-scripts"]);
  });
});

describe("lockfile package identity", () => {
  it("extracts the innermost package from nested unscoped and scoped paths", () => {
    expect(packageNameFromLockPath("node_modules/@babel/core/node_modules/semver")).toBe("semver");
    expect(packageNameFromLockPath("node_modules/@react-router/dev/node_modules/confbox")).toBe("confbox");
    expect(packageNameFromLockPath("node_modules/@react-router/dev/node_modules/pkg-types/node_modules/pathe")).toBe("pathe");
    expect(packageNameFromLockPath("node_modules/@scope/package")).toBe("@scope/package");
  });
});
