#!/usr/bin/env bash
# Run on the release host for both activation and rollback.
set -euo pipefail
cd -- "$1"
exec 9<.
flock -x 9

for pointer in current previous; do
  if [[ -e "$pointer" && ! -L "$pointer" ]]; then
    echo "$pointer is not a release symlink" >&2
    exit 1
  fi
done

if [[ "$2" == rollback ]]; then
  [[ -L current ]] || { echo "No current release" >&2; exit 1; }
  target=$(readlink previous)
else
  target="releases/$2"
fi
[[ -d "$target" ]] || { echo "Missing release: $target" >&2; exit 1; }
# An activation can be retried after the connection carrying its reply is lost.
if [[ current -ef "$target" ]]; then
  echo "already $target"
  exit 0
fi
tmp=$(mktemp -d .switch-XXXXXXXX)
trap 'rm -f -- "$tmp/current" "$tmp/previous" "$tmp/backup"; rmdir -- "$tmp"' EXIT
ln -s -- "$target" "$tmp/current"
if [[ -L current ]]; then
  active=$(readlink current)
  [[ -d "$active" ]] || { echo "Current release is missing" >&2; exit 1; }
  if [[ -L previous ]]; then
    rollback=$(readlink previous)
    ln -s -- "$rollback" "$tmp/backup"
  fi
  ln -s -- "$active" "$tmp/previous"
  mv -Tf -- "$tmp/previous" previous
  if ! mv -Tf -- "$tmp/current" current; then
    if [[ -L "$tmp/backup" ]]; then mv -Tf -- "$tmp/backup" previous; else rm -- previous; fi
    exit 1
  fi
else
  mv -Tf -- "$tmp/current" current
fi
echo "now $target"
