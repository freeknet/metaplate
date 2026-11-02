import type { SocialTarget } from "./compatibility-profiles.js";

/**
 * What a platform documents about its link-preview crawler and robots.txt:
 * `honors` (it says the crawler obeys robots.txt), `ignores` (it says the
 * crawler does not), or `undocumented` (it publishes the user agent but not
 * whether robots.txt applies).
 */
export type SocialCrawlerRobotsPolicy = "honors" | "ignores" | "undocumented";

export type SocialCrawler = Readonly<{
  /** The robots.txt product token, as the platform writes it. */
  token: string;
  platform: string;
  /** The `User-Agent` the platform documents for its preview fetches. */
  userAgent: string;
  robots: SocialCrawlerRobotsPolicy;
  /** Compatibility targets whose previews this crawler builds. */
  targets: readonly SocialTarget[];
  /** The platform documentation the entry is taken from. */
  source: string;
}>;

/**
 * Link-preview crawlers whose user agents the platforms document. Keep
 * platform facts here, with their source, so a change has one reviewable
 * place; docs/verify-page.md explains each entry and the platforms left out.
 */
const ENTRIES: SocialCrawler[] = [
  {
    token: "Twitterbot",
    platform: "X",
    userAgent: "Twitterbot/1.0",
    robots: "honors",
    targets: ["x"],
    source: "https://developer.twitter.com/en/docs/twitter-for-websites/cards/guides/getting-started",
  },
  {
    token: "facebookexternalhit",
    platform: "Meta (Facebook, Instagram, Messenger, Threads)",
    userAgent: "facebookexternalhit/1.1",
    robots: "honors",
    targets: ["facebook", "instagram", "threads"],
    source: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers",
  },
  {
    token: "LinkedInBot",
    platform: "LinkedIn",
    userAgent: "LinkedInBot/1.0 (compatible; Mozilla/5.0; +http://www.linkedin.com)",
    robots: "undocumented",
    targets: ["linkedin"],
    source: "https://www.linkedin.com/help/linkedin/answer/a521928",
  },
  {
    token: "Discordbot",
    platform: "Discord",
    userAgent: "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
    robots: "undocumented",
    targets: ["discord"],
    source: "https://docs.discord.com/developers/link-previews/component-embeds",
  },
  {
    token: "WhatsApp",
    platform: "WhatsApp",
    userAgent: "WhatsApp/2.x.x.x A|I|N",
    robots: "undocumented",
    targets: ["whatsapp"],
    source: "https://developers.facebook.com/documentation/business-messaging/whatsapp/link-previews/",
  },
  {
    token: "Pinterestbot",
    platform: "Pinterest",
    userAgent: "Mozilla/5.0 (compatible; Pinterestbot/1.0; +https://www.pinterest.com/bot.html)",
    robots: "honors",
    targets: ["pinterest"],
    source: "https://help.pinterest.com/en/business/article/pinterestbot",
  },
  {
    token: "Slackbot-LinkExpanding",
    platform: "Slack",
    userAgent: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    robots: "ignores",
    targets: ["slack"],
    source: "https://api.slack.com/robots",
  },
];

export const SOCIAL_CRAWLERS: readonly SocialCrawler[] = Object.freeze(
  ENTRIES.map((crawler) => Object.freeze({ ...crawler, targets: Object.freeze([...crawler.targets]) })),
);

/** Finds a documented crawler by product token, case-insensitively. */
export function findSocialCrawler(token: string): SocialCrawler | undefined {
  const lower = token.toLowerCase();
  return SOCIAL_CRAWLERS.find((crawler) => crawler.token.toLowerCase() === lower);
}

/**
 * The crawlers whose robots.txt rules matter for `targets`: every documented
 * crawler for one of them, except those documented to ignore robots.txt.
 */
export function crawlersForTargets(targets: readonly SocialTarget[]): SocialCrawler[] {
  return SOCIAL_CRAWLERS.filter((crawler) =>
    crawler.robots !== "ignores" && crawler.targets.some((target) => targets.includes(target)));
}
