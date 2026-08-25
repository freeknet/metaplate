import { describe, expect, it } from "vitest";
import { validateDeploymentManifest } from "../scripts/verify-deployment-evidence.mjs";

const base = {
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
};

describe("deployment certification boundaries", () => {
  it("rejects hosted certification claims without structured evidence", () => {
    const errors = validateDeploymentManifest({
      ...base,
      routes: [{
        id: "vercel-node",
        provider: "Vercel",
        runtime: "Node.js Functions",
        status: "certified",
        evidence: "local handler fixture",
      }],
    });
    expect(errors).toContain("vercel-node: certified routes require a certification object");
  });

  it("accepts local contract status without treating it as hosted certification", () => {
    const errors = validateDeploymentManifest({
      ...base,
      routes: [{
        id: "vercel-node",
        provider: "Vercel",
        runtime: "Node.js Functions",
        status: "certified-local-contract",
        evidence: "packed local contract fixture",
      }],
    });
    expect(errors).toEqual([]);
  });
});
