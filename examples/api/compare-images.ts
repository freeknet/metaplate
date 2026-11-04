// Baseline comparison: notice when a dependency upgrade changes a card, even
// though every guard still passes (see
// docs/verification.md#compare-against-a-baseline).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { compareImages, type ImageComparison } from "metaplate/node";

/**
 * A snapshot-style check: the first run records the card, later runs fail
 * when more than `maxDiff` of its pixels changed and leave a side-by-side
 * picture of the change next to the baseline.
 */
export async function expectUnchanged(name: string, current: Uint8Array, maxDiff = 0.005): Promise<ImageComparison | undefined> {
  const baselineFile = `og-baseline/${name}.png`;
  const baseline = await readFile(baselineFile).catch(() => undefined);
  if (!baseline) {
    await mkdir("og-baseline", { recursive: true });
    await writeFile(baselineFile, current);
    return undefined;
  }
  const result = compareImages(baseline, current, { diffImage: true });
  if (result.changedRatio > maxDiff) {
    if (result.diffImage) await writeFile(`og-baseline/${name}.diff.png`, result.diffImage);
    throw new Error(`${name} changed: ${(result.changedRatio * 100).toFixed(2)}% of pixels`);
  }
  return result;
}
