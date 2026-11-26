#!/usr/bin/env bash
# The OS sandbox for agent commands (src/agent/sandbox-exec.js) on GitHub's
# Ubuntu runner: bubblewrap needs unprivileged user namespaces, one inside
# another (the runtime's seccomp helper makes the inner one), which the
# runner's AppArmor policy restricts. Probe first; relax the restriction only
# if the probe hits it; if bubblewrap still cannot start, say so visibly and
# let the tests skip (SHAPEWALL_SANDBOX_TEST=0) instead of failing quietly.
set -euo pipefail
err="${RUNNER_TEMP:?}/bwrap-probe.err"
# As src/agent/sandbox-exec.js probes it.
probe() { bwrap --unshare-all --die-with-parent --ro-bind / / --dev /dev --proc /proc unshare -U -r true 2>"$err"; }
ok() {
  echo "$1"
  echo 'SHAPEWALL_SANDBOX_TEST=1' >>"$GITHUB_ENV"
  exit 0
}
if probe; then ok 'bubblewrap starts with --unshare-all, and a user namespace inside it.'; fi
echo "bubblewrap probe failed: $(head -c 300 "$err")"
# 1. The kernel switch Ubuntu uses for the restriction.
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  echo "kernel.apparmor_restrict_unprivileged_userns=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)"
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  if probe; then ok 'bubblewrap starts once the runner allows unprivileged user namespaces.'; fi
fi
# 2. Ubuntu's own bwrap profile confines what runs inside it: a copy of
# bwrap with an exact-binary profile that allows user namespaces, first on PATH.
if command -v apparmor_parser >/dev/null; then
  sudo install -m 0755 "$(command -v bwrap)" /usr/local/bin/bwrap
  printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile shapewall-ci-bwrap /usr/local/bin/bwrap flags=(unconfined) {\n  userns,\n}\n' \
    | sudo tee /etc/apparmor.d/shapewall-ci-bwrap >/dev/null
  sudo apparmor_parser -r /etc/apparmor.d/shapewall-ci-bwrap
  hash -r
  echo "bwrap is now $(command -v bwrap)"
  if probe; then ok 'bubblewrap starts with an exact-binary AppArmor profile for this runner.'; fi
  echo "still failing: $(head -c 300 "$err")"
fi
echo '::notice title=Sandbox tests skipped::bubblewrap cannot start on this runner, so the OS sandbox integration tests are skipped.'
echo 'SHAPEWALL_SANDBOX_TEST=0' >>"$GITHUB_ENV"
