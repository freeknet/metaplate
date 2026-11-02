export function validateEvidenceBundle(
  report: unknown,
  context: { commitSha: string; releaseVersion: string; digest: (file: string) => string | undefined },
): string[];
