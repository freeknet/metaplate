import {
  RemoteImageError,
  verifyRemoteImage,
  type RemoteFetchOptions,
  type RemoteImageErrorCode,
} from "metaplate/node";

/** Tighter than the defaults: a social card has no business being 16 MiB. */
const limits: RemoteFetchOptions = { maxBytes: 5_000_000, timeoutMs: 5_000, maxRedirects: 2 };

type DeployedCardCheck =
  | { ok: true; finalUrl: string; bytes: number }
  | { ok: false; code: RemoteImageErrorCode; message: string };

/**
 * Post-deploy check: the published card must be a 1200x630 PNG served as
 * image/png from a public address. Refusals come back as data; anything else,
 * such as a dimension mismatch, still throws.
 */
export async function checkDeployedCard(url: string): Promise<DeployedCardCheck> {
  try {
    const checked = await verifyRemoteImage(url, { width: 1200, height: 630, format: "png" }, limits);
    return { ok: true, finalUrl: checked.finalUrl, bytes: checked.byteLength };
  } catch (error) {
    if (error instanceof RemoteImageError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}
