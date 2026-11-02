# Social compatibility profiles

Checking an image descriptor against each platform's published preview rules.

`socialImageCompatibility` checks local descriptor facts without making
network requests. The conservative `universal` profile requires an absolute
HTTPS URL and PNG/JPEG media type; named profiles add documented checks,
including LinkedIn's minimum dimensions, a 1.91:1 aspect-ratio warning, and
optional 5 MB limit:

```ts
import { socialImageCompatibility } from "metaplate";

const report = socialImageCompatibility(metadata.openGraph.images[0], {
  targets: ["universal", "facebook", "linkedin", "slack"],
  fileSize: generatedBytes.byteLength,
});

if (!report.compatible) throw new Error(JSON.stringify(report.issues));
```

Pass `checkUrl: false` or `checkAlt: false` to evaluate a descriptor that has
not been assigned a URL or alt text yet; the input type,
`SocialCompatibilityImage`, makes both fields optional.

Issues are `error`, `warning`, or `unknown`. The `discord` profile checks the
image formats Discord's
[link-preview contract](https://docs.discord.com/developers/link-previews/overview)
supports (PNG, GIF, JPEG, WebP, and AVIF); Discord sets no image size limit and
accepts root-relative image URLs. Instagram checks are reported as unknown
because Instagram publishes no webpage image-tag contract. SVG remains useful as renderer output, but it is not a universal
social delivery format; use PNG or JPEG for broad crawler compatibility.

This local report cannot prove public fetchability, redirects, response MIME,
robots/WAF behavior, or crawler caches. Those require checking the deployed
page and image; use Meta Sharing Debugger, LinkedIn Post Inspector, and the
relevant client debugger after deployment.
