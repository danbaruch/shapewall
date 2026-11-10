#!/usr/bin/env bash
# Deploy the built site to the web server as an immutable release with current/previous symlinks.
# Usage: website/deploy/deploy.sh            build and release
#        website/deploy/deploy.sh rollback   swap current and previous
# Env: SHAPEWALL_LAUNCHED (default 0: private early access; 1: launched, see website/README.md "Launch runbook"),
#      SHAPEWALL_STEALTH (default 1: noindex; 0: indexable), SHAPEWALL_UMAMI_ID (required for analytics),
#      DEPLOY_HOST (the ssh host to release to),
#      SHAPEWALL_DEMO (default 1: build the live demo into dist/demo, and the fictional site it shows into
#      dist/lumen.html + dist/lumen/ and dist/lumen-staging.html + dist/lumen-staging/, with scripts/demo-export.js;
#      needs the root package installed and Playwright's Chromium).
set -euo pipefail
HOST="${DEPLOY_HOST:-droplet}"
ROOT=/var/www/shapewall.com
cd "$(dirname "$0")/.."
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
ssh "$HOST" "cd $ROOT && { [ -L current ] && ln -sfn \"\$(readlink current)\" previous || true; } && ln -sfn releases/$STAMP current && ls -1 releases | head -n -5 | sed 's|^|releases/|' | xargs -r rm -rf"
echo "released $STAMP"
