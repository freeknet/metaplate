# Releasing Metaplate

GitHub Releases are the user-facing home for each version. They must explain why to upgrade, the important capabilities and fixes, migration requirements, installation, verification, and where to learn more. A generated pull-request list may supplement that information, but it must never replace it.

## Prepare the release

1. Update `package.json`, `package-lock.json`, `src/version.ts`, and `CHANGELOG.md` to the same version.
2. Copy `.github/RELEASE_TEMPLATE.md` to `.github/releases/vX.Y.Z.md`.
3. Replace every placeholder with user-facing copy. Summarize outcomes rather than commit titles.
4. For every framework-specific or deployment claim, link the exact official
   upstream page that defines the routing, metadata, build, adapter, runtime, or
   deployment behavior. Keep Metaplate's tested runtime/version boundary next
   to that link.
5. Review the dependency inventory and record every Socket high/critical alert
   disposition. Do not describe `npm audit` as equivalent to Socket analysis;
   behavioral and native-code signals need their own evidence or an explicit
   time-bounded exception.
6. Include explicit upgrade advice and write `None.` under breaking changes when there is no migration.
7. Run the complete local gate:

   ```sh
   npm run check
   npm run check:package
   npm run check:dependencies
   ```

   `npm run check` validates the current version's release notes and rejects missing sections, placeholders, mismatched install commands, and generated-note-only bodies.

## Create the draft

After the release-preparation commits are on the target branch, run the **Prepare Release** workflow with the version tag and target ref. The workflow:

- confirms the tag matches `package.json`;
- validates `.github/releases/vX.Y.Z.md`;
- creates a new draft release or refreshes an existing draft;
- refuses to overwrite a published release.

Review the rendered draft on GitHub. Check links, code blocks, upgrade guidance, and the full changelog comparison before publishing it.

## Publish and verify

Publishing the GitHub draft triggers the npm publish workflow. That workflow validates the live GitHub release body again before it installs dependencies, builds, packs, or publishes anything. A release with incomplete notes therefore cannot publish the npm package.

After publication, the workflow waits for registry propagation and then installs
the exact registry version in a clean consumer. It verifies every export,
required/optional peer behavior, the CLI, npm registry signatures, and the SLSA
provenance attestation. A release is not complete until **Verify published
artifact** passes.

Then update version-specific badges when applicable and confirm the GitHub
release remains the best single overview of the version. For 0.7.0 deployment
claims, retain the provider/runtime evidence table and the dependency inventory
with the release artifacts.
