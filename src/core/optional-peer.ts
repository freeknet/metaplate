export type MissingPeerError = Error & { missingPeer: string };

export type OptionalPeer = {
  /** Package name as it appears in `peerDependencies`. */
  package: string;
  /** Entry points that need the peer, used in the install guidance. */
  entries: string;
};

const MISSING_MODULE_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

/**
 * Reports whether the peer itself is missing. A resolution failure naming some
 * other specifier means the peer is installed but its own tree is incomplete,
 * and telling that consumer to install the peer would send them the wrong way.
 */
function isMissingPeer(error: unknown, packageName: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== "string" || !MISSING_MODULE_CODES.has(code)) return false;
  if (typeof message !== "string") return false;

  // Node quotes the specifier it could not resolve: `Cannot find package 'x'
  // imported from y`. Matching the quoted form distinguishes a missing peer
  // from a peer that appears unquoted as the importer of something else.
  return message.includes(`'${packageName}'`) || message.includes(`"${packageName}"`);
}

/** Identifies the error this module throws for a peer that is not installed. */
export function isMissingPeerError(error: unknown): error is MissingPeerError {
  return error instanceof Error && typeof (error as MissingPeerError).missingPeer === "string";
}

/**
 * Defers an optional peer import to first use so metadata-only and Next.js
 * installs never resolve the standalone renderer or its native binaries.
 * A missing peer becomes an install recipe; every other failure is untouched.
 */
export function optionalPeer<T>(
  peer: OptionalPeer,
  load: () => Promise<T>,
): () => Promise<T> {
  let pending: Promise<T> | undefined;

  return () => {
    // A rejected attempt is discarded so a later call can succeed once the
    // peer is installed, which keeps long-lived dev servers usable.
    pending ??= load().catch((cause: unknown) => {
      pending = undefined;
      if (!isMissingPeer(cause, peer.package)) throw cause;
      throw Object.assign(
        new Error(
          `Cannot find ${peer.package}, required by ${peer.entries}. ` +
            `Install it with: npm install ${peer.package}`,
          { cause },
        ),
        { missingPeer: peer.package },
      );
    });

    return pending;
  };
}

/**
 * Loads two peers together. An entry point needing both should report both in
 * one message rather than sending a consumer through consecutive installs.
 */
export async function loadPeerPair<A, B>(
  first: () => Promise<A>,
  second: () => Promise<B>,
  entries: string,
): Promise<[A, B]> {
  const settled = await Promise.allSettled([first(), second()]);
  const missing = settled
    .map((result) => (result.status === "rejected" ? (result.reason as unknown) : undefined))
    .filter((reason) => isMissingPeerError(reason))
    .map((reason) => reason.missingPeer);

  if (missing.length > 1) {
    throw new Error(
      `Cannot find ${missing.join(" and ")}, required by ${entries}. ` +
        `Install them with: npm install ${missing.join(" ")}`,
    );
  }
  for (const result of settled) {
    if (result.status === "rejected") throw result.reason as unknown;
  }

  return [
    (settled[0] as PromiseFulfilledResult<A>).value,
    (settled[1] as PromiseFulfilledResult<B>).value,
  ];
}
