# Deno Deploy certification fixture

The app deployed for the dated Deno Deploy evidence in
`.planning/hosted-evidence/`, which `deployment-evidence.json` references
from the `deno-deploy` route. One Deno Deploy app serves both entry points:

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
is reproducible from a commit:

```sh
npm run login    # once: sign in through the browser; saved in the system keyring
npm run create   # once: create the app, built from GitHub, with this directory as the app directory
```

The org and app names are in `deno.json`. After `create`, every push to the
repository builds and deploys. The Deno Deploy GitHub app must have access to
the repository; `create` reports when it does not.

`deno.json`'s `deploy` section sets the build, and Deno Deploy reads it on
every build. The install step installs the repository root from its lockfile,
then runs `npm run setup`, which builds metaplate, packs it as
`metaplate.tgz`, and installs this app against that tarball.

### Why not `deno deploy` from this directory

Uploading a local directory is Deno Deploy's other route, and it does not work
for this org today. The server creates the revision but never reports which
files to upload, so the CLI waits until the build is cancelled after about
five minutes. That held across CLI 0.0.9904 and 0.0.9908, Windows and Linux,
and a new app. The report is
[denoland/deploy_feedback#954](https://github.com/denoland/deploy_feedback/issues/954).

### Sign-in and the `deno deploy` wrapper

`npm run login` and `npm run create` run Deno's built-in `deno deploy`, which
keeps the sign-in in the system keyring (Windows Credential Manager, macOS
Keychain, or Secret Service). Running the CLI with `deno run jsr:@deno/deploy`
instead cannot reach the keyring, so it asks for a browser sign-in on every
run. `DENO_DEPLOY_TOKEN`, when set, is used instead of the keyring.

Two workarounds live in `scripts/deploy-cli.ts`, which `deno deploy` loads
in place of the CLI through its `DENO_DEPLOY_CLI_SPECIFIER` hook:

- Deno 2.9.6 passes the CLI its arguments twice, and the CLI rejects every
  repeated option. The wrapper keeps one copy.
- The CLI has no login command, and its `whoami` gives up before showing a
  sign-in page. `npm run login` calls the CLI's own sign-in function, and
  opens a fresh page each time the last one expires.

`npm run create -- --trace` logs each request to Deno Deploy: method, path,
status, and for the build stream each update's status, steps, and label
keys. Headers and bodies are never printed.

## Card layout

The card sets `boxSizing: "border-box"`. Satori sizes boxes as content-box by
default, so 100% width and height plus padding grow the card past the canvas,
and a one-line title then renders below the visible area as a blank card.
