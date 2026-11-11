# Capture on pull requests

Shapewall can capture your pages on every pull request and keep one comment on it up to date:

> **Shapewall: 4 of 23 pages changed**
>
> | Page               | Screen size       | Pixels changed |
> | ------------------ | ----------------- | -------------- |
> | Pricing (/pricing) | desktop 1440x2200 | 3.21%          |
> | Pricing (/pricing) | phone 390x1800    | 5.80%          |

It captures the base branch (before) and the pull request (after) with your normal config (pages, viewports, actions, setup and auth),
compares them page by page and viewport by viewport with the same pixel diff as compare mode, and links to the before, after and diff
images. Each push updates the same comment. When nothing changed, the comment says so in one collapsed line. When a page could not be
captured, the comment says which one and why. It is opt in: nothing runs until you commit the workflow, and it never fails the pull
request unless you ask it to.

## Set it up

In the repository, with a `shapewall.config.json` at its root:

```sh
npx shapewall init --ci
git add .github/workflows/shapewall.yml && git commit -m "Capture pages on pull requests"
```

`init --ci` writes `.github/workflows/shapewall.yml` (it never replaces an existing one without `--ci --force`, and never touches the
config). The workflow needs one decision: where the "after" site comes from.

### Build and serve mode (the default)

The job checks out the base branch and the pull request side by side and, in each, installs, builds and serves your site with the
commands in `ci.start`, waits for it to answer, and captures it:

```json
{
  "ci": {
    "start": {
      "install": ["npm", "ci"],
      "build": ["npm", "run", "build"],
      "serve": ["npm", "start"],
      "url": "http://127.0.0.1:3000",
      "timeout": 180000
    }
  }
}
```

Each command is an argv array: a program found on `PATH` and its arguments, run without a shell. `url` is the local address the serve
command listens on; `timeout` (default 180000 ms) bounds each step and the wait for the site. Both sides use the config of the pull
request, so they are captured the same way. See [config.md](config.md#ci) for every `ci` setting.

### Preview URL mode

If your host builds a deploy preview for each pull request, capture that instead and skip the build. Set `SHAPEWALL_PREVIEW_URL` in
the workflow's `env`:

```yaml
# Netlify-style deploy previews
SHAPEWALL_PREVIEW_URL: https://deploy-preview-${{ github.event.pull_request.number }}--YOUR-SITE.netlify.app
# Vercel branch URLs: the branch name, lower case, with "/" as "-"
SHAPEWALL_PREVIEW_URL: https://YOUR-PROJECT-git-${{ github.head_ref }}-YOUR-TEAM.vercel.app
```

The job waits up to 10 minutes for the preview to answer, then compares it with `SHAPEWALL_BASE_URL`, or with the config's `baseUrl`
(often production) when that is empty. A preview that answers before the new build is live gives an old "after": if your host keeps
serving the previous deploy while it builds, wait in a step of your own until the page shows the new commit.

## What the job does

The workflow has two jobs. The capture job builds and captures with a read-only token; the comment job writes the comment and
never sees the pull request's code.

**Capture** (`contents: read` only, no `GITHUB_TOKEN` in any step):

1. Checks out the pull request (and the base branch in build and serve mode) into `head/` and `base/`, with
   `persist-credentials: false`.
2. Installs the pinned Shapewall and Playwright once, with `npm install --ignore-scripts` in the runner's temp folder, with no user
   npm config: the pull request's `.npmrc` and `package.json` have no say. Every later step runs from that folder and calls the tools
   by absolute path, pointing at the checkout with `--config` and `--checkout`.
3. `shapewall ci enabled`: stops here when the config says `"ci": { "enabled": false }` or the title has `[skip shapewall]`.
4. Installs Chromium with the Playwright version this Shapewall captures with, and its system libraries. The browser download is cached.
5. Captures both sides (`shapewall ci capture` or `shapewall ci capture-compare --head-url`), then compares them.
6. Uploads the result folder, with a copy of `shapewall.config.json`, as the `shapewall-ci` workflow artifact (kept 14 days).

**Comment** (`contents: read` and `pull-requests: write`): no checkout. It downloads the artifact, installs Shapewall the same way
and runs `shapewall ci comment` on the result, which it treats as data. Only this step gets `GITHUB_TOKEN`.

The workflow runs on `pull_request` only (never `pull_request_target`), one run per pull request (a new push cancels the one still
going) and a 25 minute capture timeout.

## The result folder

`shapewall ci capture-compare --out DIR` writes:

- `summary.json`: schema `shapewall-ci-summary`, version 1. Totals (pages, changed pages, shots, changed, unchanged and failed shots,
  new and removed pages), then each page and viewport: `status` (`changed`, `unchanged`, `new`, `removed` or `failed`), `changed`,
  `ratio` (share of pixels changed), `changedPixels`, `dimensionsChanged` with both sizes, image paths, the error and any capture
  warnings. Also `failures` and `warnings` lists.
- `summary.md`: the comment body.
- `images/<page>.<viewport>/`: `before.png`, `after.png`, `diff.png` (the after shot faded, changed pixels in red) and a 320 pixel wide
  `.thumb.png` of each, for changed shots only.

A shot counts as changed when its share of changed pixels reaches `ci.threshold` (default 0.001, that is 0.1%) or its size changed.
A page that answers 404 before and loads after is a new page; the other way round, a removed page.

You can run it on your own machine too:

```sh
npx shapewall ci capture-compare --base-url https://www.example.com --head-url http://localhost:3000 --out shapewall-ci
npx shapewall ci capture-compare --base-dir before/ --head-dir after/ --out shapewall-ci   # two capture folders
```

A capture folder is what `shapewall capture` writes (`.shapewall/<board>/captures/`) or what `shapewall ci capture --url URL --out DIR`
writes. `ci.ignore` is applied while capturing, so it has no effect on folders captured without it.

## Images in the comment

A pull request comment cannot show files from a workflow artifact, so by default the comment links to the artifact (a zip download
for anyone who can see the run). Nothing is committed and no other service is used.

With `"ci": { "images": "branch" }`, the comment shows thumbnails inline: the job commits the images to an orphan branch named
`shapewall-ci` (under `pr-<number>/<commit>/`) and embeds them from it. The trade-offs:

- Public repositories only. Shapewall checks and falls back to links in a private repository, because the raw URLs would expose the
  images.
- The images are public and stay in the branch history until you delete the branch. Delete it any time; old comments then lose their
  pictures.
- The comment job needs `contents: write` in its `permissions` to push the branch. `shapewall init --ci` writes that when the config
  already has `"images": "branch"`; if you add the setting later, change `contents: read` to `contents: write` in the comment job (or
  run `shapewall init --ci --force`). Without it, the comment falls back to links and says why.

## Turning it off

- For good: delete `.github/workflows/shapewall.yml`.
- For a while, from the config: `"ci": { "enabled": false }`. The job then stops after the check step, before installing anything.
- For one pull request: put `[skip shapewall]` in its title. The job is skipped (the title is read when the run starts, so edit it
  before you push).

## Pull requests from forks

GitHub gives a fork's pull request a read-only token, so it cannot comment. Shapewall sees that (from the event, or a 403 when it
writes) and puts the summary in the job summary (the run's page) instead, without failing. The workflow uses `pull_request`, so a
fork's code never runs with your secrets or a write token.

## Costs in CI minutes

Most of a run is setup: the Chromium download (about a minute the first time, cached after that) plus the system libraries, then, in
build and serve mode, two installs and two builds. Capturing is quick: roughly one to three seconds per page and viewport, with the
config's `concurrency` shots at a time. Keep it small with `ci.pages` (an allow-list), `ci.viewports` and `ci.maxPages` (default
50). Concurrency cancels the run of an older push.

## Flaky shots

The capture is already deterministic where it can be: fixed viewport sizes, light color scheme, reduced motion, images awaited, and
for pull requests also web fonts loaded and the text caret hidden. What is left is usually your content:

- Clocks, dates, counters, ads, random avatars: list them in `ci.ignore` (CSS selectors). They are hidden (`visibility: hidden`, so the
  layout stays put) before the shot, on both sides.
- Third-party embeds and analytics: block them with `block` in the config.
- Animations a reduced-motion setting does not stop: wait for them with a `waitFor` or `waitForFunction` action on the page.
- Small rendering noise: raise `ci.threshold`, for example to 0.005.

## Privacy

The comment holds page titles, paths, screen sizes and percentages. The images are in the workflow artifact, which anyone who can see
the repository's runs can download: in a public repository, that is everyone. With `images: "branch"` they are also in a public
branch. Do not capture pages with private data this way in a public repository. Page titles and errors are written into the comment as
plain text: markdown, HTML and @mentions in them are neutralised.

## Security notes

- `ci.start` runs only from `shapewall ci capture --allow-start`, and only inside a CI job (`GITHUB_ACTIONS` or `CI` set to `true`). A
  config in a cloned repository never makes a Shapewall command on your own machine run something.
- Each command is an argv array: a string is refused (it would need a shell), as are paths (a program inside the repository), shells
  and launchers such as `sh`, `bash`, `env`, `sudo` and `xargs` that would turn the array back into a shell string. The commands get the
  job's environment without `GITHUB_TOKEN` and the Actions runtime tokens.
- The token goes only to `api.github.com`, or to an API URL the environment names (`SHAPEWALL_GITHUB_API_URL`, or `GITHUB_API_URL`,
  which the runner sets on GitHub Enterprise Server). An `apiUrl` that only the config names gets no token, and redirects are refused.
- Pull request text (title, branch name) never reaches a `run:` line of the workflow: it is used in `if:` conditions and `env` only.

## Commands

```text
shapewall ci capture-compare   --base-url URL --head-url URL | --base-dir DIR --head-dir DIR
                               [--out DIR] [--threshold RATIO] [--max-pages N] [--fail-on-change] [--json]
shapewall ci capture --out DIR --url URL | --allow-start [--checkout DIR]
shapewall ci comment [--dir DIR] [--artifact-url URL] [--repo OWNER/NAME --pull N] [--json]
shapewall ci enabled           writes enabled=true|false to $GITHUB_OUTPUT
shapewall ci wait --url URL [--timeout SECONDS]
```

`capture-compare` exits 0 whatever it found (3 with `--fail-on-change` when something changed, 1 on a usage or config error).
