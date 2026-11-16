#!/usr/bin/env bash
# Deploy the built site to the web server as an immutable release with current/previous symlinks.
# Usage: website/deploy/deploy.sh                     build and release, check the live site, then prune old releases
#        website/deploy/deploy.sh rollback            swap current and previous
#        website/deploy/deploy.sh smoke               only the checks a release ends with, against the live site (read-only)
#        website/deploy/deploy.sh prune [--dry-run]   only the release retention (--dry-run prints the plan, deletes nothing)
# After the smoke checks pass, deploy/release-retention.sh keeps 3 releases on the host (current, previous and one more)
# and the newest 5 backups/pre-*, deletes older ones with its safety checks, and prints what it did. It never fails a
# deploy: a problem only warns. The same script ships in other release lanes; change it in one place and copy it.
# Env: SHAPEWALL_LAUNCHED (default 0: private early access; 1: launched, see website/README.md "Launch runbook"),
#      SHAPEWALL_STEALTH (default 1: noindex; 0: indexable), SHAPEWALL_UMAMI_ID (required for analytics),
#      DEPLOY_HOST (the ssh host to release to),
#      SHAPEWALL_ERROR_DSN (default: our GlitchTip project for shapewall.com and the demo; empty turns error reports off),
#      SHAPEWALL_ERROR_ENVIRONMENT (default production),
#      SHAPEWALL_SOURCEMAPS (default 1: upload the site's and the demo's source maps to our GlitchTip when
#      GLITCHTIP_UPLOAD_ENV names the file with the upload settings; every .map is deleted from the build either way),
#      SHAPEWALL_DEMO (default 1: build the live demo into dist/demo, and the fictional site it shows into
#      dist/lumen.html + dist/lumen/ and dist/lumen-staging.html + dist/lumen-staging/, with scripts/demo-export.js;
#      needs the root package installed and Playwright's Chromium),
#      SHAPEWALL_SITE_URL (default https://shapewall.com: where the smoke checks look).
set -euo pipefail
HOST="${DEPLOY_HOST:-droplet}"
ROOT=/var/www/shapewall.com
SITE="${SHAPEWALL_SITE_URL:-https://shapewall.com}"
cd "$(dirname "$0")/.."

# The checks a release ends with: each page answers 200. A failure exits nonzero and never rolls back by itself
# (run "deploy.sh rollback" for that), and old releases are then not pruned.
smoke() {
  local path code failed=0
  local paths=(/ /robots.txt /sitemap.xml /docs/getting-started)
  [ "${SHAPEWALL_DEMO:-1}" = 1 ] && paths+=(/demo/ /lumen)
  for path in "${paths[@]}"; do
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$SITE$path" || echo 000)
    if [ "$code" = 200 ]; then echo "smoke ok   $code $path"; else echo "smoke FAIL $code $path" >&2; failed=1; fi
  done
  [ "$failed" = 0 ] || { echo "smoke checks failed for $SITE (the release is live; deploy.sh rollback goes back)" >&2; return 1; }
  echo "smoke checks passed for $SITE"
}

# Release retention on the host (deploy/release-retention.sh, run there over ssh). $1 = --dry-run or empty.
prune() {
  ssh "$HOST" "bash -s -- ${1:-} --keep 3 --keep-backups 5 $ROOT" <deploy/release-retention.sh \
    || echo "[retention] WARNING: release retention failed; old releases not pruned (the release itself is fine)" >&2
}

if [ "${1:-}" = smoke ]; then
  smoke
  exit
fi
if [ "${1:-}" = prune ]; then
  [[ "${2:-}" == "" || "${2:-}" == --dry-run ]] || { echo "usage: deploy.sh prune [--dry-run]" >&2; exit 2; }
  prune "${2:-}"
  exit 0
fi
# Our own deployment reports its errors to our GlitchTip. This is the site's and the demo's setting only: the Shapewall
# package has no DSN and sends nothing unless whoever runs it sets SHAPEWALL_ERROR_DSN.
export SHAPEWALL_ERROR_DSN="${SHAPEWALL_ERROR_DSN-https://04e1aacf286d4ab6856abb994d59846e@errors.thiionlabs.com/3}"
export SHAPEWALL_ERROR_ENVIRONMENT="${SHAPEWALL_ERROR_ENVIRONMENT:-production}"
# Readable stack traces for those reports: the site and demo builds upload their source maps (scripts/sourcemaps.mjs).
export SHAPEWALL_SOURCEMAPS="${SHAPEWALL_SOURCEMAPS:-1}"
if [ "${1:-}" = rollback ]; then
  ssh "$HOST" "cd $ROOT && prev=\$(readlink previous) && cur=\$(readlink current) && ln -sfn \"\$prev\" current && ln -sfn \"\$cur\" previous && echo now \$prev"
  exit 0
fi
[ -n "$(git status --porcelain -- ..)" ] && { echo "the repo has uncommitted changes" >&2; exit 1; }
SHAPEWALL_STEALTH="${SHAPEWALL_STEALTH:-1}" npm run build
if [ "${SHAPEWALL_DEMO:-1}" = 1 ]; then
  (cd .. && npm run build && npm run build:demo) # the demo client (board + console + in-browser backend) the export copies
  node ../scripts/demo-export.js dist/demo --publish dist # the board, and its Lumen Notes site as /lumen and /lumen-staging
fi
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
ssh "$HOST" "mkdir -p $ROOT/releases/$STAMP"
tar -C dist -cf - . | ssh "$HOST" "tar -C $ROOT/releases/$STAMP -xf - && chown -R root:root $ROOT/releases/$STAMP && chmod -R a+rX $ROOT/releases/$STAMP"
ssh "$HOST" "cd $ROOT && { [ -L current ] && ln -sfn \"\$(readlink current)\" previous || true; } && ln -sfn releases/$STAMP current"
echo "released $STAMP"
smoke
prune
