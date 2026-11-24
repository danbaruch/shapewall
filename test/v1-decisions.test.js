// The pre-1.0 product decisions: renamed commands and config keys that keep
// working with a warning, what the help marks experimental or leaves out, and
// what stays but is experimental (the Buzz bridge).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { main, parseArgs } from '../src/cli.js'
import { HELP, SHORT_HELP, EXPERIMENTAL, commandHelp } from '../src/cli/help.js'
import { normalizeConfig } from '../src/config.js'
import { configKeyWarnings } from '../src/config-keys.js'
import { setDeprecationSink } from '../src/deprecation.js'
import { DOCS } from '../website/src/routes.js'
import { cleanDefinition } from '../src/hosted/push.js'
import { pushDefinition } from '../src/remote/remote.js'
import { SAMPLE, sampleConfig, tempDir } from './helpers.js'

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

async function run(argv) {
  const out = []
  const err = []
  let code
  let error = null
  try {
    code = await main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) })
  } catch (caught) {
    error = caught
  }
  return { code, error, out: out.join('\n'), err: err.join('\n') }
}

test('audit is checks lighthouse: same flags, a deprecation warning, and its help is the checks help', async () => {
  const dir = tempDir('v1-audit')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ baseUrl: 'http://127.0.0.1:9', pages: [{ id: 'home', path: '/' }] }))
  // Strict parsing takes every Lighthouse flag on checks, and the old --production spelling.
  const parsed = parseArgs(['checks', 'lighthouse', '--viewports', 'phone', '--samples', '2', '--production', 'development'], {
    strict: true,
  })
  assert.deepEqual(parsed.positional, ['lighthouse'])
  assert.equal(parsed.flags['build-mode'], 'development')
  assert.deepEqual(parsed.deprecations, [['production', 'build-mode']])
  for (const argv of [
    ['audit', '--config', file, '--build-mode', 'unknown', '--json'],
    ['checks', 'lighthouse', '--config', file, '--build-mode', 'unknown', '--json'],
  ]) {
    const result = await run(argv)
    // Lighthouse is an optional peer: either it is missing (an error that says how to add it) or the run reports.
    if (result.error) assert.match(result.error.message, /lighthouse/i)
    else assert.equal(typeof result.code, 'number')
    assert.equal(/audit is deprecated.*use checks lighthouse/.test(result.err), argv[0] === 'audit', argv.join(' '))
  }
  assert.match((await run(['audit', '--help'])).out, /checks lighthouse/)
  assert.equal((await run(['help', 'audit'])).out, commandHelp('checks'))
  setDeprecationSink(() => {})
})

test('agent sandbox run|watch|doctor|build-image, with the old spellings as warned aliases', async () => {
  const old = await run(['agent', 'build-image', '--runtime', 'nope'])
  assert.match(old.err, /agent build-image is deprecated.*use agent sandbox build-image/)
  assert.match(old.error.message, /podman or docker/)
  const now = await run(['agent', 'sandbox', 'build-image', '--runtime', 'nope'])
  assert.equal(now.err, '')
  assert.match(now.error.message, /podman or docker/)
  assert.match((await run(['agent', 'sandbox', 'bogus'])).error.message, /usage: shapewall agent connect .*agent sandbox run/)
  // A person who types the container's own entry gets the usage, not a process waiting on stdin.
  if (process.stdin.isTTY) assert.match((await run(['agent', 'sandbox'])).error.message, /usage/)
  setDeprecationSink(() => {})
})

test('the help marks experimental commands and options with one suffix, and leaves settings out of the lists', () => {
  for (const line of [
    '  checks [run|list]         check original pages and save private diagnostic reports',
    '  checks lighthouse         run bounded Chrome Lighthouse lab audits on original pages',
    '  agent sandbox run --comment ID  ',
    '  admin projects list|create NAME | members list | agents list | invites create  ',
    '      --tailnet-sign-in     with --tailscale: sign tailnet users in by their tailnet login',
    '      --tailnet-passkeys    with --tailnet-sign-in: also allow passkeys',
    '      --funnel              share links public through Tailscale Funnel',
    '  hosted claim --data DIR --login LOGIN  ',
    '  join --remote URL         join a workspace on a server with tailnet sign-in',
    '  buzz-bridge               run a private foreground gateway to existing Buzz agents',
    '      --buzz-bridge FILE    owner-only existing Buzz conversation',
  ]) {
    const found = HELP.split('\n').find((item) => item.startsWith(line.trimEnd()))
    assert.ok(found, `in the help: ${line.trim()}`)
    assert.ok(found.endsWith(EXPERIMENTAL.trim()), `marked experimental: ${found}`)
  }
  // The marker is always the same suffix, never another wording.
  assert.doesNotMatch(HELP, /\(beta\)|\[experimental\]|experimental:/i)
  assert.match(HELP, /\(experimental\): may change in a minor release/)
  // Hidden: still a command with its own help, never listed.
  assert.doesNotMatch(HELP, /^ {2}settings /m)
  assert.doesNotMatch(SHORT_HELP, /\bsettings\b/)
  assert.match(commandHelp('settings'), /--open/)
  for (const gone of ['audit  ', 'agent run --comment']) assert.ok(!HELP.includes(gone), gone)
})

test('keepVersions is the config key; versions is still read, with a warning, and is not an unknown key', () => {
  const lines = []
  setDeprecationSink((line) => lines.push(line))
  const dir = tempDir('v1-keep-versions')
  const file = path.join(dir, 'shapewall.config.json')
  assert.equal(normalizeConfig({ ...structuredClone(SAMPLE), keepVersions: 2 }, { dir, file }).versions, 2)
  assert.equal(lines.length, 0)
  assert.equal(normalizeConfig({ ...structuredClone(SAMPLE), versions: 3 }, { dir, file }).versions, 3)
  assert.match(lines[0], /the config key "versions" is deprecated.*rename it to "keepVersions"/)
  assert.equal(normalizeConfig({ ...structuredClone(SAMPLE), versions: 3, keepVersions: 1 }, { dir, file }).versions, 1, 'the new key wins')
  assert.throws(
    () => normalizeConfig({ ...structuredClone(SAMPLE), versions: 99 }, { dir, file }),
    (error) => error.problems.some((problem) => problem.startsWith('versions:')),
  )
  assert.deepEqual(configKeyWarnings({ ...structuredClone(SAMPLE), versions: 3 }), [])
  assert.deepEqual(
    configKeyWarnings({ ...structuredClone(SAMPLE), keepVersion: 3 }).map((warning) => warning.suggestion),
    ['keepVersions'],
  )
  setDeprecationSink(() => {})
})

test('the Buzz bridge is in the command line, the server, the package and the site, marked experimental', async () => {
  // Without --bridge-config it refuses before starting anything (no relay, no keys).
  await assert.rejects(main(['buzz-bridge'], { out: () => {}, err: () => {} }), /--bridge-config FILE/)
  assert.equal(parseArgs(['serve', '--buzz-bridge', 'x.json'], { strict: true }).flags['buzz-bridge'], 'x.json')
  assert.ok(fs.existsSync(new URL('../src/buzz/gateway.js', import.meta.url)))
  assert.match(read('docs/buzz.md'), /^# Buzz bridge\n\n\*\*Experimental\.\*\*/)
  assert.match(read('docs/stability.md'), /\*\*The Buzz bridge:\*\*/)
  assert.doesNotMatch(read('docs/stability.md'), /Buzz bridge[^\n]*removed/i)
  // Listed in the help, never hidden.
  assert.match(SHORT_HELP, /\bbuzz-bridge\b/)
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.files.includes('docs/buzz.md'))
  for (const name of ['@noble/curves', '@scure/base']) assert.ok(pkg.dependencies[name], name)
  assert.ok(DOCS.some((doc) => doc.path === '/docs/buzz'))
  assert.doesNotMatch(read('website/deploy/shapewall.Caddyfile'), /docs\/buzz/)
})

test('the stability guide is published with the docs and states the promise', () => {
  const doc = DOCS.find((item) => item.path === '/docs/stability')
  assert.equal(doc?.repo, 'stability')
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.files.includes('docs/stability.md'))
  const text = read('docs/stability.md')
  for (const part of [
    'Semantic Versioning',
    '## Experimental',
    '## Internal',
    '`shapewall.config.json`',
    '`.shapewall-auth/*.auth.json`',
    'events.jsonl',
    '$SHAPEWALL_COMMENT_FILE',
    'credentials.json',
    '`/api/v1`, `/mcp`, `/api/health` and `/api/github/webhook`',
  ])
    assert.ok(text.includes(part), part)
  assert.ok(!text.includes('—'), 'no em dashes')
})

test('checks takes the Lighthouse flags only for checks lighthouse (and audit), and its own flags only for its other actions', async () => {
  const strict = (argv) => parseArgs(argv, { strict: true })
  for (const argv of [
    ['checks', 'run', '--samples', '3'],
    ['checks', 'run', '--cache', 'warm'],
    ['checks', '--cache', 'warm'],
    ['checks', 'list', '--viewports', 'phone'],
    ['checks', 'run', '--production', 'development'],
    ['checks', 'run', '--build-mode', 'development'],
    ['checks', '--samples', '2', 'run'],
  ])
    assert.throws(() => strict(argv), /unknown option --[a-z-]+ for "checks"/, argv.join(' '))
  for (const argv of [
    ['checks', 'lighthouse', '--flow-file', 'flow.json'],
    ['checks', 'lighthouse', '--limit', '2'],
  ])
    assert.throws(() => strict(argv), /unknown option --[a-z-]+ for "checks lighthouse".*checks lighthouse --help/, argv.join(' '))
  assert.throws(() => strict(['checks', 'lighthouse', '--viewport', 'phone']), /did you mean --viewports\?/)
  assert.deepEqual(strict(['checks', 'run', '--viewport', 'phone', '--limit', '2', '--json']).flags, {
    viewport: 'phone',
    limit: '2',
    json: true,
  })
  assert.equal(strict(['checks', '--samples', '2', 'lighthouse']).flags.samples, '2')
  const audit = await run(['audit', '--flow-file', 'flow.json'])
  assert.match(audit.error.message, /unknown option --flow-file for "checks lighthouse"/)
  setDeprecationSink(() => {})
})

test('a hosted push carries the kept-versions count without the local config deprecation', () => {
  const lines = []
  setDeprecationSink((line) => lines.push(line))
  const config = sampleConfig('v1-push-keep-versions')
  config.versions = 4
  const wire = pushDefinition(config, config.boards[0])
  assert.equal(wire.versions, 4, 'the wire field stays versions, for servers before 1.0')
  assert.equal(cleanDefinition(wire).versions, 4)
  const { versions, ...rest } = wire
  assert.equal(versions, 4)
  assert.equal(cleanDefinition({ ...rest, keepVersions: 2 }).versions, 2, 'keepVersions is taken too')
  assert.deepEqual(lines, [])
  setDeprecationSink(() => {})
})
