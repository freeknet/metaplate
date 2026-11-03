/**
 * `metaplate/cli`: the `metaplate` commands as a function, for build scripts
 * that would otherwise spawn the binary through a shell.
 */
export { runCli, type RunCliOptions } from "./cli/run.js";
export type { CliWriter } from "./cli/io.js";
