# Schema.org image metadata

Describing social images as a schema.org `ImageObject` in JSON-LD.

`socialImageJsonLd` describes the same Open Graph images as a
[schema.org `ImageObject`](https://schema.org/ImageObject) in JSON-LD, the
form Google's
[image metadata guidance](https://developers.google.com/search/docs/appearance/structured-data/image-license-metadata)
reads for credit and licensing in Google Images. Google requires
`contentUrl` and at least one of `creator`, `creditText`, `copyrightNotice`,
or `license`; the image fields come from the metadata, so pass the licensing
fields as options. `socialImageJsonLdScript` renders the result as a
`<script type="application/ld+json">` element:

```ts
import { socialImageJsonLdScript, socialImageMetadata } from "metaplate";

const social = socialImageMetadata("/blog/launch", "Launch card", { type: "image/png" });
const imageLicense = {
  url: "https://example.com/blog/launch",
  creditText: "Example",
  license: "/image-license",
};

// Plain HTML: put the element anywhere in <head> or <body>.
const jsonLd = socialImageJsonLdScript(social, imageLicense);
```

The script's payload, formatted:

```json
{
  "@context": "https://schema.org",
  "@type": "ImageObject",
  "contentUrl": "https://example.com/blog/launch/og-image",
  "url": "https://example.com/blog/launch/og-image",
  "caption": "Launch card",
  "encodingFormat": "image/png",
  "width": { "@type": "QuantitativeValue", "value": 1200, "unitCode": "E37" },
  "height": { "@type": "QuantitativeValue", "value": 630, "unitCode": "E37" },
  "creditText": "Example",
  "license": "https://example.com/image-license"
}
```

With one distinct image the result is that single node. With several, such
as size variants, it is `{ "@context": "https://schema.org", "@graph": [...] }`
with one `ImageObject` per image in metadata order; a later image whose
resolved URL repeats an earlier one is dropped, as in `socialMetaTags`. Only
`openGraph.images` is read. Each node's keys appear in a fixed order:
`@type`, `contentUrl`, `url`, `name`, `caption`, `encodingFormat`, `width`,
`height`, `representativeOfPage`, `creditText`, `creator`, `copyrightNotice`,
`license`, `acquireLicensePage`. A field whose value is undefined or empty is
left out.

- `contentUrl` and `url` are both the image URL. Google prefers `contentUrl`
  and also accepts `url`.
- `caption` is the image's alt text and `encodingFormat` its media type.
- `width` and `height` are `QuantitativeValue`s in pixels (UN/CEFACT unit
  code `E37`). schema.org expects `Distance` or `QuantitativeValue` there,
  and Google's guidance does not use either property, so there is no
  Google-documented form; a bare number matches neither schema.org type, and
  `QuantitativeValue` is the conforming form that names the unit.
- `name`, `creditText`, `creator` (`{ "@type": "Person" | "Organization",
  name, url? }`), `copyrightNotice`, `license`, `acquireLicensePage`, and
  `representativeOfPage` come from the options and are copied onto every
  node, because Google reads licensing per image.

`url` is the canonical page URL, validated exactly as for `socialMetaTags`.
When it is supplied, relative image URLs and the URL-valued options
(`license`, `acquireLicensePage`, `creator.url`) resolve against it; absolute
URLs are never rewritten. Without it, URLs are emitted as given. The page URL
itself is not emitted.

`socialImageJsonLdScript` serializes with `JSON.stringify` and then escapes
`<`, `>`, `&`, U+2028, and U+2029 as `\u003c`, `\u003e`, `\u0026`, `\u2028`,
and `\u2029`. JSON allows those characters only inside strings, where the
escape decodes to the same character, so `JSON.parse` of the payload returns
the original values. The payload contains no `<`, so no caption, credit, or
URL can close the element, open another, or start an HTML comment: the only
`</script` in the output is its own closing tag. `serializeJsonLd` applies
the same escaping to any value.

In Next.js, render the JSON-LD as a native `<script>` in `page.tsx` or
`layout.tsx`, as
[Next's JSON-LD guide](https://nextjs.org/docs/app/guides/json-ld)
recommends. `serializeJsonLd` stands in for the guide's
`JSON.stringify(jsonLd).replace(/</g, "\u003c")`:

```tsx
import { serializeJsonLd, socialImageJsonLd, socialImageMetadata } from "metaplate";

const social = socialImageMetadata("/blog/launch", "Launch card", { type: "image/png" });

export default function Page() {
  const jsonLd = socialImageJsonLd(social, {
    url: "https://example.com/blog/launch",
    creditText: "Example",
    license: "/image-license",
  });
  return (
    <section>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />
      {/* ... */}
    </section>
  );
}
```

[`examples/api/json-ld.ts`](../examples/api/json-ld.ts) type-checks both forms.
