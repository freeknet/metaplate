import { describe, expect, it } from "vitest";
import { validateDeploymentManifest } from "../../scripts/release/verify-deployment-evidence.mjs";

const base = {
  schemaVersion: 1,
  release: "0.8.1",
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

  it("requires HTTPS upstream references and a stated runtime boundary when present", () => {
    const route = {
      id: "next-server",
      provider: "Next.js self-hosted server (next start)",
      runtime: "long-lived Node.js",
      status: "certified-local-contract",
      evidence: "packed local server fixture",
    };
    expect(validateDeploymentManifest({
      ...base,
      routes: [{
        ...route,
        runtimeBoundary: "Next.js 16.3.2-16.x on Node.js 24",
        officialReferences: ["https://nextjs.org/docs/app/api-reference/cli/next"],
      }],
    })).toEqual([]);
    expect(validateDeploymentManifest({
      ...base,
      routes: [{ ...route, runtimeBoundary: " ", officialReferences: ["http://example.com"] }],
    })).toEqual([
      "next-server: officialReferences must be a non-empty array of HTTPS URLs",
      "next-server: runtimeBoundary must be a non-empty string",
    ]);
  });

  it("certifies an edge route only when it renders through metaplate/edge", () => {
    const edgeRoute = {
      id: "provider-edge",
      provider: "Example Edge",
      runtime: "Edge Functions",
      edgeRuntime: true,
      status: "certified",
      evidence: "hosted edge deployment",
      certification: {
        packedArtifact: true,
        productionBuild: true,
        output: true,
        imageVerification: { verified: true },
        responseVerification: { verified: true },
        providerVersion: "1.0",
        runtimeVersion: "edge",
        commitSha: "abc123",
        evidenceUrlOrArtifact: "evidence.json",
      },
    };
    expect(validateDeploymentManifest({
      ...base,
      routes: [{ ...edgeRoute, api: "metaplate/edge createEdgeOg fetchableFrom" }],
    })).toEqual([]);
    for (const api of [undefined, "metaplate/node handlerFrom", "not supported by metaplate/node"]) {
      expect(validateDeploymentManifest({
        ...base,
        routes: [{ ...edgeRoute, ...(api === undefined ? {} : { api }) }],
      })).toContain("provider-edge: native edge runtime cannot be certified without an edge renderer");
    }
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
