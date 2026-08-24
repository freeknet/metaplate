# Releasing Metaplate

GitHub Releases are the user-facing home for each version. They must explain why to upgrade, the important capabilities and fixes, migration requirements, installation, verification, and where to learn more. A generated pull-request list may supplement that information, but it must never replace it.

## Prepare the release

1. Update `package.json`, `package-lock.json`, `src/version.ts`, and `CHANGELOG.md` to the same version.
2. Copy `.github/RELEASE_TEMPLATE.md` to `.github/releases/vX.Y.Z.md`.
3. Replace every placeholder with user-facing copy. Summarize outcomes rather than commit titles.
4. For every framework-specific claim, link the exact official upstream page
   that defines the routing, metadata, build, adapter, or deployment behavior.
   Keep Metaplate's tested runtime/version boundary next to that link.
5. Include explicit upgrade advice and write `None.` under breaking changes when there is no migration.
6. Run the complete local gate:

   ```sh
   npm run check
   npm run check:package
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

After publication:

1. confirm npm provenance and registry integrity;
2. run the published-package smoke against the exact registry artifact;
3. update version-specific badges when applicable;
4. verify the GitHub release remains the best single overview of the version.
