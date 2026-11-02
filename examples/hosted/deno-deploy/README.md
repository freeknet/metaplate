# Deno Deploy certification fixture

The app deployed for the dated Deno Deploy evidence in
[`.planning/hosted-evidence/deno-deploy-2026-11-01.json`](https://github.com/lnorton89/metaplate/blob/main/.planning/hosted-evidence/deno-deploy-2026-11-01.json),
which `deployment-evidence.json` references from the `deno-deploy-edge` and
`deno-deploy-node` routes. One Deno Deploy app serves both entry points:

| Path | Entry point | Renderer |
| --- | --- | --- |
| `/og/:slug` | `metaplate/edge` `fetchableFrom` | `@resvg/resvg-wasm`, with `resvg.wasm` and `layout.wasm` read from `node_modules` |
| `/og-node/:slug` | `metaplate/node` `fetchableFrom` | the native `@resvg/resvg-js` binding |
| `/` | | JSON naming the Deno version and the packed metaplate (version, SHA-256, commit) |

It is excluded from `tsconfig.examples.json` because it resolves `metaplate`
from a packed tarball, not from `src/`.

## Run it locally

```sh
npm run setup   # build and pack metaplate from this checkout, then install
npm start       # http://localhost:8000/og/hello and /og-node/hello
```

`METAPLATE_PORT` changes the port. Deno comes from npm (`deno@2.9.6`), so
nothing needs installing globally.

## Deploy it

Deno Deploy builds this directory from the GitHub repository, so a deployment
is reproducible from a commit. One-time setup:

1. Install the Deno Deploy GitHub app (`github.com/apps/deno-deploy`) on the
   repository.
2. Create an organization access token in the Deno Deploy console under
   **Settings > Access Tokens**, and save it as the `DENO_DEPLOY_TOKEN`
   environment variable. On Windows a user environment variable works even
   in shells started before it was set.
3. `npm run create` creates the app named in `deno.json`, built from GitHub,
   with this directory as the app directory.

After that, every push builds and deploys: the default branch to the
production timeline, other branches to their own branch timelines
(`https://<app>--<branch>.<org>.deno.net`).

```sh
npm run builds                      # latest builds of the app
npm run build-logs -- <revision>    # one build's log; add a step such as installing
```

Both read Deno Deploy's REST API (`https://api.deno.com/v2`) with the token
as a Bearer header, and never print it.

`deno.json`'s `deploy` section sets the build, and Deno Deploy reads it on
every build. The install step installs the repository root from its lockfile,
then runs `npm run setup`, which builds metaplate, packs it as
`metaplate.tgz`, and installs this app against that tarball. It then deletes
the root `node_modules` and `dist`: they are only needed to build the tarball,
and with them the deployment reaches about 940 MB on Linux, near Deno
Deploy's documented 1 GB limit for a deployment's files. Without them the
certified build's artifact was 26.6 MB. The build
environment fetches the newest npm (12 at the time of writing), whose
`npm pack --json` prints an object rather than an array;
`scripts/package/npm-pack-result.mjs` at the repository root reads both.

### Why not `deno deploy` from this directory

Uploading a local directory is Deno Deploy's other route, and it does not work
for this org today. The server creates the revision but never reports which
files to upload, so the CLI waits until the build is cancelled after about
five minutes. That held across CLI 0.0.9904 and 0.0.9908, Windows and Linux,
and a new app. The report is
[denoland/deploy_feedback#954](https://github.com/denoland/deploy_feedback/issues/954).

### The `deno deploy` wrapper

`npm run create` runs Deno's built-in `deno deploy`, which reads
`DENO_DEPLOY_TOKEN` (or, without it, a sign-in kept in the system keyring;
`npm run login` signs in through the browser once). The built-in command
loads `scripts/deploy-cli.ts` in place of the CLI through its
`DENO_DEPLOY_CLI_SPECIFIER` hook, because Deno 2.9.6 passes the CLI its
arguments twice and the CLI rejects every repeated option. The wrapper keeps
one copy. `npm run create -- --trace` logs each request to Deno Deploy without
headers or bodies.

## Card layout

The card sets `boxSizing: "border-box"`. Satori sizes boxes as content-box by
default, so 100% width and height plus padding grow the card past the canvas,
and a one-line title then renders below the visible area as a blank card.
