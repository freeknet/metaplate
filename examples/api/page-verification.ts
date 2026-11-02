import {
  RemoteImageError,
  verifyRemotePage,
  type RemotePageIssue,
  type RemotePageOptions,
} from "metaplate/node";

/** Page and image limits for a post-deploy check of one site. */
const options: RemotePageOptions = {
  targets: ["universal", "x"],
  maxHtmlBytes: 1_000_000,
  maxImages: 4,
  maxBytes: 5_000_000,
  timeoutMs: 5_000,
};

type PageAudit =
  | { ok: true; images: number; warnings: string[] }
  | { ok: false; errors: string[] };

function describe(where: string, issues: readonly RemotePageIssue[]): string[] {
  return issues.map((issue) => `${where}${issue.target ? ` (${issue.target})` : ""}: ${issue.message}`);
}

/**
 * Post-deploy check: the page must declare an og:image and an X card whose
 * images are reachable, well-formed, match what the tags declare, and pass
 * the universal and X profiles. A refused page fetch comes back as data.
 */
export async function auditDeployedPage(url: string): Promise<PageAudit> {
  try {
    const report = await verifyRemotePage(url, options);
    const findings = [
      ...describe("page", report.globalIssues),
      ...Object.values(report.targets).flatMap((target) => describe("page", target.issues)),
      ...report.images.flatMap((image) => [
        ...describe(`${image.source}[${image.index}]`, image.globalIssues),
        ...Object.values(image.targets).flatMap((target) => describe(`${image.source}[${image.index}]`, target.issues)),
      ]),
    ];
    const compatible = Object.values(report.targets).every((target) => target.compatible);
    if (report.valid && compatible) {
      return { ok: true, images: report.images.length, warnings: findings };
    }
    return { ok: false, errors: findings };
  } catch (error) {
    if (error instanceof RemoteImageError) return { ok: false, errors: [`${error.code}: ${error.message}`] };
    throw error;
  }
}
