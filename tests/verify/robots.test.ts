import { describe, expect, it } from "vitest";
import { evaluateRobots, isRobotsProductToken, parseRobotsTxt } from "../../src/verify/robots.js";
import { crawlersForTargets, findSocialCrawler, SOCIAL_CRAWLERS } from "../../src/verify/social-crawlers.js";

const ORIGIN = "https://example.com";

function allowed(robots: string, token: string, path: string): boolean {
  return evaluateRobots(parseRobotsTxt(robots), token, `${ORIGIN}${path}`).allowed;
}

describe("parseRobotsTxt", () => {
  it("groups consecutive user-agent lines and starts a new group after a rule", () => {
    const robots = parseRobotsTxt([
      "User-agent: a",
      "user-agent: B",
      "Disallow: /one",
      "",
      "USER-AGENT: c",
      "allow: /two",
    ].join("\n"));
    expect(robots.groups).toEqual([
      { userAgents: ["a", "b"], rules: [{ kind: "disallow", pattern: "/one", line: 3 }] },
      { userAgents: ["c"], rules: [{ kind: "allow", pattern: "/two", line: 6 }] },
    ]);
  });

  it("handles comments, CR, CRLF, a byte order mark, and space around keys and values", () => {
    const robots = parseRobotsTxt("﻿# header\r\n  user-agent :\tExampleBot # who\rdisallow: /x # why\r\n#end");
    expect(robots.groups).toEqual([{ userAgents: ["examplebot"], rules: [{ kind: "disallow", pattern: "/x", line: 3 }] }]);
  });

  it("ignores rules before the first group, unknown records, and lines without a colon", () => {
    const robots = parseRobotsTxt([
      "disallow: /orphan",
      "user-agent: a",
      "sitemap: https://example.com/sitemap.xml",
      "user-agent: b",
      "crawl-delay: 10",
      "disallow /no-colon",
      "disallow: /kept",
    ].join("\n"));
    // A sitemap record does not end the group (RFC 9309 section 2.2.4).
    expect(robots.groups).toEqual([{ userAgents: ["a", "b"], rules: [{ kind: "disallow", pattern: "/kept", line: 7 }] }]);
  });

  it("reads the product token prefix of a user-agent value", () => {
    const robots = parseRobotsTxt("user-agent: Twitterbot/1.0\nuser-agent: *\nuser-agent: /bad\ndisallow: /");
    expect(robots.groups[0]!.userAgents).toEqual(["twitterbot", "*"]);
  });

  it("treats an empty pattern as a rule line that matches nothing", () => {
    const text = "user-agent: a\ndisallow:\nuser-agent: b\ndisallow: /";
    expect(parseRobotsTxt(text).groups).toEqual([
      { userAgents: ["a"], rules: [] },
      { userAgents: ["b"], rules: [{ kind: "disallow", pattern: "/", line: 4 }] },
    ]);
    expect(allowed(text, "a", "/anything")).toBe(true);
    expect(allowed(text, "b", "/anything")).toBe(false);
  });
});

describe("evaluateRobots: groups (RFC 9309 section 2.2.1)", () => {
  it("merges every group that names the token (figure 2)", () => {
    const text = "user-agent: ExampleBot\ndisallow: /foo\ndisallow: /bar\n\nuser-agent: ExampleBot\ndisallow: /baz";
    for (const path of ["/foo", "/bar", "/baz"]) expect(allowed(text, "ExampleBot", path)).toBe(false);
    expect(allowed(text, "ExampleBot", "/qux")).toBe(true);
  });

  it("falls back to the * group only when no group names the token (figure 3)", () => {
    const text = "user-agent: *\ndisallow: /foo\ndisallow: /bar\n\nuser-agent: BazBot\ndisallow: /baz";
    expect(evaluateRobots(parseRobotsTxt(text), "ExampleBot", `${ORIGIN}/foo`)).toMatchObject({ allowed: false, group: "wildcard" });
    expect(allowed(text, "ExampleBot", "/baz")).toBe(true);
    expect(evaluateRobots(parseRobotsTxt(text), "bazbot", `${ORIGIN}/foo`)).toMatchObject({ allowed: true, group: "named" });
  });

  it("matches the token case-insensitively", () => {
    expect(allowed("User-agent: TWITTERBOT\nDisallow: /", "Twitterbot", "/")).toBe(false);
  });

  it("allows everything when no group applies or the file is empty", () => {
    expect(evaluateRobots(parseRobotsTxt("user-agent: other\ndisallow: /"), "a", `${ORIGIN}/`)).toEqual({ allowed: true, group: "none" });
    expect(allowed("", "a", "/x")).toBe(true);
    expect(allowed("user-agent: a", "a", "/x")).toBe(true);
  });

  it("always allows /robots.txt itself", () => {
    expect(allowed("user-agent: *\ndisallow: /", "a", "/robots.txt")).toBe(true);
  });
});

describe("evaluateRobots: rules (RFC 9309 sections 2.2.2 and 2.2.3)", () => {
  it("uses the most specific match, and allow on a tie", () => {
    const text = "user-agent: *\ndisallow: /\nallow: /public\ndisallow: /public/secret\nallow: /tie\ndisallow: /tie";
    expect(allowed(text, "a", "/home")).toBe(false);
    expect(allowed(text, "a", "/public/page")).toBe(true);
    expect(allowed(text, "a", "/public/secret/x")).toBe(false);
    expect(allowed(text, "a", "/tie")).toBe(true);
    const decision = evaluateRobots(parseRobotsTxt(text), "a", `${ORIGIN}/public/secret`);
    expect(decision.rule).toEqual({ kind: "disallow", pattern: "/public/secret", line: 4 });
  });

  it("matches from the first octet, case-sensitively, including the query", () => {
    const text = "user-agent: *\ndisallow: /search?q=\ndisallow: /Private";
    expect(allowed(text, "a", "/search?q=cats")).toBe(false);
    expect(allowed(text, "a", "/search")).toBe(true);
    expect(allowed(text, "a", "/private")).toBe(true);
    expect(allowed(text, "a", "/x/Private")).toBe(true);
  });

  it("supports * anywhere and $ at the end", () => {
    const text = "user-agent: *\ndisallow: /*.png$\ndisallow: /fish*\ndisallow: /*/drafts/\ndisallow: /exact$";
    expect(allowed(text, "a", "/images/card.png")).toBe(false);
    expect(allowed(text, "a", "/images/card.png?v=2")).toBe(true);
    expect(allowed(text, "a", "/fishheads")).toBe(false);
    expect(allowed(text, "a", "/a/b/drafts/one")).toBe(false);
    expect(allowed(text, "a", "/drafts/")).toBe(true);
    expect(allowed(text, "a", "/exact")).toBe(false);
    expect(allowed(text, "a", "/exactly")).toBe(true);
    expect(allowed("user-agent: *\ndisallow: *", "a", "/anything")).toBe(false);
  });

  it("treats $ before the end as a literal character", () => {
    const text = "user-agent: *\ndisallow: /a$b";
    expect(allowed(text, "a", "/a$b")).toBe(false);
    expect(allowed(text, "a", "/a")).toBe(true);
  });

  it("lets an escaped * or $ match the literal character (figure 6)", () => {
    const text = "user-agent: *\ndisallow: /path/file-with-a-%2A.html\ndisallow: /path/foo-%24";
    expect(allowed(text, "a", "/path/file-with-a-*.html")).toBe(false);
    expect(allowed(text, "a", "/path/file-with-a-b.html")).toBe(true);
    expect(allowed(text, "a", "/path/foo-$")).toBe(false);
  });

  it("compares percent-encoded and raw octets in one form (figure 4)", () => {
    expect(allowed("user-agent: *\ndisallow: /foo/bar/ツ", "a", "/foo/bar/%E3%83%84")).toBe(false);
    expect(allowed("user-agent: *\ndisallow: /foo/bar/%e3%83%84", "a", "/foo/bar/ツ")).toBe(false);
    expect(allowed("user-agent: *\ndisallow: /foo/bar/%62%61%7A", "a", "/foo/bar/baz")).toBe(false);
    expect(allowed("user-agent: *\ndisallow: /foo/bar/baz", "a", "/foo/bar/%62%61%7A")).toBe(false);
    // An escaped reserved character is not the same URI as the literal one.
    expect(allowed("user-agent: *\ndisallow: /a%2Fb", "a", "/a/b")).toBe(true);
    expect(allowed("user-agent: *\ndisallow: /a b", "a", "/a%20b")).toBe(false);
  });

  it("finishes in linear time on adversarial files and paths", () => {
    const path = `/${"a".repeat(8_000)}`;
    const files = [
      `user-agent: *\n${"disallow: /*a*a*a*a*a*a*a*a*b\n".repeat(10_000)}`,
      `user-agent: *\ndisallow: /${"*a".repeat(100_000)}b`,
      `user-agent: *\ndisallow: /${"a*".repeat(100_000)}$`,
      `${"user-agent: x\n".repeat(50_000)}user-agent: *\n${"allow: /a\n".repeat(50_000)}`,
      `user-agent: *\ndisallow: ${"%".repeat(200_000)}`,
    ];
    const started = performance.now();
    for (const text of files) evaluateRobots(parseRobotsTxt(text), "a", `${ORIGIN}${path}`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("isRobotsProductToken", () => {
  it.each([["Twitterbot", true], ["Slackbot-LinkExpanding", true], ["a_b", true], ["", false], ["bot/1.0", false], ["*", false], ["bot 2", false]])(
    "%j is %j",
    (token, expected) => expect(isRobotsProductToken(token)).toBe(expected),
  );
});

describe("SOCIAL_CRAWLERS", () => {
  it("names valid product tokens with a documentation source", () => {
    for (const crawler of SOCIAL_CRAWLERS) {
      expect(isRobotsProductToken(crawler.token)).toBe(true);
      expect(crawler.source).toMatch(/^https:\/\//);
    }
  });

  it("finds crawlers case-insensitively and implies them from targets, never one that ignores robots.txt", () => {
    expect(findSocialCrawler("twitterbot")?.token).toBe("Twitterbot");
    expect(findSocialCrawler("nobody")).toBeUndefined();
    expect(crawlersForTargets(["x", "facebook", "instagram"]).map(({ token }) => token)).toEqual(["Twitterbot", "facebookexternalhit"]);
    expect(crawlersForTargets(["slack", "universal", "telegram"])).toEqual([]);
  });
});
