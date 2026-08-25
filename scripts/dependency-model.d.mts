export function packageNameFromLockPath(lockPath: string): string | undefined;
export function packageIdentityFromExample(example: unknown): { package?: string; version?: string };
export function isRemoteSpecifier(specifier: string): boolean;
export function classifyLockPackages(input: unknown): Array<Record<string, unknown>>;
