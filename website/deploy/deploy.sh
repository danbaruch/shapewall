#!/usr/bin/env bash
# Deploy the built site to the web server as an immutable release with current/previous symlinks.
# Usage: website/deploy/deploy.sh                     build and release, check the live site, then prune old releases
#        website/deploy/deploy.sh --dry-run           print what a release would build, upload and switch; runs nothing remote
#        website/deploy/deploy.sh media [--dry-run]   only upload the videos and posters to the shared media folder
#        website/deploy/deploy.sh media-prune [--yes] list (or, with --yes, delete) media files no release on the host uses
#        website/deploy/deploy.sh rollback            swap current and previous
#        website/deploy/deploy.sh smoke               only the checks a release ends with, against the live site (read-only)
#        website/deploy/deploy.sh prune [--dry-run]   only the release retention (--dry-run prints the plan, deletes nothing)
# After the smoke checks pass, deploy/release-retention.sh keeps 3 releases on the host (current, previous and one more)
# and the newest 5 backups/pre-*, deletes older ones with its safety checks, and prints what it did. It never fails a
# deploy: a problem only warns. The same script ships in other release lanes; change it in one place and copy it.
#
# Videos (README "Videos"): the files src/media.json names live in website/media/ (git-ignored) and, on the host, in one
# folder shared by every release, $ROOT/media/. Each name carries its content hash, so a file there never changes: a
# release uploads only the names the host does not have yet (into a temporary folder, then renamed into place, so a
# served name is never half written), checks every referenced file's size on the host, and only then uploads the
# release, whose own media/ is a symlink to ../../media. Releases stay small, rollback keeps working (an older release's
# files are still there), and release retention never touches media/ (it only removes release folders; a symlink inside
# one is removed as a link). A release never deletes a media file; only "deploy.sh media-prune --yes" does.
#
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

# The whole argument list is checked before anything runs: help, a misspelled command or a stray flag must never fall
# through to a release.
usage() {
  echo "usage: deploy.sh                     build and release, check the live site, then prune old releases"
  echo "       deploy.sh --dry-run           print what a release would build, upload and switch; runs nothing remote"
  echo "       deploy.sh media [--dry-run]   only upload the videos and posters to the shared media folder"
  echo "       deploy.sh media-prune [--yes] list media files no release on the host uses (--yes deletes them)"
  echo "       deploy.sh rollback            swap current and previous"
  echo "       deploy.sh smoke               only the checks a release ends with, against the live site (read-only)"
  echo "       deploy.sh prune [--dry-run]   only the release retention (--dry-run prints the plan, deletes nothing)"
}
COMMAND=release
DRY_RUN=
if [ $# -gt 0 ]; then
  COMMAND="$1"
  case "$COMMAND" in
    -h | --help | help) [ $# -eq 1 ] && {
      usage
      exit 0
    } ;;
    --dry-run) [ $# -eq 1 ] && COMMAND=release && DRY_RUN=1 ;;
    smoke | rollback) [ $# -eq 1 ] ;;
    prune | media) [ $# -eq 1 ] || { [ $# -eq 2 ] && [ "$2" = --dry-run ] && DRY_RUN=1; } ;;
    media-prune) [ $# -eq 1 ] || { [ $# -eq 2 ] && { [ "$2" = --dry-run ] || [ "$2" = --yes ]; }; } ;;
    *) false ;;
  esac || {
    echo "deploy.sh: unknown command or option: $*" >&2
    usage >&2
    exit 2
  }
fi

HOST="${DEPLOY_HOST:-droplet}"
ROOT=/var/www/shapewall.com
SITE="${SHAPEWALL_SITE_URL:-https://shapewall.com}"
cd "$(dirname "$0")/.."
MEDIA_LOCAL="${SHAPEWALL_MEDIA_DIR:-media}"
MANIFEST="${SHAPEWALL_MEDIA_MANIFEST:-src/media.json}"

# The checks a release ends with: each page answers 200, and so does one poster from the shared media folder (proof that
# the release's media link resolves). A failure exits nonzero and never rolls back by itself (run "deploy.sh rollback"
# for that), and old releases are then not pruned.
smoke() {
  local path code failed=0 poster
  local paths=(/ /robots.txt /sitemap.xml /docs/getting-started)
  [ "${SHAPEWALL_DEMO:-1}" = 1 ] && paths+=(/demo/ /lumen)
  poster=$(grep -oE 'launch-film-poster\.[0-9a-f]{10}\.jpg' "$MANIFEST" 2>/dev/null | head -n 1 || true)
  [ -n "$poster" ] && paths+=("/media/$poster")
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

# The media files the manifest references, as "name<TAB>bytes" lines (scripts/media-lib.mjs validates every name:
# lowercase letters, digits, dashes, a 10-hex hash and a known extension, so they are safe as shell words).
MEDIA_FILES=()
MEDIA_BYTES=()
media_read() {
  local name bytes
  MEDIA_FILES=()
  MEDIA_BYTES=()
  while IFS=$'\t' read -r name bytes; do
    [ -n "$name" ] || continue
    [[ "$name" =~ ^[a-z0-9][a-z0-9-]*\.[0-9a-f]{10}\.(mp4|webm|jpg|webp|vtt)$ ]] || { echo "[media] bad file name in the manifest: $name" >&2; exit 1; }
    MEDIA_FILES+=("$name")
    MEDIA_BYTES+=("$bytes")
  done < <(SHAPEWALL_MEDIA_DIR="$MEDIA_LOCAL" SHAPEWALL_MEDIA_MANIFEST="$MANIFEST" node scripts/media-lib.mjs files)
  # Every file must be here, at its size, before anything is sent (exits 1 with the list when not).
  SHAPEWALL_MEDIA_DIR="$MEDIA_LOCAL" SHAPEWALL_MEDIA_MANIFEST="$MANIFEST" node scripts/media-lib.mjs check
}

# Prints the media plan. $1 = the release stamp it would link, or empty.
media_plan() {
  local i total=0
  echo "[media] host $HOST, shared folder $ROOT/media/ (made if missing; never pruned by this script)"
  echo "[media] each file below is uploaded unless the host already has that name at that size (same name = same content):"
  for i in "${!MEDIA_FILES[@]}"; do
    printf '[media]   %12s bytes  %s/%s -> %s:%s/media/%s\n' "${MEDIA_BYTES[$i]}" "$MEDIA_LOCAL" "${MEDIA_FILES[$i]}" "$HOST" "$ROOT" "${MEDIA_FILES[$i]}"
    total=$((total + MEDIA_BYTES[i]))
  done
  echo "[media] ${#MEDIA_FILES[@]} files, $total bytes at most (only the missing ones travel)"
  echo "[media] upload into $ROOT/media/.incoming-<pid>/, then rename each into $ROOT/media/, then check every size on the host"
  [ -n "${1:-}" ] && echo "[media] the release links $ROOT/releases/$1/media -> ../../media (served at $SITE/media/...)"
  return 0
}

# Uploads the missing media files and checks all of them on the host. Fails (exit 1) before any release is switched.
media_upload() {
  local have i name missing=() bad=0 incoming
  have=$(ssh "$HOST" "mkdir -p $ROOT/media && chmod 755 $ROOT/media && find $ROOT/media -maxdepth 1 -type f -printf '%f\t%s\n'")
  for i in "${!MEDIA_FILES[@]}"; do
    grep -qxF "${MEDIA_FILES[$i]}"$'\t'"${MEDIA_BYTES[$i]}" <<<"$have" || missing+=("${MEDIA_FILES[$i]}")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "[media] uploading ${#missing[@]} of ${#MEDIA_FILES[@]} files"
    incoming="$ROOT/media/.incoming-$$"
    tar -C "$MEDIA_LOCAL" -cf - "${missing[@]}" | ssh "$HOST" "rm -rf $incoming && mkdir -p $incoming && tar -C $incoming --no-same-owner -xf - && chmod 644 $incoming/* && mv -f $incoming/* $ROOT/media/ && rmdir $incoming"
  else
    echo "[media] the host has all ${#MEDIA_FILES[@]} files"
  fi
  have=$(ssh "$HOST" "find $ROOT/media -maxdepth 1 -type f -printf '%f\t%s\n'")
  for i in "${!MEDIA_FILES[@]}"; do
    name="${MEDIA_FILES[$i]}"
    grep -qxF "$name"$'\t'"${MEDIA_BYTES[$i]}" <<<"$have" || { echo "[media] FAIL on the host: $name missing or wrong size" >&2; bad=1; }
  done
  [ "$bad" = 0 ] || { echo "[media] the host's media folder is incomplete; nothing was released" >&2; exit 1; }
  echo "[media] all ${#MEDIA_FILES[@]} files on the host, sizes checked"
}

if [ "$COMMAND" = smoke ]; then
  smoke
  exit
fi
if [ "$COMMAND" = prune ]; then
  prune "${2:-}"
  exit 0
fi
# Media pruning (deploy/media-prune.sh, run on the host): keeps every file a release still on the host names in its
# .media-manifest.json, and anything changed in the last 3 hours. A dry run unless --yes is given. Never part of a release.
if [ "$COMMAND" = media-prune ]; then
  if [ "${2:-}" = --yes ]; then
    ssh "$HOST" "bash -s -- --yes $ROOT" <deploy/media-prune.sh
  else
    ssh "$HOST" "bash -s -- $ROOT" <deploy/media-prune.sh
  fi
  exit
fi
if [ "$COMMAND" = media ]; then
  media_read
  if [ -n "$DRY_RUN" ]; then
    media_plan
    echo "[dry-run] nothing was uploaded"
  else
    media_upload
  fi
  exit 0
fi
# Our own deployment reports its errors to our GlitchTip. This is the site's and the demo's setting only: the Shapewall
# package has no DSN and sends nothing unless whoever runs it sets SHAPEWALL_ERROR_DSN.
export SHAPEWALL_ERROR_DSN="${SHAPEWALL_ERROR_DSN-https://04e1aacf286d4ab6856abb994d59846e@errors.thiionlabs.com/3}"
export SHAPEWALL_ERROR_ENVIRONMENT="${SHAPEWALL_ERROR_ENVIRONMENT:-production}"
# Readable stack traces for those reports: the site and demo builds upload their source maps (scripts/sourcemaps.mjs).
export SHAPEWALL_SOURCEMAPS="${SHAPEWALL_SOURCEMAPS:-1}"
# A release always checks its media: the build fails when a file src/media.json names is missing locally.
export SHAPEWALL_MEDIA_CHECK=1
if [ "$COMMAND" = rollback ]; then
  ssh "$HOST" "cd $ROOT && prev=\$(readlink previous) && cur=\$(readlink current) && ln -sfn \"\$prev\" current && ln -sfn \"\$cur\" previous && echo now \$prev"
  exit 0
fi
if [ -n "$DRY_RUN" ]; then
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
  [ -n "$(git status --porcelain -- ..)" ] && echo "[dry-run] note: the repo has uncommitted changes; a real release would stop here"
  echo "[dry-run] build: SHAPEWALL_STEALTH=${SHAPEWALL_STEALTH:-1} SHAPEWALL_LAUNCHED=${SHAPEWALL_LAUNCHED:-0} npm run build (fails if a media file is missing)"
  [ "${SHAPEWALL_DEMO:-1}" = 1 ] && echo "[dry-run] demo: npm run build && npm run build:demo in the repo root, then scripts/demo-export.js into dist/demo"
  media_read
  media_plan "$STAMP"
  echo "[dry-run] release: dist/ -> $HOST:$ROOT/releases/$STAMP/ (owned by root, world-readable), plus the media link above and .media-manifest.json (the manifest it was built with, for media-prune)"
  echo "[dry-run] switch: $ROOT/previous -> the old current, $ROOT/current -> releases/$STAMP"
  echo "[dry-run] then: smoke checks against $SITE, release retention (--keep 3; media/ untouched; deploy.sh media-prune lists unused media)"
  echo "[dry-run] nothing was built, uploaded or switched"
  exit 0
fi
[ -n "$(git status --porcelain -- ..)" ] && { echo "the repo has uncommitted changes" >&2; exit 1; }
media_read
SHAPEWALL_STEALTH="${SHAPEWALL_STEALTH:-1}" npm run build
if [ "${SHAPEWALL_DEMO:-1}" = 1 ]; then
  (cd .. && npm run build && npm run build:demo) # the demo client (board + console + in-browser backend) the export copies
  node ../scripts/demo-export.js dist/demo --publish dist # the board, and its Lumen Notes site as /lumen and /lumen-staging
fi
[ -e dist/media ] && { echo "dist/media exists: media files must never be inside a release" >&2; exit 1; }
# The release carries the manifest it was built with, so media-prune knows which files it uses.
cp "$MANIFEST" dist/.media-manifest.json
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
media_upload
ssh "$HOST" "mkdir -p $ROOT/releases/$STAMP"
tar -C dist -cf - . | ssh "$HOST" "tar -C $ROOT/releases/$STAMP -xf - && ln -sfn ../../media $ROOT/releases/$STAMP/media && chown -R root:root $ROOT/releases/$STAMP && chmod -R a+rX $ROOT/releases/$STAMP"
ssh "$HOST" "cd $ROOT && { [ -L current ] && ln -sfn \"\$(readlink current)\" previous || true; } && ln -sfn releases/$STAMP current"
echo "released $STAMP"
smoke
prune
