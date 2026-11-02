import {
  ADAPTIVE_CARD_CONTENT_TYPE,
  socialImage,
  socialImageAdaptiveCard,
  socialImageMetadata,
  socialMetaTags,
  variantImagePath,
  type SocialImageAdaptiveCard,
} from "metaplate";

const page = {
  title: "Release notes",
  description: "What changed in the latest release.",
  url: "https://example.com/blog/release-notes",
};

const route = "/blog/release-notes";
const alt = "Release notes card";

// Ordinary link previews in Teams, Slack, and Discord read these meta tags.
// One og:image keeps Discord from turning the preview into a gallery.
const social = socialImageMetadata(route, alt, { type: "image/png" });
export const headTags = socialMetaTags(social, page);

// Teams card images must fit 1024x1024, so the posted card uses a smaller
// rendering of the same plate, which your image route serves at
// og-image-teams; it goes to the card builder on its own.
const teamsImage = socialImage(route, alt, {
  type: "image/png",
  size: { width: 1024, height: 536 },
  imagePath: variantImagePath("og-image", "teams"),
});

// Cards posted by a bot, a Workflows webhook, or a message extension.
export const card: SocialImageAdaptiveCard = socialImageAdaptiveCard(
  { openGraph: { images: [teamsImage] } },
  page,
);

/** Request body for a Teams Workflows "When a Teams webhook request is received" URL. */
export function workflowWebhookBody(adaptiveCard: SocialImageAdaptiveCard) {
  return {
    type: "message",
    attachments: [{ contentType: ADAPTIVE_CARD_CONTENT_TYPE, contentUrl: null, content: adaptiveCard }],
  };
}

/** Bot Framework attachment, for `context.sendActivity({ attachments: [...] })`. */
export function botAttachment(adaptiveCard: SocialImageAdaptiveCard) {
  return { contentType: ADAPTIVE_CARD_CONTENT_TYPE, content: adaptiveCard };
}

/** Posting is left to the caller; the webhook URL is a secret, so read it from configuration. */
export async function postToWorkflow(webhookUrl: string): Promise<Response> {
  return fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(workflowWebhookBody(card)),
  });
}
