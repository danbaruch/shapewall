# Contributing to Shapewall

Thanks for helping. Bug reports, fixes, docs and ideas are all welcome. Please read the [Code of Conduct](CODE_OF_CONDUCT.md), and
report security problems privately as [SECURITY.md](SECURITY.md) describes, not in a public issue.

## Setup

You need Node.js 22.13 or newer.

```sh
git clone https://github.com/danbaruch/shapewall.git
cd shapewall
npm ci              # installs the locked dependencies and builds the clients (the prepare script)
npx playwright install chromium
npm test            # unit tests (node --test)
npm run test:e2e    # Playwright: captures the demo site and drives the board
npm run lint        # ESLint + Prettier check
npm run demo        # the demo board at http://127.0.0.1:4600/
```

For client work, run `npm run demo -- --no-capture` (or `shapewall serve`) in one terminal and `npm run dev` in another: Vite serves the
client on port 5173 with hot reload and proxies `/api` to port 4600.

The unit suite runs four files at a time and the end-to-end suite one file at a time, so a laptop stays usable.

## Pull requests

- One topic per pull request, with a short description of what and why.
- Add or update tests: unit tests in `test/*.test.js`, browser flows in `test/e2e/`. Sanitizer changes need a test that shows what is
  now allowed or blocked.
- Run the checks below and say in the pull request what you ran.
- Update `README.md` and `docs/` when behaviour, a command or a config key changes, and add a line to `CHANGELOG.md` under "Unreleased".
  The website shows the guides in `docs/` as they are, so there is no second copy to edit.
- UI changes: include a screenshot at desktop and phone width. Touch targets stay at least 44 px.
- No private data in code, fixtures or screenshots: no real URLs, tokens or page content.

## Checks before you open a pull request

CI runs lint, the unit tests, the build, the package check and the website tests on every pull request (Node 22, Linux). Run them on
your machine first:

```sh
npm run lint
npm test
npm run build
npm run check:pack    # the npm tarball has the runtime and nothing from development
```

Then the parts that match your change (CI does not run the browser suite on pull requests, so say in the pull request which of
these you ran):

- **Board, capture or sign-in changes:** `npm run build:demo` and `npm run test:e2e` (or the e2e files that cover what you touched,
  for example `node --test test/e2e/board.e2e.test.js`). Look at the changed screens at desktop and phone width, down to 320 px, and
  check the browser console.
- **`website/`:** `npm ci`, `npm run build` and `npm test` in that folder.
- **Docker files** (`Dockerfile*`, `.dockerignore`, the lockfile): build the image and run the smoke steps in
  [the deployment guide](docs/deployment.md#in-docker).

## Ground rules for the live HTML path

The sanitizer, the live CSP and the iframe sandbox are the security boundary. Changes there must keep all three layers independent: never
rely on one to make another safe, and never add `allow-scripts` to the frame or a script source to the CSP.

## Code style

Prettier (no semicolons, single quotes, 140 columns) and ESLint. Plain JavaScript (ESM), Node 22+. Comments explain why, not what.

## Releasing

A release is a tag. Nobody publishes from a laptop, and no npm token or approval is involved.

1. Move "Unreleased" in `CHANGELOG.md` under a new `## X.Y.Z` heading and set the same version in `package.json` (and
   `package-lock.json`, with `npm version X.Y.Z --no-git-tag-version`).
2. Open a pull request, let CI pass and merge it.
3. Tag the merged commit and push the tag:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. The publish workflow (`.github/workflows/publish.yml`) checks that the tag matches `package.json`, runs the checks, publishes the
   package to npm with provenance through npm trusted publishing, and creates the GitHub Release from that version's section of
   `CHANGELOG.md`. A version already on npm is skipped, so pushing the tag again is harmless.

## License of contributions

By contributing you agree that your contributions are licensed under the Apache License, Version 2.0 (see `LICENSE`), or, for files
in `src/hosted`, under the Functional Source License 1.1 with the Apache 2.0 future license (see `src/hosted/LICENSE.md`).
