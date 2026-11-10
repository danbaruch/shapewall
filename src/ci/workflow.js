// The GitHub Actions workflow `shapewall init --ci` writes to
// .github/workflows/shapewall.yml. It pins this Shapewall's version and the
// Playwright version it captures with, so the job runs what was tested here.

import fs from 'node:fs'

export const WORKFLOW_FILE = '.github/workflows/shapewall.yml'

const PACKAGE = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

export function workflowYaml({ version = PACKAGE.version, playwright = PACKAGE.dependencies.playwright } = {}) {
  return `# Shapewall: capture on every pull request.
#
# On each pull request (and each push to it) this job captures the pages in
# shapewall.config.json twice, before (the base branch) and after (the pull
# request), compares them pixel by pixel and keeps one comment on the pull
# request up to date, such as "Shapewall: 4 of 23 pages changed", with a table
# and a link to the before, after and diff images. It never fails the pull
# request: capture problems are reported in the comment.
#
# Two modes. Pick one with SHAPEWALL_PREVIEW_URL below.
#
#   Build and serve (SHAPEWALL_PREVIEW_URL empty, the default): the job checks
#   out the base branch and the pull request side by side and, in each, runs
#   the install, build and serve commands from "ci.start" in the config, waits
#   for "ci.start.url" to answer and captures it. Example config:
#     "ci": { "start": { "install": ["npm", "ci"], "build": ["npm", "run", "build"],
#             "serve": ["npm", "start"], "url": "http://127.0.0.1:3000" } }
#
#   Preview URL: set SHAPEWALL_PREVIEW_URL to the deploy preview of this pull
#   request. The job waits until it answers, then compares it with
#   SHAPEWALL_BASE_URL (empty: "baseUrl" in the config, such as production).
#
# Turn it off: delete this file; or set "ci": { "enabled": false } in
# shapewall.config.json; or put [skip shapewall] in a pull request title.
# Guide: https://shapewall.com/docs/pull-requests

name: Shapewall

on:
  # pull_request only: a fork's pull request then runs with a read-only token
  # and no secrets. Never use pull_request_target for this workflow.
  pull_request:
    types: [opened, synchronize, reopened]


# Least privilege: the capture job, which builds and runs the pull request's
# code, can only read. Only the comment job, which runs no code from the pull
# request, can write the one comment.
permissions:
  contents: read

# One run per pull request: a new push cancels the run still going.
concurrency:
  group: shapewall-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  shapewall:
    name: Shapewall capture
    # Skip: put [skip shapewall] anywhere in the pull request title.
    if: \${{ !contains(github.event.pull_request.title, '[skip shapewall]') }}
    runs-on: ubuntu-latest
    timeout-minutes: 25
    permissions:
      contents: read
    outputs:
      enabled: \${{ steps.gate.outputs.enabled }}
      artifact-url: \${{ steps.upload.outputs.artifact-url }}
    env:
      SHAPEWALL: shapewall@${version}
      PLAYWRIGHT: playwright@${playwright}
      # Preview URL mode: the deploy preview of this pull request; empty for build and serve mode.
      # Netlify-style deploy previews:
      #   SHAPEWALL_PREVIEW_URL: https://deploy-preview-\${{ github.event.pull_request.number }}--YOUR-SITE.netlify.app
      # Vercel branch URLs (the branch name, lower case, with "/" as "-"; check one in your Vercel dashboard):
      #   SHAPEWALL_PREVIEW_URL: https://YOUR-PROJECT-git-\${{ github.head_ref }}-YOUR-TEAM.vercel.app
      SHAPEWALL_PREVIEW_URL: ''
      # Preview URL mode: what to compare with (empty: "baseUrl" in the config).
      SHAPEWALL_BASE_URL: ''
      HEAD_DIR: \${{ github.workspace }}/head
      BASE_DIR: \${{ github.workspace }}/base
      OUT: \${{ github.workspace }}/shapewall-ci
    steps:
      - name: Check out the pull request
        uses: actions/checkout@v4
        with:
          path: head
          persist-credentials: false

      - name: Check out the base branch (build and serve mode)
        if: env.SHAPEWALL_PREVIEW_URL == ''
        uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          path: base
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # The pinned tools go in the runner's temp folder, installed from there:
      # the pull request's .npmrc and package.json have no say, and every
      # later step calls them by absolute path from that folder.
      - name: Install Shapewall and Playwright (outside the checkout)
        working-directory: \${{ runner.temp }}
        env:
          NPM_CONFIG_USERCONFIG: /dev/null
        run: |
          mkdir -p shapewall-tools
          cd shapewall-tools
          printf '{ "private": true }\\n' > package.json
          npm install --no-audit --no-fund --ignore-scripts --registry https://registry.npmjs.org/ "$SHAPEWALL" "$PLAYWRIGHT"
          echo "SW=$PWD/node_modules/.bin/shapewall" >> "$GITHUB_ENV"
          echo "PW=$PWD/node_modules/.bin/playwright" >> "$GITHUB_ENV"

      # "ci": { "enabled": false } in the config, or [skip shapewall] in the title, stops here.
      - name: Is Shapewall on for this pull request?
        id: gate
        continue-on-error: true
        working-directory: \${{ runner.temp }}
        run: '"$SW" ci enabled --config "$HEAD_DIR/shapewall.config.json"'

      - name: Cache the browser download
        if: steps.gate.outputs.enabled == 'true'
        id: browser-cache
        uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: shapewall-chromium-\${{ runner.os }}-${playwright}

      - name: Install Chromium and its system libraries
        continue-on-error: true
        if: steps.gate.outputs.enabled == 'true' && steps.browser-cache.outputs.cache-hit != 'true'
        working-directory: \${{ runner.temp }}
        run: '"$PW" install --with-deps chromium'

      - name: Install the system libraries Chromium needs (browser from the cache)
        continue-on-error: true
        if: steps.gate.outputs.enabled == 'true' && steps.browser-cache.outputs.cache-hit == 'true'
        working-directory: \${{ runner.temp }}
        run: '"$PW" install-deps chromium'

      # Preview URL mode.
      - name: Wait for the deploy preview
        if: steps.gate.outputs.enabled == 'true' && env.SHAPEWALL_PREVIEW_URL != ''
        continue-on-error: true
        working-directory: \${{ runner.temp }}
        run: '"$SW" ci wait --url "$SHAPEWALL_PREVIEW_URL" --timeout 600'

      - name: Capture and compare (preview URL mode)
        if: steps.gate.outputs.enabled == 'true' && env.SHAPEWALL_PREVIEW_URL != ''
        continue-on-error: true
        working-directory: \${{ runner.temp }}
        run: '"$SW" ci capture-compare --config "$HEAD_DIR/shapewall.config.json" --base-url "$SHAPEWALL_BASE_URL" --head-url "$SHAPEWALL_PREVIEW_URL" --out "$OUT/result"'

      # Build and serve mode: ci.start runs only here, because of --allow-start,
      # in the checkout --checkout names.
      - name: Capture the base branch (build and serve mode)
        if: steps.gate.outputs.enabled == 'true' && env.SHAPEWALL_PREVIEW_URL == ''
        continue-on-error: true
        working-directory: \${{ runner.temp }}
        run: '"$SW" ci capture --config "$HEAD_DIR/shapewall.config.json" --allow-start --checkout "$BASE_DIR" --out "$OUT/base"'

      - name: Capture the pull request (build and serve mode)
        if: steps.gate.outputs.enabled == 'true' && env.SHAPEWALL_PREVIEW_URL == ''
        continue-on-error: true
        working-directory: \${{ runner.temp }}
        run: '"$SW" ci capture --config "$HEAD_DIR/shapewall.config.json" --allow-start --checkout "$HEAD_DIR" --out "$OUT/head"'

      - name: Compare (build and serve mode)
        if: steps.gate.outputs.enabled == 'true' && env.SHAPEWALL_PREVIEW_URL == ''
        continue-on-error: true
        working-directory: \${{ runner.temp }}
        run: '"$SW" ci capture-compare --config "$HEAD_DIR/shapewall.config.json" --base-dir "$OUT/base" --head-dir "$OUT/head" --out "$OUT/result"'

      # The comment job reads the config from here: it never checks out the pull request.
      - name: Keep the config with the result
        if: always() && steps.gate.outputs.enabled == 'true'
        continue-on-error: true
        run: mkdir -p "$OUT/result" && cp "$HEAD_DIR/shapewall.config.json" "$OUT/result/shapewall.config.json"

      - name: Keep the images as a workflow artifact
        id: upload
        if: always() && steps.gate.outputs.enabled == 'true'
        continue-on-error: true
        uses: actions/upload-artifact@v4
        with:
          name: shapewall-ci
          path: shapewall-ci/result
          retention-days: 14
          if-no-files-found: ignore

  comment:
    name: Shapewall comment
    needs: shapewall
    # No checkout and no code from the pull request: the result is data.
    if: always() && needs.shapewall.outputs.enabled == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    # For "ci.images": "branch" (public repositories only) also set contents: write.
    permissions:
      contents: read
      pull-requests: write
    env:
      SHAPEWALL: shapewall@${version}
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Download the result
        continue-on-error: true
        uses: actions/download-artifact@v4
        with:
          name: shapewall-ci
          path: \${{ runner.temp }}/shapewall-result

      - name: Install Shapewall
        working-directory: \${{ runner.temp }}
        env:
          NPM_CONFIG_USERCONFIG: /dev/null
        run: |
          mkdir -p shapewall-tools
          cd shapewall-tools
          printf '{ "private": true }\\n' > package.json
          npm install --no-audit --no-fund --ignore-scripts --registry https://registry.npmjs.org/ "$SHAPEWALL"
          echo "SW=$PWD/node_modules/.bin/shapewall" >> "$GITHUB_ENV"

      - name: Comment on the pull request
        continue-on-error: true
        working-directory: \${{ runner.temp }}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          ARTIFACT_URL: \${{ needs.shapewall.outputs.artifact-url }}
        run: '"$SW" ci comment --config "$RUNNER_TEMP/shapewall-result/shapewall.config.json" --dir "$RUNNER_TEMP/shapewall-result" --artifact-url "$ARTIFACT_URL"'
`
}
