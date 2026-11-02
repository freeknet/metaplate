import { createElement, type ReactElement } from "react";
import {
  serializeJsonLd,
  socialImageJsonLd,
  socialImageJsonLdScript,
  socialImageMetadata,
  type SocialImageJsonLdOptions,
} from "metaplate";

// Relative image URLs resolve against the canonical `url`, as in socialMetaTags.
const social = socialImageMetadata("/blog/launch", "Launch card", { type: "image/png" });
const imageLicense: SocialImageJsonLdOptions = {
  url: "https://example.com/blog/launch",
  name: "Launch card",
  creditText: "Example",
  creator: { "@type": "Organization", name: "Example" },
  license: "/image-license",
  acquireLicensePage: "/licensing",
  representativeOfPage: true,
};

/** Plain HTML: one escaped `<script type="application/ld+json">` element. */
export function jsonLdHead(): string {
  return `  ${socialImageJsonLdScript(social, imageLicense)}`;
}

/**
 * Next.js App Router page. In `app/blog/launch/page.tsx` this is
 * `<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ... }} />`;
 * `serializeJsonLd` replaces the `.replace(/</g, "\\u003c")` from Next's
 * JSON-LD guide and also escapes `>`, `&`, U+2028, and U+2029.
 */
export default function Page(): ReactElement {
  return createElement(
    "section",
    null,
    createElement("script", {
      type: "application/ld+json",
      dangerouslySetInnerHTML: { __html: serializeJsonLd(socialImageJsonLd(social, imageLicense)) },
    }),
  );
}
