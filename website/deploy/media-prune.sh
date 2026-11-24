#!/usr/bin/env bash
# Prunes the site's shared media folder on the host: LANE_ROOT/media/ holds every release's videos and posters (see
# deploy.sh), and a file stays as long as any release still on the host names it. Run on the host (deploy.sh media-prune
# sends it over ssh), after release retention has removed old releases.
# Usage: media-prune.sh [--yes] [--min-age-hours N] LANE_ROOT
#   Without --yes it only prints the plan (the default). With --yes it deletes the files it listed, and nothing else.
# Kept: every file named in releases/*/.media-manifest.json (each release carries the manifest it was built with, so
# current, previous and every other release retention kept are covered), and every file changed in the last N hours
# (default 3: a release being uploaded right now has sent its media but not its manifest yet). It refuses to prune when
# a release links media/ but has no manifest, or when no release has a manifest at all: then it cannot know what is used.
set -euo pipefail

YES=
MIN_AGE_HOURS=3
LANE=
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --min-age-hours)
      [ $# -ge 2 ] && [[ "$2" =~ ^[0-9]+$ ]] || { echo "media-prune: --min-age-hours needs a number" >&2; exit 2; }
      MIN_AGE_HOURS="$2"
      shift
      ;;
    -*) echo "media-prune: unknown option $1" >&2; exit 2 ;;
    *) [ -z "$LANE" ] || { echo "media-prune: one LANE_ROOT only" >&2; exit 2; }; LANE="$1" ;;
  esac
  shift
done
[ -n "$LANE" ] || { echo "usage: media-prune.sh [--yes] [--min-age-hours N] LANE_ROOT" >&2; exit 2; }
MEDIA="$LANE/media"
REL="$LANE/releases"
NAME='^[a-z0-9][a-z0-9-]*\.[0-9a-f]{10}\.(mp4|webm|jpg|webp|vtt)$'
say() { echo "[media-prune] $*"; }

[ -d "$MEDIA" ] && [ ! -L "$MEDIA" ] || { say "no media folder at $MEDIA; nothing to do"; exit 0; }

# Coordinate the snapshot of retained releases with activation, rollback and retention.
exec 9<"$LANE"
flock -x 9

declare -A KEEP=()
manifests=0
for d in "$REL"/*/; do
  d=${d%/}
  [ -d "$d" ] && [ ! -L "$d" ] || continue
  if [ -f "$d/.media-manifest.json" ]; then
    # Validate the whole manifest before allowing any deletions. A partial
    # list from a truncated file could otherwise make live media look unused.
    if ! names=$(python3 - "$d/.media-manifest.json" "$NAME" <<'PYTHON'
import json, re, sys

try:
    with open(sys.argv[1], encoding="utf-8") as f:
        videos = json.load(f)["videos"]
    if not isinstance(videos, dict) or not videos:
        raise ValueError("empty or invalid video list")
    for video in videos.values():
        sources = video["sources"]
        if not isinstance(sources, list) or not sources:
            raise ValueError("missing video sources")
        poster = video.get("poster", {})
        entries = sources + poster.get("webp", []) + video.get("tracks", [])
        if "jpg" in poster:
            entries = entries + [poster["jpg"]]
        for entry in entries:
            name = entry["file"]
            if not re.fullmatch(sys.argv[2], name):
                raise ValueError("invalid media name")
            print(name)
except (OSError, ValueError, TypeError, AttributeError, KeyError) as exc:
    sys.exit(f"could not validate media manifest: {exc}")
PYTHON
    ); then
      say "release ${d##*/}: invalid manifest; nothing pruned" >&2
      exit 1
    fi
    manifests=$((manifests + 1))
    while IFS= read -r name; do KEEP["$name"]=1; done <<<"$names"
    say "release ${d##*/}: manifest read"
  elif [ -L "$d/media" ]; then
    say "release ${d##*/} links media/ but has no .media-manifest.json: cannot tell what it uses; nothing pruned" >&2
    exit 1
  fi
done
[ "$manifests" -gt 0 ] || { say "no release has a media manifest; nothing pruned"; exit 0; }
say "${#KEEP[@]} files referenced by $manifests release manifests"

remove=()
kept=0
recent=0
while IFS= read -r -d '' file; do
  name=${file##*/}
  if [ -n "${KEEP[$name]:-}" ]; then
    kept=$((kept + 1))
  elif [ -n "$(find "$file" -maxdepth 0 -mmin "-$((MIN_AGE_HOURS * 60))" -print 2>/dev/null)" ]; then
    recent=$((recent + 1))
    say "keep (changed in the last $MIN_AGE_HOURS h): $name"
  elif [[ "$name" =~ $NAME ]]; then
    remove+=("$name")
  else
    say "keep (not a media file name, left alone): $name"
  fi
done < <(find "$MEDIA" -mindepth 1 -maxdepth 1 -type f -print0 | sort -z)

bytes=0
for name in "${remove[@]+"${remove[@]}"}"; do
  size=$(stat -c %s -- "$MEDIA/$name")
  bytes=$((bytes + size))
  say "remove: $name ($size bytes)"
done
say "kept $kept referenced, $recent recent; ${#remove[@]} unreferenced files, $bytes bytes"
if [ -z "$YES" ]; then
  say "dry run: nothing deleted (run with --yes to delete the files listed)"
  exit 0
fi
for name in "${remove[@]+"${remove[@]}"}"; do rm -f -- "$MEDIA/$name"; done
say "deleted ${#remove[@]} files"
