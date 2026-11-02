/**
 * Robots Exclusion Protocol (RFC 9309) parsing and matching.
 *
 * Everything here is a forward scan over the text with `indexOf` and
 * character-code checks; no regular expression ever runs over robots.txt
 * content or URLs. A rule is matched by splitting its pattern at `*` into
 * literal segments and finding each segment at its leftmost position after
 * the previous one. Leftmost-first is always the right choice for `*`-only
 * patterns, so a match never backtracks: the cost of one rule is bounded by
 * the length of the path times the length of its longest segment.
 */

/** One `allow` or `disallow` rule, as written and as compared. */
export type RobotsRule = Readonly<{
  kind: "allow" | "disallow";
  /** The path pattern as written, trimmed. */
  pattern: string;
  /** One-based line number in the file. */
  line: number;
}>;

/** One group: the product tokens it names, lowercased, and its rules. */
export type RobotsGroup = Readonly<{
  /** Lowercased product tokens; `*` for the catch-all group. */
  userAgents: readonly string[];
  rules: readonly RobotsRule[];
}>;

export type RobotsTxt = Readonly<{
  groups: readonly RobotsGroup[];
}>;

/** Which group supplied the rules a decision was made with. */
export type RobotsGroupMatch = "named" | "wildcard" | "none";

export type RobotsDecision = Readonly<{
  allowed: boolean;
  /** `named` when a group names the product token, `wildcard` for `*`, `none` when no group applies. */
  group: RobotsGroupMatch;
  /** The most specific matching rule; absent when no rule matched. */
  rule?: RobotsRule;
}>;

type CompiledRule = {
  rule: RobotsRule;
  /** Literal segments between `*` wildcards, in canonical form. */
  segments: string[];
  /** The pattern ended with `$`. */
  anchored: boolean;
  /** Octets in the canonical pattern; the longest match wins. */
  specificity: number;
};

/** A parsed file with its rules compiled for matching. */
type Compiled = { groups: { userAgents: readonly string[]; rules: CompiledRule[] }[] };

const compiledFiles = new WeakMap<RobotsTxt, Compiled>();

function isTokenCharacter(code: number): boolean {
  // RFC 9309 product-token: ALPHA, "-", and "_".
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x2d || code === 0x5f;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09;
}

function trimSpace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpace(text.charCodeAt(start))) start += 1;
  while (end > start && isSpace(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/**
 * Returns `*`, the leading product-token characters of a `user-agent`
 * value (so `Twitterbot/1.0` names `twitterbot`), or `undefined`.
 */
function productToken(value: string): string | undefined {
  if (value.startsWith("*")) return "*";
  let end = 0;
  while (end < value.length && isTokenCharacter(value.charCodeAt(end))) end += 1;
  return end === 0 ? undefined : value.slice(0, end).toLowerCase();
}

/** Whether `name` is a valid RFC 9309 product token. */
export function isRobotsProductToken(name: string): boolean {
  if (name.length === 0) return false;
  for (let index = 0; index < name.length; index += 1) {
    if (!isTokenCharacter(name.charCodeAt(index))) return false;
  }
  return true;
}

/**
 * Parses robots.txt text (RFC 9309 section 2.2). Lines may end in CR, LF,
 * or CRLF; `#` starts a comment; keys are case-insensitive. Consecutive
 * `user-agent` lines share one group, and a `user-agent` line after a rule
 * starts the next. Rules before the first group are ignored, as are other
 * records such as `sitemap`, which never end a group. An empty pattern
 * (`disallow:`) is a rule line that matches nothing.
 */
export function parseRobotsTxt(text: string): RobotsTxt {
  const groups: { userAgents: string[]; rules: RobotsRule[] }[] = [];
  let current: { userAgents: string[]; rules: RobotsRule[] } | undefined;
  let lastWasAgent = false;
  let start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let lineNumber = 0;

  while (start <= text.length) {
    let end = start;
    while (end < text.length) {
      const code = text.charCodeAt(end);
      if (code === 0x0a || code === 0x0d) break;
      end += 1;
    }
    lineNumber += 1;
    let line = text.slice(start, end);
    if (end >= text.length) start = text.length + 1;
    else start = text.charCodeAt(end) === 0x0d && text.charCodeAt(end + 1) === 0x0a ? end + 2 : end + 1;

    const comment = line.indexOf("#");
    if (comment !== -1) line = line.slice(0, comment);
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = trimSpace(line.slice(0, colon)).toLowerCase();
    const value = trimSpace(line.slice(colon + 1));

    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { userAgents: [], rules: [] };
        groups.push(current);
      }
      const token = productToken(value);
      if (token !== undefined) current.userAgents.push(token);
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      if (!current) continue;
      lastWasAgent = false;
      if (value !== "") current.rules.push(Object.freeze({ kind: key, pattern: value, line: lineNumber }));
    }
  }

  return Object.freeze({
    groups: Object.freeze(groups.map((group) => Object.freeze({
      userAgents: Object.freeze(group.userAgents),
      rules: Object.freeze(group.rules),
    }))),
  });
}

// ---------------------------------------------------------------------------
// Canonical form

const HEX = "0123456789ABCDEF";

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  const lower = code | 0x20;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x61 + 10 : -1;
}

function isUnreserved(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e;
}

/** RFC 3986 reserved characters, kept literal or escaped exactly as written. */
function isReserved(byte: number): boolean {
  return ":/?#[]@!&'()+,;=".includes(String.fromCharCode(byte));
}

function escapeByte(byte: number): string {
  return `%${HEX[byte >> 4]}${HEX[byte & 0x0f]}`;
}

/**
 * Brings a URL path or a rule pattern to one comparable form (RFC 9309
 * section 2.2.2): escapes of unreserved characters are decoded, other
 * escapes are uppercased, and non-ASCII, controls, space, and the other
 * characters a URL serializer escapes are percent-encoded as UTF-8. Reserved
 * characters stay as written, because an escaped and a literal reserved
 * character are different URIs. `*` and `$` are always compared escaped
 * (`%2A`, `%24`), so a pattern can name them literally with an escape;
 * `special` may instead give a literal `*` or `$` its pattern meaning.
 */
function canonical(text: string, special?: (character: string, index: number) => string | undefined): string {
  let out = "";
  const encoder = new TextEncoder();
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x25 && index + 2 < text.length && hexValue(text.charCodeAt(index + 1)) >= 0 && hexValue(text.charCodeAt(index + 2)) >= 0) {
      const byte = hexValue(text.charCodeAt(index + 1)) * 16 + hexValue(text.charCodeAt(index + 2));
      out += isUnreserved(byte) ? String.fromCharCode(byte) : escapeByte(byte);
      index += 2;
      continue;
    }
    if (code === 0x2a || code === 0x24) {
      const replaced = special?.(text[index]!, index);
      out += replaced ?? escapeByte(code);
      continue;
    }
    if (code < 0x80) {
      out += isUnreserved(code) || isReserved(code) ? text[index]! : escapeByte(code);
      continue;
    }
    // One code point, possibly a surrogate pair; lone surrogates become U+FFFD.
    const point = text.codePointAt(index)!;
    if (point > 0xffff) index += 1;
    for (const byte of encoder.encode(String.fromCodePoint(point))) out += escapeByte(byte);
  }
  return out;
}

/** Placeholder for a wildcard in a canonical pattern; never produced by `canonical` otherwise. */
const WILDCARD = "*";

function compileRule(rule: RobotsRule): CompiledRule {
  const last = rule.pattern.length - 1;
  let anchored = false;
  const text = canonical(rule.pattern, (character, index) => {
    if (character === "*") return WILDCARD;
    // "$" is special only at the end of the pattern.
    if (index === last) {
      anchored = true;
      return "";
    }
    return undefined;
  });
  return { rule, segments: text.split(WILDCARD), anchored, specificity: text.length + (anchored ? 1 : 0) };
}

/** The part of a URL robots rules are matched against: path and query, canonical. */
function matchTarget(url: URL): string {
  return canonical(`${url.pathname}${url.search}`);
}

/** Leftmost segment matching; see the module comment. */
function matches(compiled: CompiledRule, path: string): boolean {
  const { segments, anchored } = compiled;
  const first = segments[0]!;
  if (!path.startsWith(first)) return false;
  if (segments.length === 1) return !anchored || path.length === first.length;
  let cursor = first.length;
  const lastIndex = segments.length - 1;
  for (let index = 1; index < lastIndex; index += 1) {
    const segment = segments[index]!;
    const found = path.indexOf(segment, cursor);
    if (found === -1) return false;
    cursor = found + segment.length;
  }
  const tail = segments[lastIndex]!;
  if (anchored) return path.length - tail.length >= cursor && path.endsWith(tail);
  return path.indexOf(tail, cursor) !== -1;
}

function compile(robots: RobotsTxt): Compiled {
  let compiled = compiledFiles.get(robots);
  if (!compiled) {
    compiled = {
      groups: robots.groups.map((group) => ({ userAgents: group.userAgents, rules: group.rules.map(compileRule) })),
    };
    compiledFiles.set(robots, compiled);
  }
  return compiled;
}

/**
 * Decides whether the crawler named by `productToken` may fetch `url` under
 * `robots` (RFC 9309 sections 2.2.1 to 2.2.3). Every group naming the token
 * (case-insensitively) is merged; with none, every `*` group is merged; with
 * neither, everything is allowed. The rule matching the most octets wins,
 * and `allow` wins a tie. `/robots.txt` itself is always allowed.
 */
export function evaluateRobots(robots: RobotsTxt, productToken: string, url: string | URL): RobotsDecision {
  const parsed = new URL(String(url));
  if (parsed.pathname === "/robots.txt") return Object.freeze({ allowed: true, group: "none" });
  const token = productToken.toLowerCase();
  const { groups } = compile(robots);
  let selected = groups.filter((group) => group.userAgents.includes(token));
  let group: RobotsGroupMatch = "named";
  if (selected.length === 0) {
    selected = groups.filter((candidate) => candidate.userAgents.includes("*"));
    group = selected.length === 0 ? "none" : "wildcard";
  }
  const path = matchTarget(parsed);
  let best: CompiledRule | undefined;
  for (const candidate of selected) {
    for (const rule of candidate.rules) {
      if (best && (rule.specificity < best.specificity ||
        (rule.specificity === best.specificity && (best.rule.kind === "allow" || rule.rule.kind === "disallow")))) {
        continue;
      }
      if (matches(rule, path)) best = rule;
    }
  }
  return Object.freeze({
    allowed: best === undefined || best.rule.kind === "allow",
    group,
    ...(best ? { rule: best.rule } : {}),
  });
}
