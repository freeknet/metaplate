/**
 * Small helpers shared across entries. Internal: not exported from any public
 * entry point. Runtime-neutral entries import it, so it must stay free of
 * Node built-ins.
 */

/** A string that is set and non-empty. */
export function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/** Whether `value` parses as a URL on its own, without a base. */
export function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Whether any issue in a report is an error. */
export function hasError(issues: readonly { severity?: string }[]): boolean {
  return issues.some(({ severity }) => severity === "error");
}

/**
 * Validates an optional integer option: `undefined` passes through, anything
 * else must be a safe integer of at least `minimum`. An invalid value throws a
 * `TypeError` naming the option.
 */
export function integerOption(name: string, value: number | undefined, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < minimum) {
    const expected = minimum === 0 ? "a non-negative integer" : `an integer of at least ${minimum}`;
    throw new TypeError(`${name} must be ${expected}; received ${value}`);
  }
  return value;
}

/**
 * A URL as it may be shown in logs and reports: unchanged unless it embeds
 * user information, in which case the username and password are removed.
 *
 * `url` is the text to display. `resolved` is the URL it names when the caller
 * already resolved it, for example against a page's base URL; otherwise `url`
 * is parsed on its own. Text that is not a URL cannot carry parsed
 * credentials and is returned unchanged.
 */
export function redactUrl(url: string | URL, resolved?: URL): string {
  const text = typeof url === "string" ? url : url.href;
  let parsed = resolved ?? (typeof url === "string" ? undefined : url);
  if (parsed === undefined) {
    try {
      parsed = new URL(text);
    } catch {
      return text;
    }
  }
  if (parsed.username === "" && parsed.password === "") return text;
  const copy = new URL(parsed.href);
  copy.username = "";
  copy.password = "";
  return copy.href;
}
