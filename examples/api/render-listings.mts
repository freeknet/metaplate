// examples/api/render-listings.mts
import { rename, rm } from "node:fs/promises";
import { runCli } from "metaplate/cli";

const SCRATCH = ".listing-cards";
const LIVE = "public/listings";

// Start empty, so a listing that has gone away leaves no card behind.
await rm(SCRATCH, { recursive: true, force: true });

const code = await runCli(["render", "--out", SCRATCH, "--concurrency", "8", "listing-cards.ts"]);

// A failed run exits 1 with every failure reported, and the live cards stay as
// they were. `metaplate-manifest.json` stays in the scratch directory, unpublished.
if (code === 0) {
  await rm(LIVE, { recursive: true, force: true });
  await rename(`${SCRATCH}/listings`, LIVE);
  await rm(SCRATCH, { recursive: true, force: true });
}
process.exit(code);
