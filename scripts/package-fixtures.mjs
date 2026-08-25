export const PACKAGE_NAME = "metaplate";

export const REQUIRED_RENDERER_PEERS = Object.freeze([
  "satori",
  "@resvg/resvg-js",
  "react",
]);

export const FRAMEWORK_DEPENDENCIES = Object.freeze({
  next: Object.freeze(["next", "react-dom"]),
  astro: Object.freeze(["astro", "@fontsource/inter"]),
  express: Object.freeze(["express", "@fontsource/inter"]),
  standalone: Object.freeze(["@fontsource/inter", "typescript", "@types/node"]),
  bare: Object.freeze(["typescript"]),
  reactRouter: Object.freeze([
    "@react-router/dev",
    "@react-router/node",
    "@react-router/serve",
    "@react-router/express",
    "react-router",
    "react-dom",
    "express",
    "vite",
    "typescript",
    "@types/node",
    "@types/react",
    "@fontsource/inter",
    "isbot",
  ]),
});

export const SOCIAL_CARD_FIXTURE = Object.freeze({
  width: 1200,
  height: 630,
  imagePath: "og-image.png",
  contentType: "image/png",
  origin: "https://example.com",
});

export const PACKAGE_FONT_FIXTURE = Object.freeze({
  name: "Inter",
  package: "@fontsource/inter",
  file: "files/inter-latin-700-normal.woff",
  weight: 700,
});

export const CLI_IMAGE_FIXTURES = Object.freeze({
  cardJpeg: "card.jpg",
  cardWebp: "card-lossy.webp",
  iconJpeg: "icon.jpg",
  iconWidth: 512,
  iconHeight: 512,
});

/** Derives public package specifiers from package.json exports. */
export function packageEntrySpecifiers(exports) {
  return Object.keys(exports).map((entry) =>
    entry === "." ? PACKAGE_NAME : `${PACKAGE_NAME}/${entry.slice(2)}`,
  );
}

export function esmImportSmoke(specifiers) {
  return specifiers
    .map((specifier) => `await import(${JSON.stringify(specifier)});`)
    .join("\n");
}

export function commonJsResolutionSmoke(specifiers) {
  return specifiers
    .map((specifier) => `require.resolve(${JSON.stringify(specifier)});`)
    .join("\n");
}

/** Smoke source for the one intentionally optional framework peer. */
export function nextPeerGuidanceSmoke() {
  return `
    const { createNextOg } = await import(${JSON.stringify(`${PACKAGE_NAME}/next`)});
    const plate = createNextOg({ component: () => null, alt: () => "card" });

    try {
      await plate.render({});
    } catch (error) {
      if (!error.message.includes("npm install next")) throw error;
      process.exit(0);
    }

    throw new Error(${JSON.stringify(`${PACKAGE_NAME}/next rendered without its next peer.`)});
  `;
}
