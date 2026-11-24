// The 1.0 command-line cleanups: durations with units, renamed spellings that
// keep working with a warning, docs links that resolve on the website, and
// package metadata that matches what the Docker images and messages install.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { durationFlag, formatDuration } from '../src/cli/duration.js'
import { deprecated, setDeprecationSink } from '../src/deprecation.js'
import { credentialsFile } from '../src/remote/credentials.js'
import { baseUrlHint } from '../src/cli/init.js'
import { usercontentOriginFromEnv } from '../src/hosted/ops-cli.js'
import { renderEnv } from '../src/hosted/setup.js'
import { devicesCommand } from '../src/devices-cli.js'
import { Devices } from '../src/server/devices.js'
import { workflowYaml } from '../src/ci/workflow.js'
import { LIGHTHOUSE_INSTALL, LIGHTHOUSE_VERSION } from '../src/checks/lighthouse.js'
import { SENTRY_INSTALL } from '../src/error-tracking.js'
import { agentWorktreeRoot } from '../src/agent/branch-mode.js'
import { exportStatic } from '../src/export.js'
import { DOCS } from '../website/src/routes.js'
import { sampleConfig, tempDir } from './helpers.js'

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
const PACKAGE = JSON.parse(read('package.json'))

function warnings() {
  const lines = []
  setDeprecationSink((line) => lines.push(line))
  return lines
}

test('durations take s, m or h, and a bare number keeps the flag unit', () => {
  const opts = { flag: 'timeout', unit: 'm', min: 1000, max: 7 * 24 * 3600 * 1000 }
  assert.equal(durationFlag('10', opts), 10 * 60 * 1000)
  assert.equal(durationFlag('90s', opts), 90 * 1000)
  assert.equal(durationFlag('2h', opts), 2 * 3600 * 1000)
  assert.equal(durationFlag('1.5m', opts), 90 * 1000)
  const seconds = { flag: 'wait', unit: 's', min: 1000, max: 3600 * 1000, wholeSeconds: true }
  assert.equal(durationFlag('30', seconds), 30 * 1000)
  assert.equal(durationFlag('5m', seconds), 300 * 1000)
  for (const bad of ['', 'ten', '5d', '-1', '2h', '0']) assert.throws(() => durationFlag(bad, seconds), /--wait: a duration/)
  assert.equal(formatDuration(90 * 1000), '90s')
})

test('a deprecated spelling warns once, naming the 2.0 removal and the new spelling', () => {
  const lines = warnings()
  deprecated('variant rm', 'use variant remove')
  deprecated('variant rm', 'use variant remove')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /variant rm is deprecated and will be removed in Shapewall 2\.0; use variant remove\./)
  setDeprecationSink(() => {})
})

test('the usercontent origin reads the canonical name, and the old one with a warning', () => {
  const lines = warnings()
  assert.equal(usercontentOriginFromEnv({ SHAPEWALL_HOSTED_USERCONTENT_ORIGIN: 'https://a.example.com' }), 'https://a.example.com')
  assert.equal(lines.length, 0)
  assert.equal(usercontentOriginFromEnv({ SHAPEWALL_USERCONTENT_ORIGIN: 'https://b.example.com' }), 'https://b.example.com')
  assert.match(lines[0], /SHAPEWALL_USERCONTENT_ORIGIN is deprecated.*SHAPEWALL_HOSTED_USERCONTENT_ORIGIN/)
  assert.equal(usercontentOriginFromEnv({}), null)
  const env = renderEnv({ domain: 'app.example.com', usercontentDomain: 'files.example.com', source: 'npm' })
  assert.match(env, /^SHAPEWALL_HOSTED_USERCONTENT_ORIGIN=https:\/\/files\.example\.com$/m)
  assert.doesNotMatch(env, /^SHAPEWALL_USERCONTENT_ORIGIN=/m)
  setDeprecationSink(() => {})
})

test('init suggests http:// for a local address and https:// for a host name', () => {
  assert.equal(baseUrlHint('localhost:3000'), 'http://localhost:3000')
  assert.equal(baseUrlHint('127.0.0.1:8080/app'), 'http://127.0.0.1:8080/app')
  assert.equal(baseUrlHint('example.com'), 'https://example.com')
  assert.equal(baseUrlHint('http://localhost:3000'), null)
  assert.equal(baseUrlHint('not a url'), null)
})

test('credentials follow XDG, then %APPDATA% on Windows, keeping a 0.x file in ~/.config', () => {
  const home = tempDir('creds-home')
  const appdata = tempDir('creds-appdata')
  assert.equal(credentialsFile({ XDG_CONFIG_HOME: '/x' }, { platform: 'win32', home }), path.join('/x', 'shapewall', 'credentials.json'))
  assert.equal(credentialsFile({ APPDATA: appdata }, { platform: 'win32', home }), path.join(appdata, 'shapewall', 'credentials.json'))
  assert.equal(
    credentialsFile({ APPDATA: appdata }, { platform: 'linux', home }),
    path.join(home, '.config', 'shapewall', 'credentials.json'),
  )
  const legacy = path.join(home, '.config', 'shapewall', 'credentials.json')
  fs.mkdirSync(path.dirname(legacy), { recursive: true })
  fs.writeFileSync(legacy, '{}')
  assert.equal(credentialsFile({ APPDATA: appdata }, { platform: 'win32', home }), legacy)
})

test('devices list --json prints ISO times', () => {
  const config = sampleConfig('devices-iso')
  const dir = path.join(tempDir('devices-iso-private'), 'shapewall')
  fs.mkdirSync(dir, { mode: 0o700 })
  const env = { SHAPEWALL_DEVICES_FILE: path.join(dir, 'devices.json'), PATH: '' }
  new Devices(config.dir, { env }).request({ name: 'Phone', ip: '192.0.2.1', browser: 'test' })
  const lines = []
  devicesCommand(config, ['list'], { json: true }, (line) => lines.push(line), env)
  const data = JSON.parse(lines.join('\n'))
  assert.equal(data.pending.length, 1)
  assert.match(data.pending[0].expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

test('agent worktrees live under the configured outputDir', () => {
  const config = sampleConfig('worktree-output')
  config.outputDir = path.join(config.dir, 'review-store')
  const root = agentWorktreeRoot(config, { create: true })
  assert.equal(root, path.join(fs.realpathSync(config.dir), 'review-store', 'agent-worktrees'))
  assert.ok(fs.statSync(root).isDirectory())
})

test('an export warns when opened from disk and leaves the voice files out unless asked', async () => {
  const client = tempDir('v1-export-client')
  fs.mkdirSync(path.join(client, 'assets'))
  fs.writeFileSync(path.join(client, 'index.html'), '<!doctype html><html><head><title>Shapewall</title></head><body></body></html>')
  fs.writeFileSync(path.join(client, 'assets', 'app.js'), '')
  fs.writeFileSync(path.join(client, 'assets', 'tts-voice.bin'), 'x')
  const config = sampleConfig('v1-export')
  const out = path.join(tempDir('v1-export-out'), 'site')
  const result = await exportStatic(config, { out, clientDir: client })
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8')
  assert.match(html, /static-boot\.js/)
  assert.match(fs.readFileSync(path.join(out, 'static-boot.js'), 'utf8'), /file:/)
  assert.ok(!fs.existsSync(path.join(out, 'assets', 'tts-voice.bin')))
  assert.equal(result.comments, 0)
  const withVoice = path.join(tempDir('v1-export-voice'), 'site')
  await exportStatic(config, { out: withVoice, clientDir: client, browserComments: true })
  assert.ok(fs.existsSync(path.join(withVoice, 'assets', 'tts-voice.bin')))
})

test('every shapewall.com/docs link in the code names a page on the website', () => {
  const paths = new Set(DOCS.map((doc) => doc.path))
  const files = fs.readdirSync(new URL('../src', import.meta.url), { recursive: true }).filter((name) => /\.(js|jsx)$/.test(name))
  const found = new Set()
  for (const name of files) {
    for (const match of read(`src/${name}`).matchAll(/https:\/\/shapewall\.com(\/docs\/[a-z0-9-]+)/g)) found.add(match[1])
  }
  assert.ok(found.size > 5)
  for (const link of found) assert.ok(paths.has(link), `${link} is not a docs page`)
})

test('the optional peers match what the messages and Docker images install', () => {
  assert.deepEqual(Object.keys(PACKAGE.peerDependencies).sort(), ['@sentry/node', 'lighthouse'])
  for (const name of ['@sentry/node', 'lighthouse']) {
    assert.equal(PACKAGE.peerDependenciesMeta[name].optional, true)
    assert.ok(!PACKAGE.dependencies[name], `${name} is not a dependency`)
    assert.equal(PACKAGE.devDependencies[name], PACKAGE.peerDependencies[name])
  }
  assert.equal(PACKAGE.peerDependencies.lighthouse, LIGHTHOUSE_VERSION)
  assert.equal(LIGHTHOUSE_INSTALL, `npm install lighthouse@${PACKAGE.peerDependencies.lighthouse}`)
  assert.equal(SENTRY_INSTALL, `npm install @sentry/node@${PACKAGE.peerDependencies['@sentry/node']}`)
  assert.match(read('Dockerfile'), new RegExp(`lighthouse@${LIGHTHOUSE_VERSION}`))
  assert.match(read('Dockerfile.hosted'), new RegExp(`@sentry/node@${PACKAGE.peerDependencies['@sentry/node']}`))
  // The hosted image is pinned to one Node 22 release, in both stages.
  const froms = read('Dockerfile.hosted').match(/^FROM \S+/gm)
  assert.ok(froms.length >= 2)
  for (const from of froms) assert.match(from, /^FROM node:22\.\d+\.\d+-/)
})

test('the workflow init --ci writes pins every action to a commit', () => {
  const yaml = workflowYaml()
  const uses = [...yaml.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1])
  assert.ok(uses.length > 0)
  for (const use of uses) assert.match(use, /@[0-9a-f]{40}$/, use)
})

test('the npm package leaves the guide screenshots out and the README links them absolutely', () => {
  assert.ok(!PACKAGE.files.some((entry) => entry.startsWith('docs/images')))
  for (const match of read('README.md').matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) assert.match(match[1], /^https:\/\//)
})
