// scripts/render-cards.mts
import { runCli } from "metaplate/cli";

/*
 * Runs `metaplate render` in-process under tsx, so the command's import of the
 * JSX module goes through tsx's loader. That needs no `NODE_OPTIONS=`, which an
 * npm script cannot set on Windows. The manifest stays out of `public/` so it is
 * not published.
 */
const code = await runCli([
  "render",
  "--out",
  "public",
  "--manifest",
  ".og-manifest.json",
  "src/lib/og/cards.render.tsx",
]);
process.exit(code);
