// Reads the one package result from `npm pack --json` output. npm 10 and 11
// print an array of results; npm 12 prints an object keyed by package name
// (npm 12 changelog: "the --json output of `npm pack` and `npm publish` have
// changed"). Hosted builders such as Deno Deploy fetch the newest npm, so both
// shapes occur.
export function npmPackResult(output) {
  const parsed = JSON.parse(output);
  const results = Array.isArray(parsed) ? parsed : Object.values(parsed);
  if (results.length !== 1 || typeof results[0]?.filename !== "string") {
    throw new Error(`Expected one package from npm pack --json, got: ${output.slice(0, 200)}`);
  }
  return results[0];
}
