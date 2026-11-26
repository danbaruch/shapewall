// Q7 C7: scripts/ci-chrome-sandbox.sh gives every installed Playwright
// headless shell its own AppArmor profile (one shared profile name left only
// the last binary covered). The loop is run with sudo and the AppArmor
// parser stood in for, on two fake headless shells.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const script = fs.readFileSync(new URL('../scripts/ci-chrome-sandbox.sh', import.meta.url), 'utf8')

test('C7: one AppArmor profile per headless shell version', { skip: process.platform === 'win32' }, (t) => {
  const start = script.indexOf('for shell_path in ')
  const end = script.indexOf('\ndone\n', start)
  assert.ok(start > 0 && end > start, 'the headless shell loop is in the script')
  const loop = script.slice(start, end + '\ndone\n'.length)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ci-chrome-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  for (const version of ['1100', '1200']) {
    const dir = path.join(home, '.cache', 'ms-playwright', `chromium_headless_shell-${version}`, 'chrome-headless-shell-linux64')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'chrome-headless-shell'), '#!/bin/sh\n', { mode: 0o755 })
  }
  const bin = path.join(home, 'bin')
  const out = path.join(home, 'out')
  fs.mkdirSync(bin)
  fs.mkdirSync(out)
  // sudo: "tee FILE" writes into out/, "apparmor_parser -r FILE" records the profile name.
  fs.writeFileSync(
    path.join(bin, 'sudo'),
    [
      '#!/bin/sh',
      'case "$1" in',
      '  tee) cat > "$OUT/$(basename "$2")" ;;',
      '  apparmor_parser) sed -n "s/^profile \\([^ ]*\\) .*/\\1/p" "$OUT/$(basename "$3")" >> "$OUT/parsed" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const run = spawnSync('bash', ['-euo', 'pipefail', '-c', loop], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, OUT: out },
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  const profiles = fs.readdirSync(out).filter((name) => name.startsWith('shapewall-agent-chrome-shell'))
  assert.equal(profiles.length, 2, `profiles: ${profiles.join(', ')}`)
  const parsed = fs.readFileSync(path.join(out, 'parsed'), 'utf8').trim().split('\n')
  assert.equal(new Set(parsed).size, 2, `profile names: ${parsed.join(', ')}`)
  for (const version of ['1100', '1200'])
    assert.ok(
      profiles.some((name) => fs.readFileSync(path.join(out, name), 'utf8').includes(`chromium_headless_shell-${version}/`)),
      `the ${version} binary has a profile`,
    )
})
