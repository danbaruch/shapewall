#!/usr/bin/env bash
# release-retention.sh: prune old release directories in ONE release lane.
#
#   release-retention.sh [--dry-run] [--keep N] [--keep-backups N] [--link-dir DIR]... LANE_ROOT
#
# LANE_ROOT holds releases/<name>/ plus a `current` symlink, and `previous` and/or `.previous-<name>`
# symlinks. Keeps `current`, `previous`, `.previous-<current>` and the newest others up to --keep (default 3)
# in total, and deletes older release dirs plus the `.previous-*` links that pointed at them. Optionally keeps
# the newest --keep-backups (default 5) `backups/pre-<rev>-<YYYYmmddTHHMMSSZ>` dirs (the release scripts' own
# data backups); nothing else in backups/ is touched.
#
# Every check runs again right before each delete. A release dir is KEPT (and the reason printed) when:
#   current / previous / .previous-<current> or a symlink in a --link-dir points at it; a file in LANE_ROOT
#   (deployment manifest), Caddy config or a systemd unit mentions its name; it sorts newer than current; it or
#   anything in it changed in the last 3 hours; it holds database files (*.db*, *.sqlite*); it holds an uploads
#   dir that differs from current's; a process runs from it; or anything about it cannot be checked.
#
# Always exits 0 after it starts (a warning is printed instead), so a deploy never fails because of retention.
# Same file in every repo that uses it: change it in one place and copy it (see the repo's release docs).
# Test overrides: RETENTION_NOW (epoch), RETENTION_MIN_AGE_SEC (10800), RETENTION_CONFIG_DIRS (space-separated).
set -uo pipefail

DRY=0 KEEP=3 KEEP_BACKUPS=5 LINK_DIRS=() LANE=
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY=1 ;;
    --keep) KEEP=${2:-}; shift ;;
    --keep-backups) KEEP_BACKUPS=${2:-}; shift ;;
    --link-dir) LINK_DIRS+=("${2:-}"); shift ;;
    -*) echo "[retention] unknown option $1" >&2; exit 2 ;;
    *) LANE=$1 ;;
  esac
  shift
done
[[ -n $LANE && $KEEP =~ ^[0-9]+$ && $KEEP_BACKUPS =~ ^[0-9]+$ ]] \
  || { echo "usage: release-retention.sh [--dry-run] [--keep N] [--keep-backups N] [--link-dir DIR]... LANE_ROOT" >&2; exit 2; }
[ "$KEEP" -ge 2 ] || { echo "[retention] --keep must be at least 2 (current + previous)" >&2; exit 2; }

NOW=${RETENTION_NOW:-$(date +%s)}
MIN_AGE=${RETENTION_MIN_AGE_SEC:-10800}
CONFIG_DIRS=${RETENTION_CONFIG_DIRS:-/etc/caddy /etc/systemd/system /run/systemd/system /usr/lib/systemd/system /lib/systemd/system}
say() { echo "[retention] $*"; }
warn() { echo "[retention] WARNING: $*" >&2; }

LANE=$(readlink -f -- "$LANE" 2>/dev/null) || { warn "lane root not found; nothing pruned"; exit 0; }
REL="$LANE/releases"
[ -d "$REL" ] || { warn "$REL missing; nothing pruned"; exit 0; }
exec 9<"$LANE" || { warn "cannot open lane for locking; nothing pruned"; exit 0; }
flock -x 9 || { warn "cannot lock release lane; nothing pruned"; exit 0; }
label=$LANE; [ "$DRY" = 1 ] && label="$LANE (dry run)"

# Release time for ordering: a timestamp at the start of the name (20261115T221227Z-..., 20261116-002603-...),
# else the RELEASED_AT file, else the dir's mtime.
release_time() {
  local d=$1 n=${1##*/} t
  if [[ $n =~ ^([0-9]{4})([0-9]{2})([0-9]{2})[T-]?([0-9]{2})([0-9]{2})([0-9]{2}) ]]; then
    t=$(date -u -d "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}" +%s 2>/dev/null) \
      && { echo "$t"; return 0; }
  fi
  if [ -f "$d/RELEASED_AT" ]; then
    t=$(date -u -d "$(head -c 64 "$d/RELEASED_AT")" +%s 2>/dev/null) && { echo "$t"; return 0; }
  fi
  stat -c %Y -- "$d"
}

# Fresh read of what is live: prints resolved targets of current, previous, .previous-<current> and --link-dir links.
protected_targets() {
  local cur l
  cur=$(readlink -f -- "$LANE/current") || return 1
  [ -d "$cur" ] && [ "${cur%/*}" = "$REL" ] || return 1
  echo "$cur"
  [ -L "$LANE/previous" ] && readlink -f -- "$LANE/previous"
  [ -L "$LANE/.previous-${cur##*/}" ] && readlink -f -- "$LANE/.previous-${cur##*/}"
  for l in "${LINK_DIRS[@]}"; do
    [ -d "$l" ] || continue
    find "$l" -maxdepth 1 -type l -exec readlink -f -- {} \; 2>/dev/null
  done
  return 0
}

# Prints why dir $1 must be kept, or nothing when it may be deleted. Runs right before a delete.
keep_reason() {
  local d=$1 n=${1##*/} cur prot t ct f u rel p
  [ -d "$d" ] && [ ! -L "$d" ] || { echo "not a plain directory"; return; }
  [ "$(readlink -f -- "$d")" = "$REL/$n" ] || { echo "resolves outside $REL"; return; }
  prot=$(protected_targets) || { echo "current is unreadable"; return; }
  cur=$(head -n1 <<<"$prot")
  [ "$d" = "$cur" ] && { echo "current"; return; }
  grep -qxF -- "$d" <<<"$prot" && { echo "previous / rollback link"; return; }
  while IFS= read -r -d '' f; do
    grep -qF -- "$n" "$f" 2>/dev/null && { echo "named in ${f}"; return; }
  done < <(find "$LANE" -maxdepth 1 -type f -print0 2>/dev/null)
  for p in $CONFIG_DIRS; do
    [ -e "$p" ] || continue
    f=$(grep -rlsF -- "$n" "$p" 2>/dev/null | head -n1)
    [ -n "$f" ] && { echo "named in $f"; return; }
  done
  t=$(release_time "$d") && ct=$(release_time "$cur") || { echo "cannot read release time"; return; }
  [ "$t" -gt "$ct" ] && { echo "newer than current"; return; }
  [ $(( NOW - $(stat -c %Y -- "$d") )) -lt "$MIN_AGE" ] && { echo "modified in the last $((MIN_AGE / 60)) min"; return; }
  f=$(find "$d" -newermt "@$(( NOW - MIN_AGE ))" -print -quit 2>/dev/null) || { echo "cannot scan"; return; }
  [ -n "$f" ] && { echo "has files modified in the last $((MIN_AGE / 60)) min (${f#$d/})"; return; }
  f=$(find "$d" \( -name '*.db' -o -name '*.db-*' -o -name '*.sqlite*' \) -print -quit 2>/dev/null)
  [ -n "$f" ] && { echo "holds database file ${f#$d/}"; return; }
  while IFS= read -r -d '' u; do
    rel=${u#$d/}
    [ -d "$cur/$rel" ] || { echo "holds $rel, which current lacks"; return; }
    diff -rq -- "$u" "$cur/$rel" >/dev/null 2>&1 || { echo "holds $rel, which differs from current's"; return; }
  done < <(find "$d" -type d -name uploads -not -path '*/node_modules/*' -print0 -prune 2>/dev/null)
  f=$(find /proc -mindepth 2 -maxdepth 2 -path '/proc/[0-9]*' \( -name cwd -o -name exe \) -printf '%l\n' 2>/dev/null \
    | awk -v d="$d" 'index($0, d "/") == 1 || $0 == d { print; exit }')
  [ -n "$f" ] && { echo "in use by a running process (${f})"; return; }
}

kib() { du -sk -- "$1" 2>/dev/null | cut -f1; }
pruned=0 freed=0 kept=0

prot=$(protected_targets) || { warn "$LANE/current is missing or broken; nothing pruned"; exit 0; }
cur=$(head -n1 <<<"$prot")
cur_t=$(release_time "$cur") || { warn "cannot read the release time of current; nothing pruned"; exit 0; }
say "$label: keeping $KEEP releases (current ${cur##*/})"

# Newest first. Live releases (current, previous, ...) count toward --keep; the newest other releases not newer
# than current fill the remaining slots; everything older goes through keep_reason before it is deleted.
mapfile -t sorted < <(
  for d in "$REL"/*/; do
    d=${d%/}; [ -d "$d" ] && [ ! -L "$d" ] || continue
    t=$(release_time "$d" 2>/dev/null) || t=9999999999
    printf '%s\t%s\n' "$t" "$d"
  done | sort -t$'\t' -k1,1nr -k2,2r
)
live=0
for row in "${sorted[@]}"; do grep -qxF -- "${row#*$'\t'}" <<<"$prot" && live=$((live + 1)); done
spare=$(( KEEP - live ))
for row in "${sorted[@]}"; do
  t=${row%%$'\t'*} d=${row#*$'\t'}
  if grep -qxF -- "$d" <<<"$prot"; then kept=$((kept + 1)); say "keep  ${d##*/}: live (current/previous)"; continue; fi
  if [ "$t" -gt "$cur_t" ]; then kept=$((kept + 1)); say "keep  ${d##*/}: newer than current"; continue; fi
  if [ "$spare" -gt 0 ]; then spare=$((spare - 1)); kept=$((kept + 1)); say "keep  ${d##*/}: within the newest $KEEP"; continue; fi
  why=$(keep_reason "$d")
  if [ -n "$why" ]; then kept=$((kept + 1)); say "keep  ${d##*/}: $why"; continue; fi
  k=$(kib "$d"); k=${k:-0}
  if [ "$DRY" = 1 ]; then
    say "would prune ${d##*/} ($((k / 1024)) MiB)"
  elif rm -rf --one-file-system -- "$d" && [ ! -e "$d" ]; then
    say "pruned ${d##*/} ($((k / 1024)) MiB)"
  else
    warn "could not fully remove $d"; continue
  fi
  pruned=$((pruned + 1)); freed=$((freed + k))
  for l in "$LANE"/.previous-*; do # rollback links that pointed at it
    [ -L "$l" ] && [ "$(readlink -m -- "$l")" = "$d" ] || continue
    if [ "$DRY" = 1 ]; then say "would remove link ${l##*/}"; else rm -f -- "$l" && say "removed link ${l##*/}"; fi
  done
done

# Data backups written by the release script itself: backups/pre-<rev>-<UTC stamp>, plain dirs only.
bpruned=0
if [ -d "$LANE/backups" ] && [ "$KEEP_BACKUPS" -gt 0 ]; then
  mapfile -t backups < <(
    find "$LANE/backups" -mindepth 1 -maxdepth 1 -type d -name 'pre-*' -printf '%f\n' 2>/dev/null \
      | grep -E '^pre-[0-9a-f]{7,40}-[0-9]{8}T[0-9]{6}Z$' \
      | awk -F- '{print $NF "\t" $0}' | sort -r | cut -f2-
  )
  i=0
  for b in "${backups[@]}"; do
    i=$((i + 1)); [ "$i" -le "$KEEP_BACKUPS" ] && continue
    d="$LANE/backups/$b"
    [ $(( NOW - $(stat -c %Y -- "$d") )) -lt "$MIN_AGE" ] && { say "keep  backups/$b: modified recently"; continue; }
    k=$(kib "$d"); k=${k:-0}
    if [ "$DRY" = 1 ]; then say "would prune backups/$b ($((k / 1024)) MiB)"
    elif rm -rf --one-file-system -- "$d" && [ ! -e "$d" ]; then say "pruned backups/$b ($((k / 1024)) MiB)"
    else warn "could not fully remove $d"; continue; fi
    bpruned=$((bpruned + 1)); freed=$((freed + k))
  done
fi

verb=pruned; [ "$DRY" = 1 ] && verb="would prune"
say "$label: $verb $pruned release(s) and $bpruned backup(s), $((freed / 1024)) MiB; $kept release(s) kept"
exit 0
