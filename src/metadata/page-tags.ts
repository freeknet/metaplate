/**
 * Page-level fields: the Open Graph basics (`og:title` through `og:type`),
 * `og:locale`, the `article:` namespace, Discord's `og:pubdate`, and the
 * `theme-color` accent. Each field is validated once here, so `socialMetaTags`
 * and the Next.js mapping in `metaplate/next` emit the same values.
 *
 * @see https://ogp.me/#optional
 * @see https://ogp.me/#type_article
 * @see https://docs.discord.com/developers/link-previews/overview
 * @see https://html.spec.whatwg.org/multipage/semantics.html#meta-theme-color
 */
import type { SocialMetaTag } from "./meta-tags.js";
import { present } from "../core/internal.js";

/**
 * A point in time as page fields accept it: a `Date`, serialized with
 * `toISOString()`, or a string in one of the forms `SocialMetaArticle`
 * documents.
 */
export type SocialMetaDateTime = string | Date;

/**
 * The `article:` properties of the Open Graph `article` type. When any of
 * them emits a tag, `og:type` defaults to `article`.
 *
 * @see https://ogp.me/#type_article
 */
export type SocialMetaArticle = {
  /**
   * `article:published_time`: "When the article was first published." A
   * `Date`, a calendar date (`2026-11-01`), or an RFC 3339 date-time with
   * seconds and an offset (`2026-11-01T09:30:00Z`, `2026-11-01T09:30:00-05:00`).
   */
  publishedTime?: SocialMetaDateTime | undefined;
  /** `article:modified_time`, in the same forms as `publishedTime`. */
  modifiedTime?: SocialMetaDateTime | undefined;
  /** `article:expiration_time`, in the same forms as `publishedTime`. */
  expirationTime?: SocialMetaDateTime | undefined;
  /**
   * `article:author`, one tag per entry. Open Graph types these as profiles,
   * so a profile URL is the most portable value; names are passed through.
   */
  authors?: readonly string[] | undefined;
  /** `article:section`: "A high-level section name. E.g. Technology". */
  section?: string | undefined;
  /** `article:tag`, one tag per entry. */
  tags?: readonly string[] | undefined;
};

/**
 * Optional page-level fields. An undefined or empty value emits no tag.
 * `<title>` and `<link rel="canonical">` are not meta tags and remain the
 * page's responsibility.
 */
export type SocialMetaOptions = {
  /** Emitted as `og:title`. */
  title?: string | undefined;
  /** Emitted as `og:description`. */
  description?: string | undefined;
  /**
   * Absolute http(s) canonical page URL, emitted as `og:url`. When supplied,
   * relative image URLs are resolved against it; absolute image URLs are
   * never changed. Without it, image URLs are emitted exactly as given.
   */
  url?: string | undefined;
  /** Emitted as `og:site_name`. */
  siteName?: string | undefined;
  /**
   * Emitted as `og:type`. Defaults to `article` when `article` emits a tag,
   * otherwise to `website` only when `title` or `url` is supplied, so
   * metadata-only calls never gain page-level tags. Must be `article` when
   * `article` emits any tag.
   */
  type?: string | undefined;
  /**
   * `og:locale`, in the Open Graph `language_TERRITORY` format such as
   * `en_US` (not the BCP 47 `en-US`).
   */
  locale?: string | undefined;
  /** `og:locale:alternate`, one tag per entry, in the same format as `locale`. */
  alternateLocales?: readonly string[] | undefined;
  /** The `article:` properties; see `SocialMetaArticle`. */
  article?: SocialMetaArticle | undefined;
  /**
   * `og:pubdate`, the publish date Discord reads for its embed timestamp. It
   * must be a full RFC 3339 date-time with a time and an offset, or a `Date`.
   * It is not an Open Graph property, so it is emitted only when supplied.
   */
  pubdate?: SocialMetaDateTime | undefined;
  /**
   * `<meta name="theme-color">`, the accent Discord draws beside the embed.
   * Only `#RRGGBB` and `#RRGGBBAA` hex colors are accepted: they are the forms
   * Discord reads and are valid CSS colors for browsers.
   */
  themeColor?: string | undefined;
};

/** Validated, normalized article fields; arrays are present only when non-empty. */
export type PageArticleFields = {
  publishedTime?: string;
  modifiedTime?: string;
  expirationTime?: string;
  authors?: string[];
  section?: string;
  tags?: string[];
};

/** Validated, normalized page fields, ready for tags or a framework mapping. */
export type PageFields = {
  title?: string;
  description?: string;
  url?: string;
  siteName?: string;
  type?: string;
  locale?: string;
  alternateLocales?: string[];
  article?: PageArticleFields;
  pubdate?: string;
  themeColor?: string;
};

/** `language_TERRITORY`, as ogp.me writes `og:locale`. */
const LOCALE = /^[a-z]{2,3}_[A-Z]{2}$/;
const BCP47_LIKE = /^([a-z]{2,3})-([A-Za-z]{2})$/;
const THEME_COLOR = /^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** Parses the canonical URL, accepting only credential-free http(s) URLs. */
export function canonicalBase(url: string): URL {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error(`Invalid url: expected an absolute http(s) URL; received ${url}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Invalid url: must not contain credentials; received ${url}`);
  }
  return parsed;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month === 2 && leap ? 29 : MONTH_DAYS[month - 1]!;
}

/** Checks the numeric ranges a pattern match cannot: months, days, hours, offsets. */
function validCalendar(parts: readonly (string | undefined)[]): boolean {
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0, offsetHour = 0, offsetMinute = 0] =
    parts.map((part) => (part === undefined ? undefined : Number(part)));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false;
  return hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
}

/**
 * Validates a date or date-time and returns the string to emit. A `Date` must
 * be valid and in years 0000-9999 so `toISOString()` yields RFC 3339.
 */
function dateTime(value: SocialMetaDateTime, label: string, requireTime: boolean): string {
  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isNaN(time)) throw new Error(`${label} must be a valid Date`);
    const year = value.getUTCFullYear();
    if (year < 0 || year > 9999) {
      throw new Error(`${label} must fall in the years 0000 to 9999; received ${year}`);
    }
    return value.toISOString();
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string or a Date`);
  }
  const full = DATE_TIME.exec(value);
  if (full && validCalendar(full.slice(1))) return value;
  const date = requireTime ? null : CALENDAR_DATE.exec(value);
  if (date && validCalendar(date.slice(1))) return value;
  const expected = requireTime
    ? "a full RFC 3339 date-time with seconds and an offset, such as 2026-11-01T09:30:00Z"
    : "a date such as 2026-11-01, or an RFC 3339 date-time with seconds and an offset, such as 2026-11-01T09:30:00Z";
  throw new Error(`${label} must be ${expected}; received ${value}`);
}

function optionalDateTime(
  value: SocialMetaDateTime | undefined,
  label: string,
  requireTime: boolean,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  return dateTime(value, label, requireTime);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function textList(values: readonly string[] | undefined, label: string): string[] {
  return (values ?? []).map((value, index) => text(value, `${label}[${index}]`));
}

function locale(value: string, label: string): string {
  if (LOCALE.test(value)) return value;
  const bcp47 = BCP47_LIKE.exec(value);
  const hint = bcp47
    ? `; Open Graph uses an underscore, as in ${bcp47[1]}_${bcp47[2]!.toUpperCase()}`
    : "";
  throw new Error(
    `${label} must be an Open Graph locale in language_TERRITORY form, such as en_US; received ${value}${hint}`,
  );
}

function locales(options: SocialMetaOptions): Pick<PageFields, "locale" | "alternateLocales"> {
  const primary = present(options.locale) ? locale(options.locale, "locale") : undefined;
  const seen = new Set(primary === undefined ? [] : [primary]);
  const alternates = (options.alternateLocales ?? []).map((value, index) => {
    const checked = locale(value, `alternateLocales[${index}]`);
    if (seen.has(checked)) {
      throw new Error(`alternateLocales lists ${checked} more than once or repeats locale`);
    }
    seen.add(checked);
    return checked;
  });
  return {
    ...(primary === undefined ? {} : { locale: primary }),
    ...(alternates.length > 0 ? { alternateLocales: alternates } : {}),
  };
}

function articleFields(article: SocialMetaArticle): PageArticleFields {
  const fields: PageArticleFields = {};
  for (const key of ["publishedTime", "modifiedTime", "expirationTime"] as const) {
    const value = optionalDateTime(article[key], `article.${key}`, false);
    if (value !== undefined) fields[key] = value;
  }
  const authors = textList(article.authors, "article.authors");
  if (authors.length > 0) fields.authors = authors;
  if (present(article.section)) fields.section = text(article.section, "article.section");
  const tags = textList(article.tags, "article.tags");
  if (tags.length > 0) fields.tags = tags;
  return fields;
}

function themeColor(value: string): string {
  if (!THEME_COLOR.test(value)) {
    throw new Error(
      `themeColor must be a #RRGGBB or #RRGGBBAA hex color, the forms Discord reads; received ${value}`,
    );
  }
  return value;
}

/**
 * Validates and normalizes page fields. `url` must be an absolute,
 * credential-free http(s) URL.
 *
 * @throws When a field breaks its rule: an invalid `url`, a locale outside
 *   `language_TERRITORY` or repeated, an article date that is not a valid
 *   calendar date or RFC 3339 date-time with an offset, a `pubdate` without a
 *   time and offset, an empty author, section, or tag entry, a `themeColor`
 *   that is not `#RRGGBB` or `#RRGGBBAA`, or a `type` other than `article`
 *   alongside article fields.
 */
export function pageFields(options: SocialMetaOptions): PageFields {
  if (present(options.url)) canonicalBase(options.url);
  const article = options.article === undefined ? undefined : articleFields(options.article);
  const articleHasTags = article !== undefined && Object.keys(article).length > 0;
  if (articleHasTags && present(options.type) && options.type !== "article") {
    throw new Error(
      `article fields belong to og:type article; received type: ${options.type}`,
    );
  }
  const defaultType = articleHasTags
    ? "article"
    : present(options.title) || present(options.url)
      ? "website"
      : undefined;
  const type = present(options.type) ? options.type : defaultType;
  const pubdate = optionalDateTime(options.pubdate, "pubdate", true);
  const fields: PageFields = {};
  for (const key of ["title", "description", "url", "siteName"] as const) {
    const value = options[key];
    if (present(value)) fields[key] = value;
  }
  return {
    ...fields,
    ...(type === undefined ? {} : { type }),
    ...locales(options),
    ...(articleHasTags ? { article } : {}),
    ...(pubdate === undefined ? {} : { pubdate }),
    ...(present(options.themeColor) ? { themeColor: themeColor(options.themeColor) } : {}),
  };
}

/**
 * The page-level tags, after every image, media, and X Card tag: `og:title`,
 * `og:description`, `og:url`, `og:site_name`, `og:type`, `og:locale`, each
 * `og:locale:alternate`, `article:published_time`, `article:modified_time`,
 * `article:expiration_time`, each `article:author`, `article:section`, each
 * `article:tag`, `og:pubdate`, and finally `<meta name="theme-color">`.
 */
export function pageTags(options: SocialMetaOptions): SocialMetaTag[] {
  const fields = pageFields(options);
  const tags: SocialMetaTag[] = [];
  const add = (property: string, content: string | undefined) => {
    if (content !== undefined) tags.push({ property, content });
  };
  const addAll = (property: string, contents: readonly string[] | undefined) => {
    for (const content of contents ?? []) tags.push({ property, content });
  };
  add("og:title", fields.title);
  add("og:description", fields.description);
  add("og:url", fields.url);
  add("og:site_name", fields.siteName);
  add("og:type", fields.type);
  add("og:locale", fields.locale);
  addAll("og:locale:alternate", fields.alternateLocales);
  const article = fields.article ?? {};
  add("article:published_time", article.publishedTime);
  add("article:modified_time", article.modifiedTime);
  add("article:expiration_time", article.expirationTime);
  addAll("article:author", article.authors);
  add("article:section", article.section);
  addAll("article:tag", article.tags);
  add("og:pubdate", fields.pubdate);
  if (fields.themeColor !== undefined) {
    tags.push({ name: "theme-color", content: fields.themeColor });
  }
  return tags;
}
