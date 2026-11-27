// Shapewall 2.0 removals (R7): every spelling deprecated through 1.x is now a
// one-line error that names its replacement, never an unknown-command or
// unknown-option error; and the spellings kept through 2.x (serve --lan,
// serve --accounts, devices, starterAgent.testCommand) still work with a
// warning that says 3.0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { main } from '../src/cli.js'
import { REMOVED_IN, deprecated, removed, setDeprecationSink } from '../src/deprecation.js'
import { usercontentOriginFromEnv } from '../src/hosted/ops-cli.js'
import { warnDevicesDeprecated, warnServeDeprecations } from '../src/cli/serve-deprecations.js'
import { validateStarterAgent } from '../src/agent/starter/settings.js'
import { SAMPLE, tempDir } from './helpers.js'

async function run(argv) {
  const out = []
  const err = []
  let error = null
  try {
    await main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) })
  } catch (caught) {
    error = caught
  }
  return { error, out: out.join('\n'), err: err.join('\n') }
}

const project = (name) => {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(SAMPLE))
  return file
}

test('the removed and deprecated lines: one sentence each, with the replacement', () => {
  assert.equal(REMOVED_IN, '3.0')
  const error = removed('variant rm', 'use variant remove')
  assert.equal(error.code, 'removed')
  assert.equal(error.message, 'variant rm was removed in Shapewall 2.0; use variant remove.')
  const lines = []
  setDeprecationSink((line) => lines.push(line))
  deprecated('serve --lan', 'use --tailscale')
  deprecated('serve --lan', 'use --tailscale')
  assert.deepEqual(lines, ['Warning: serve --lan is deprecated and will be removed in Shapewall 3.0; use --tailscale.'])
  setDeprecationSink(() => {})
})

test('removed CLI spellings stop with the replacement, before anything runs', async () => {
  const file = project('r7-cli')
  const cases = [
    [['hosted', '--setup'], 'hosted --setup was removed in Shapewall 2.0; use hosted setup.'],
    [['variant', 'rm', 'v1', '--config', file], 'variant rm was removed in Shapewall 2.0; use variant remove.'],
    [['export', '--noindex', '--config', file], 'export --noindex was removed in Shapewall 2.0; use --no-index.'],
    [['capture', '--yes', '--config', file], 'capture --yes was removed in Shapewall 2.0; leave it out: capture never prompts.'],
    [['capture', '-y', '--config', file], 'capture --yes was removed in Shapewall 2.0; leave it out: capture never prompts.'],
    [['audit', '--config', file], 'audit was removed in Shapewall 2.0; use checks lighthouse.'],
    [
      ['checks', 'lighthouse', '--production', 'development', '--config', file],
      'checks lighthouse --production was removed in Shapewall 2.0; use --build-mode.',
    ],
    [['agent', 'doctor'], 'agent doctor was removed in Shapewall 2.0; use agent sandbox doctor.'],
  ]
  for (const [argv, message] of cases) {
    const result = await run(argv)
    assert.equal(result.error?.message, message, argv.join(' '))
    assert.equal(result.error.code, 'removed', argv.join(' '))
    assert.equal(result.out, '', argv.join(' '))
  }
  setDeprecationSink(() => {})
})

test('removed config keys: the config names each one and its replacement', async () => {
  const cases = [
    [{ versions: 3 }, 'the config key "versions" was removed in Shapewall 2.0; rename it to "keepVersions".'],
    [{ agent: { localSession: 'own' } }, /^agent\.localSession "own" was removed in Shapewall 2\.0; leave it out/],
  ]
  for (const [extra, expected] of cases) {
    const dir = tempDir('r7-config')
    const file = path.join(dir, 'shapewall.config.json')
    fs.writeFileSync(file, JSON.stringify({ ...structuredClone(SAMPLE), ...extra }))
    const result = await run(['variant', 'list', '--config', file])
    assert.ok(result.error, JSON.stringify(extra))
    const text = result.error.problems?.join('\n') || result.error.message
    if (typeof expected === 'string') assert.ok(text.includes(expected), text)
    else assert.match(text, new RegExp(expected.source, 'm'))
  }
})

test('SHAPEWALL_USERCONTENT_ORIGIN alone stops the hosted server with the new name; the new name wins', () => {
  assert.throws(
    () => usercontentOriginFromEnv({ SHAPEWALL_USERCONTENT_ORIGIN: 'https://u.example.com' }),
    (error) =>
      error.code === 'removed' &&
      error.message === 'SHAPEWALL_USERCONTENT_ORIGIN was removed in Shapewall 2.0; rename it to SHAPEWALL_HOSTED_USERCONTENT_ORIGIN.',
  )
  assert.equal(
    usercontentOriginFromEnv({ SHAPEWALL_HOSTED_USERCONTENT_ORIGIN: 'https://new.example.com', SHAPEWALL_USERCONTENT_ORIGIN: 'x' }),
    'https://new.example.com',
  )
  assert.equal(usercontentOriginFromEnv({}), null)
})

test('kept through 2.x with a warning: serve --lan, serve --accounts (and SHAPEWALL_ACCOUNTS=1), devices', () => {
  const lines = []
  setDeprecationSink((line) => lines.push(line))
  warnServeDeprecations({}, {})
  warnServeDeprecations({ lan: false, accounts: false }, { SHAPEWALL_ACCOUNTS: '1' })
  assert.deepEqual(lines, [], 'nothing without them (an explicit --accounts=false wins over the variable)')
  warnServeDeprecations({ lan: true }, {})
  warnServeDeprecations({ lan: 'eth0', accounts: true }, {})
  warnServeDeprecations({}, { SHAPEWALL_ACCOUNTS: '1' })
  warnDevicesDeprecated()
  assert.equal(lines.length, 4, lines.join('\n'))
  assert.match(lines[0], /^Warning: serve --lan is deprecated and will be removed in Shapewall 3\.0; .*shapewall serve --tailscale\.$/)
  assert.match(lines[1], /^Warning: serve --accounts is deprecated and will be removed in Shapewall 3\.0; leave it out/)
  assert.match(lines[2], /^Warning: SHAPEWALL_ACCOUNTS=1 is deprecated/)
  assert.match(lines[3], /^Warning: the devices command is deprecated.*serve --tailscale/)
  setDeprecationSink(() => {})
})

test('serve and devices go through the warnings (the CLI wiring)', () => {
  const source = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8')
  assert.match(source, /serve: async \(\{ flags, out \}\) => \{\n {4}warnServeDeprecations\(flags\)/)
  assert.match(source, /devices: \(\{ positional, flags, out \}\) => \{\n {4}warnDevicesDeprecated\(\)/)
})

test('starterAgent.testCommand still works through 2.x, with a warning to set commands.test', () => {
  const lines = []
  setDeprecationSink((line) => lines.push(line))
  const problems = []
  const settings = validateStarterAgent({ trusted: ['robin'], testCommand: 'npm test' }, problems)
  assert.deepEqual(problems, [])
  assert.deepEqual(settings.testCommand, ['npm', 'test'])
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^Warning: starterAgent\.testCommand is deprecated and will be removed in Shapewall 3\.0; set "commands"/)
  validateStarterAgent({ trusted: ['robin'] }, [])
  assert.equal(lines.length, 1)
  setDeprecationSink(() => {})
})
