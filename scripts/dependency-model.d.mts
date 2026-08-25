export function packageNameFromLockPath(lockPath: string): string | undefined;
export const REACHABILITY_RANK: Readonly<Record<string, number>>;
export function compareReachability(left: string, right: string): number;
export function strongestReachability(values: Iterable<string>): string | undefined;
export function packageIdentityFromExample(example: unknown): { package?: string; version?: string };
export function isRemoteSpecifier(specifier: string): boolean;
export function classifyLockPackages(input: unknown): Array<Record<string, unknown>>;
