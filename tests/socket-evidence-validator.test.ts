import { describe, expect, it } from "vitest";
import {
  SOCKET_RELEASE_POLICY,
  isIso8601Timestamp,
  validateDeepAuxiliary,
  validateNormalizedAt,
  validateReleasePolicy,
  validateScoreAlert,
} from "../scripts/socket-evidence.mjs";

const validLowest = {
  overall: "npm/@resvg/resvg-js-android-arm-eabi@2.6.2",
  supplyChain: "npm/next@16.3.3",
  maintenance: "npm/string.prototype.codepointat@0.2.1",
  quality: "npm/@resvg/resvg-js-android-arm-eabi@2.6.2",
  vulnerability: "npm/color-name@1.1.4",
  license: "npm/@resvg/resvg-js-android-arm-eabi@2.6.2",
};

describe("Socket evidence validator hardening", () => {
  it("rejects impossible ISO-8601 dates and times", () => {
    for (const value of [
      "2026-00-01",
      "2026-13-01",
      "2026-02-30",
      "2026-04-31",
      "2026-12-01T24:01:00Z",
      "2026-12-01T12:60:00Z",
      "2026-12-01T12:00:60Z",
    ]) {
      expect(isIso8601Timestamp(value)).toBe(false);
    }

    expect(isIso8601Timestamp("2026-02-28")).toBe(true);
    expect(isIso8601Timestamp("2028-02-29")).toBe(true);
    expect(isIso8601Timestamp("2026-08-25T12:34:56Z")).toBe(true);
  });

  it("requires normalizedAt to be a full timestamp", () => {
    expect(validateNormalizedAt("2026-08-25")).toContain("full ISO-8601");
    expect(validateNormalizedAt("2026-99-99T12:00:00Z")).toContain(
      "full ISO-8601",
    );
    expect(validateNormalizedAt("2026-08-25T12:34:56Z")).toBeUndefined();
  });

  it("returns release-policy validation errors for malformed field types", () => {
    const malformed = {
      ...SOCKET_RELEASE_POLICY,
      blockSeverities: {},
    };
    expect(validateReleasePolicy(malformed)).toContain(
      "blockSeverities must be an array",
    );
  });

  it("rejects duplicate capabilities and incomplete or malformed lowest data", () => {
    expect(
      validateDeepAuxiliary(
        {
          dependencyCount: 1,
          capabilities: ["fs", "fs"],
          lowest: validLowest,
        },
        "deep",
      ).some((error) => error.includes("duplicate")),
    ).toBe(true);

    const missingLowest = { ...validLowest } as Record<string, string>;
    delete missingLowest.license;
    expect(
      validateDeepAuxiliary(
        { capabilities: [], lowest: missingLowest },
        "deep",
      ).some((error) => error.includes("missing required key license")),
    ).toBe(true);

    expect(
      validateDeepAuxiliary(
        {
          capabilities: [],
          lowest: { ...validLowest, overall: "not-a-package" },
        },
        "deep",
      ).some((error) => error.includes("Socket package identity")),
    ).toBe(true);
  });

  it("rejects legacy duplicate fields in schemaVersion 2 score alerts", () => {
    const base = {
      name: "exampleAlert",
      severity: "low",
      example: "npm/camelize@1.0.1",
    };

    for (const field of ["type", "scope", "reachability", "lockfilePath"]) {
      const alert: Record<string, unknown> = { ...base, [field]: "legacy" };
      expect(validateScoreAlert(alert, 0)).toContain(`legacy field ${field}`);
    }
  });
});
