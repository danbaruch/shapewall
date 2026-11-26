#!/usr/bin/env bash
# The OS sandbox for agent commands (src/agent/sandbox-exec.js) on GitHub's
# Ubuntu runner: bubblewrap needs unprivileged user namespaces, which the
# runner's AppArmor policy restricts. Probe first; relax the restriction only
# if the probe hits it; if bubblewrap still cannot start, say so visibly and
# let the tests skip (SHAPEWALL_SANDBOX_TEST=0) instead of failing quietly.
set -euo pipefail
err="${RUNNER_TEMP:?}/bwrap-probe.err"
# As src/agent/sandbox-exec.js probes it: bubblewrap, and a user namespace inside it (the runtime's seccomp helper makes one).
probe() { bwrap --unshare-all --die-with-parent --ro-bind / / --dev /dev --proc /proc unshare -U -r true 2>"$err"; }
if probe; then
  echo 'bubblewrap starts with --unshare-all, and a user namespace inside it.'
  echo 'SHAPEWALL_SANDBOX_TEST=1' >>"$GITHUB_ENV"
  exit 0
fi
echo "bubblewrap probe failed: $(head -c 300 "$err")"
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
if probe; then
  echo 'bubblewrap starts once the runner allows unprivileged user namespaces.'
  echo 'SHAPEWALL_SANDBOX_TEST=1' >>"$GITHUB_ENV"
  exit 0
fi
echo '::notice title=Sandbox tests skipped::bubblewrap cannot start on this runner, so the OS sandbox integration tests are skipped.'
echo 'SHAPEWALL_SANDBOX_TEST=0' >>"$GITHUB_ENV"
