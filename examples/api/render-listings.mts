// examples/api/render-listings.mts
import { rename, rm } from "node:fs/promises";
import { runCli } from "metaplate/cli";

const SCRATCH = ".listing-cards";
const LIVE = "public/listings";
const PREVIOUS = "public/.listings-previous";

// Start empty, so a listing that has gone away leaves no card behind.
await rm(SCRATCH, { recursive: true, force: true });

const code = await runCli(["render", "--out", SCRATCH, "--concurrency", "8", "listing-cards.ts"]);

// A failed run exits 1 with every failure reported, and the live cards stay as
// they were. `metaplate-manifest.json` stays in the scratch directory, unpublished.
if (code === 0) {
  // Move the live cards aside before swapping, so a failed rename (a file held
  // open on Windows, say) puts them back instead of leaving no cards at all.
  await rm(PREVIOUS, { recursive: true, force: true });
  await rename(LIVE, PREVIOUS).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  try {
    await rename(`${SCRATCH}/listings`, LIVE);
  } catch (error) {
    await rename(PREVIOUS, LIVE).catch(() => undefined);
    throw error;
  }
  await rm(PREVIOUS, { recursive: true, force: true });
  await rm(SCRATCH, { recursive: true, force: true });
}
process.exit(code);
