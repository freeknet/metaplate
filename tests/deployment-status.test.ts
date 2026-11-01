import { describe, expect, it } from "vitest";
import { validateDeploymentManifest } from "../scripts/verify-deployment-evidence.mjs";

const base = {
  schemaVersion: 1,
  release: "0.8.0",
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

  it("requires related upstream references to be HTTPS URLs", () => {
    const route = {
      id: "sveltekit-node",
      provider: "SvelteKit adapter-node",
      runtime: "long-lived Node.js",
      status: "certified-local-contract",
      evidence: "packed local contract fixture",
    };
    expect(validateDeploymentManifest({
      ...base,
      routes: [{ ...route, relatedDocs: ["https://svelte.dev/docs/kit/routing#server"] }],
    })).toEqual([]);
    expect(validateDeploymentManifest({
      ...base,
      routes: [{ ...route, relatedDocs: ["http://svelte.dev/docs/kit/routing"] }],
    })).toContain("sveltekit-node: relatedDocs must be an array of HTTPS URLs");
  });
});
