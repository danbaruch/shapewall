#!/usr/bin/env bash
# GitHub's Ubuntu runner restricts user namespaces for downloaded Chromium.
# Keep Chromium's sandbox enabled and scope the exception to this exact binary.
set -euo pipefail
audit_chrome_path=$(node --input-type=module -e "import { chromium } from 'playwright'; process.stdout.write(chromium.executablePath())")
case "$audit_chrome_path" in
  *\"*|*$'\n'*) exit 1 ;;
esac
audit_probe_dir="${RUNNER_TEMP:?}/shapewall-audit-sandbox-probe"
audit_probe_error="${RUNNER_TEMP}/shapewall-audit-sandbox-probe.err"
probe() {
  timeout 15 "$audit_chrome_path" --headless=new --no-first-run --disable-dev-shm-usage \
    --user-data-dir="$audit_probe_dir" --dump-dom about:blank >/dev/null 2>"$audit_probe_error"
}
if probe; then
  echo 'Audit Chromium starts with its sandbox enabled.'
  exit 0
fi
if ! grep -Eqi 'No usable sandbox|Failed to move to new namespace|user.?namespace|Operation not permitted' "$audit_probe_error"; then
  echo 'Audit Chromium failed its startup probe for a reason other than the runner namespace policy.'
  exit 1
fi
echo 'Startup probe reproduced the runner namespace restriction.'
printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile shapewall-audit-chrome "%s" flags=(unconfined) {\n  userns,\n}\n' "$audit_chrome_path" \
  | sudo tee /etc/apparmor.d/shapewall-audit-chrome >/dev/null
sudo apparmor_parser -r /etc/apparmor.d/shapewall-audit-chrome
probe
echo 'Audit Chromium starts with its sandbox enabled and an exact-binary namespace policy.'
