import { describe, expect, it } from "vitest";
import { packageNameFromLockPath } from "../scripts/dependency-model.mjs";
import { validateDeploymentManifest } from "../scripts/verify-deployment-evidence.mjs";
import { validateSocketReport } from "../scripts/verify-socket-dispositions.mjs";

const baseDeployment = {
  schemaVersion: 1,
  release: "0.7.0",
  policy: {
    certifiedRequires: [
      "packed-artifact",
      "production-build",
      "served-or-published-output",
      "image-format-and-dimension-check",
      "page-metadata-check",
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
    metadataVerification: { verified: true },
    providerVersion: "1.0",
    runtimeVersion: "node-24",
    commitSha: "abc123",
    evidenceUrlOrArtifact: "artifact.zip",
  },
};

const baseSocket = {
  schemaVersion: 1,
  package: "metaplate",
  source: "https://socket.dev/npm/package/metaplate/alerts/0.6.0",
  status: "complete",
  releasePolicy: {
    blockSeverities: ["critical"],
    requireDispositionSeverities: ["high", "critical"],
    allowedDispositionTypes: ["upgrade", "replace", "remove", "isolate", "accepted-with-evidence"],
    acceptedExceptionRequires: ["owner", "reason", "expiry", "verification"],
  },
  alerts: [],
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
          metadataVerification: { verified: true },
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
    expect(validateSocketReport({ ...baseSocket, alerts: [alert({ severity: "urgent" })] })).toContain("alert 0: unknown severity urgent");
    expect(validateSocketReport({ ...baseSocket, alerts: [alert({ disposition: "ignore" })] }).some((error: string) => error.includes("disposition is not allowed"))).toBe(true);
  });

  it("blocks critical findings even with a syntactically valid disposition", () => {
    const errors = validateSocketReport({ ...baseSocket, alerts: [alert({ severity: "critical", disposition: "upgrade" })] });
    expect(errors.some((error) => error.includes("critical findings block release"))).toBe(true);
  });

  it("rejects expired accepted exceptions and incomplete complete reports", () => {
    const accepted = alert({
      disposition: "accepted-with-evidence",
      owner: "security",
      reason: "upstream fix pending",
      expiry: "2020-01-01T00:00:00Z",
      verification: "isolated in CI",
    });
    expect(validateSocketReport({ ...baseSocket, alerts: [accepted] }).some((error: string) => error.includes("accepted exception is expired"))).toBe(true);
    expect(validateSocketReport({ ...baseSocket, completeness: undefined })).not.toContain("status");
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
