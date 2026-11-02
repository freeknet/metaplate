export {
  MAX_IMAGE_DIMENSION,
  OG_CONTENT_TYPE,
  OG_SIZE,
  assertImageSize,
  socialImage,
  socialImageMetadata,
  socialImagePath,
  variantImagePath,
  type ImageSize,
  type OpenGraphImageOptions,
  type SocialImageDescriptor,
  type SocialImageMetadata,
  type SocialImageVerificationDescriptor,
  type SocialImageOptions,
  type SocialImageVariantOptions,
  type TwitterCard,
  type TwitterImageOptions,
  type XCard,
  type XImageOptions,
} from "./core/social-image.js";

export { IMAGE_VERSION_PARAMETER, socialImageVersion } from "./metadata/image-version.js";

export {
  socialImageCompatibility,
  type CompatibilitySeverity,
  type SocialCompatibilityImage,
  type SocialCompatibilityIssue,
  type SocialCompatibilityOptions,
  type SocialCompatibilityReport,
  type SocialTarget,
} from "./verify/compatibility.js";

export {
  verifySocialImage,
  type SocialImageVerificationIssue,
  type SocialImageVerificationOptions,
  type SocialImageVerificationReport,
} from "./verify/social-verification.js";

export {
  socialMetaHtml,
  socialMetaTags,
  type SocialMetaArticle,
  type SocialMetaDateTime,
  type SocialMetaHtmlOptions,
  type SocialMetaImageInput,
  type SocialMetaInput,
  type SocialMetaOptions,
  type SocialMetaTag,
} from "./metadata/meta-tags.js";

export {
  X_APP_PLATFORMS,
  type XAppCard,
  type XAppPlatform,
  type XAppStoreListing,
  type XCardMetadata,
  type XCardMetadataFields,
  type XCardOptions,
  type XPlayerCard,
} from "./metadata/x-cards.js";

export {
  ADAPTIVE_CARD_CONTENT_TYPE,
  ADAPTIVE_CARD_SCHEMA,
  ADAPTIVE_CARD_VERSION,
  ADAPTIVE_CARD_VERSIONS,
  TEAMS_ADAPTIVE_CARD_LIMITS,
  socialImageAdaptiveCard,
  type AdaptiveCardImage,
  type AdaptiveCardOpenUrlAction,
  type AdaptiveCardTextBlock,
  type AdaptiveCardVersion,
  type SocialImageAdaptiveCard,
  type SocialImageAdaptiveCardInput,
  type SocialImageAdaptiveCardOptions,
} from "./metadata/adaptive-card.js";
export type {
  OpenGraphAudio,
  OpenGraphMedia,
  OpenGraphMediaOptions,
  OpenGraphVideo,
  SocialMetaAudioInput,
  SocialMetaMediaInput,
  SocialMetaVideoInput,
} from "./metadata/og-media.js";
export {
  serializeJsonLd,
  socialImageJsonLd,
  socialImageJsonLdScript,
  type SchemaOrgPixels,
  type SocialImageCreator,
  type SocialImageJsonLd,
  type SocialImageJsonLdInput,
  type SocialImageJsonLdOptions,
  type SocialImageObject,
} from "./metadata/json-ld.js";
export {
  MIN_IMAGE_SIGNING_SECRET_BYTES,
  signImagePath,
  verifyImageSignature,
  type ImageSignatureVerification,
  type ImageSigningKeys,
  type ImageSigningSecret,
  type ImageSigningSecrets,
} from "./metadata/signing.js";
