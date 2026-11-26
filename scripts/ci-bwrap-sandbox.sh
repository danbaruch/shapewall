#!/usr/bin/env bash
# The OS sandbox for agent commands (src/agent/sandbox-exec.js) on GitHub's
# Ubuntu runner: bubblewrap needs unprivileged user namespaces, one inside
# another (the runtime's seccomp helper makes the inner one), which the
# runner's AppArmor policy confines. Probe first; if the probe fails, give
# a copy of bwrap an exact-binary AppArmor profile that allows user
# namespaces (nothing runner-wide is changed). If bubblewrap still cannot
# start, the job fails: the sandbox tests never skip in this job.
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
echo '::error title=Sandbox does not start::bubblewrap cannot start on this runner, so the OS sandbox tests cannot run.'
exit 1
