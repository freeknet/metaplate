export const REQUIRED_CHECKS: ReadonlySet<string>;
export function validateCheckResults(
  checkResults: unknown,
  context: { commitSha: string; releaseVersion: string },
): Array<{ name: string; status: "passed" }>;
export function createEvidenceReport(options?: {
  commitSha?: string;
  generatedAt?: string;
}): unknown;
