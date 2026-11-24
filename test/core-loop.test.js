// The fresh-install fixes: strict per-command flags, per-command help, how
// shapewall was started, named bad values, expectStatus, the board URL for
// links, and the broken-link report helpers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { COMMAND_FLAGS, commandHelp, main, openerFor, parseArgs, suggestFlag } from '../src/cli.js'
import { normalizeConfig } from '../src/config.js'
import { runDoctor } from '../src/doctor.js'
import { invocation } from '../src/invocation.js'
import { boardUrlFor } from '../src/notify/messages.js'
import { githubSettings } from '../src/github.js'
import { checkLinks, collectLinks, mergeBroken } from '../src/broken-links.js'
import { clearServeState, runningBoardUrl, servedUrl, writeServeState } from '../src/serve-state.js'
import { SAMPLE, sampleConfig, tempDir } from './helpers.js'

async function run(argv) {
  const lines = []
  const code = await main(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) })
  return { code, text: lines.join('\n') }
}

function writeSample(name) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(SAMPLE))
  return file
}

test('a flag the command does not take is an error with the closest real one', async () => {
  await assert.rejects(run(['capture', '--onyl', 'home']), /unknown option --onyl for "capture" \(did you mean --only\?\)/)
  await assert.rejects(run(['serve', '--prot', '5000']), /unknown option --prot for "serve" \(did you mean --port\?\)/)
  await assert.rejects(run(['comments', '--opne']), /unknown option --opne for "comments" \(did you mean --open\?\)/)
  // Before the command too, and with no close match: no guess.
  await assert.rejects(
    run(['--zzzzzz=1', 'capture']),
    (error) => /unknown option --zzzzzz/.test(error.message) && !/did you mean/.test(error.message),
  )
  // A flag of another command is still unknown here.
  await assert.rejects(run(['init', '--only', 'x']), /unknown option --only for "init"/)
  // Existing flags, aliases and = forms keep working.
  assert.equal(parseArgs(['comments', '-y', '--page=home', '--config', 'x.json'], { strict: true }).flags.yes, true)
  // An old spelling is read as the new one, with a deprecation for the warning; capture's --yes did nothing.
  const old = parseArgs(['export', '--noindex', '--config', 'x.json'], { strict: true })
  assert.equal(old.flags['no-index'], true)
  assert.equal(old.flags.noindex, undefined)
  assert.deepEqual(old.deprecations, [['noindex', 'no-index']])
  const yes = parseArgs(['capture', '-y', '--only=home'], { strict: true })
  assert.equal(yes.flags.yes, undefined)
  assert.deepEqual(yes.deprecations, [['yes', null]])
  assert.equal(parseArgs(['checks', 'lighthouse', '--production', 'development'], { strict: true }).flags['build-mode'], 'development')
  assert.equal(parseArgs(['serve', '--no-chat', '--allowed-host', 'a,b'], { strict: true }).flags['no-chat'], true)
  assert.equal(suggestFlag('prot', ['port', 'host']), 'port')
  assert.equal(suggestFlag('xyzzy', ['port', 'host']), null)
})

test('every flag in a command help is one the command accepts', () => {
  for (const command of Object.keys(COMMAND_FLAGS)) {
    if (command === 'push') continue // its section also describes comments, watch and mcp --remote
    const named = [...commandHelp(command).matchAll(/--([a-z][a-z-]+)/g)].map((match) => match[1])
    for (const flag of named) {
      if (['config', 'help', 'version'].includes(flag)) continue
      assert.ok(COMMAND_FLAGS[command].includes(flag), `${command} --help mentions --${flag}, which it does not accept`)
    }
  }
})

test('shapewall <command> --help prints only that command', async () => {
  const capture = await run(['capture', '--help'])
  assert.equal(capture.code, 0)
  assert.match(capture.text, /^Usage: shapewall capture/)
  assert.match(capture.text, /--check-external/)
  assert.doesNotMatch(capture.text, /variant add|hosted server/)
  // Even with a bad flag on the line, and as "help serve".
  assert.match((await run(['capture', '--onyl', 'x', '--help'])).text, /^Usage: shapewall capture/)
  const serve = await run(['help', 'serve'])
  assert.match(serve.text, /--open {16}also open the board in your browser/)
  assert.match((await run(['--help', 'all'])).text, /Commands[\s\S]*links[\s\S]*Hosted Shapewall/)
  assert.match((await run(['help', 'all'])).text, /Commands[\s\S]*links[\s\S]*Hosted Shapewall/)
})

test('serve --open on a box with no browser prints the link, not the opener error', async () => {
  const { openBrowser } = await import('../src/cli/open.js')
  const { EventEmitter } = await import('node:events')
  const url = 'http://127.0.0.1:4600/open/abc'
  const child = () => Object.assign(new EventEmitter(), { unref() {} })
  // No opener at all (ENOENT), an opener with nothing to open on (exit 3), and a throw.
  for (const fail of [
    (c) => c.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' })),
    (c) => c.emit('exit', 3),
  ]) {
    const lines = []
    const made = child()
    openBrowser(url, (line) => lines.push(line), { spawnImpl: () => made })
    fail(made)
    made.emit('exit', 1)
    if (process.platform === 'win32' && lines.length === 0) continue
    assert.deepEqual(lines, [`Couldn't open a browser here; open this link: ${url}`])
    assert.doesNotMatch(lines[0], /ENOENT|xdg-open/)
  }
  const thrown = []
  openBrowser(url, (line) => thrown.push(line), {
    spawnImpl: () => {
      throw new Error('nope')
    },
  })
  assert.deepEqual(thrown, [`Couldn't open a browser here; open this link: ${url}`])
  // A browser that opened says nothing.
  const quiet = []
  const ok = child()
  openBrowser(url, (line) => quiet.push(line), { spawnImpl: () => ok })
  ok.emit('exit', 0)
  assert.deepEqual(quiet, [])
})

test('serve --open uses the platform opener without a shell', () => {
  assert.equal(openerFor('linux').command, 'xdg-open')
  assert.equal(openerFor('darwin').command, 'open')
  assert.equal(openerFor('win32').command, 'explorer.exe')
})

test('commands print the way shapewall was started', () => {
  const root = '/home/me/.npm/_npx/abc123/node_modules/shapewall'
  const readFile = () => JSON.stringify({ dependencies: { shapewall: 'github:danbaruch/shapewall' } })
  assert.equal(invocation({ root, argv1: `${root}/../.bin/shapewall`, readFile }).command, 'npx github:danbaruch/shapewall')
  assert.equal(invocation({ root, readFile: () => JSON.stringify({ dependencies: { shapewall: '^0.2.0' } }) }).command, 'npx shapewall')
  const local = invocation({ root, readFile: () => JSON.stringify({ dependencies: { shapewall: 'file:../../../shapewall-0.1.0.tgz' } }) })
  assert.equal(local.command, 'shapewall', 'a file: spec is relative to the npx cache, so not printed')
  assert.ok(local.note)
  const clone = '/home/me/code/shapewall'
  assert.equal(invocation({ root: clone, argv1: '/usr/local/bin/shapewall' }).how, 'global')
  assert.equal(invocation({ root: clone, argv1: '/usr/local/bin/shapewall' }).command, 'shapewall')
  assert.equal(invocation({ root: clone, argv1: '/work/app/node_modules/.bin/shapewall' }).command, 'npx shapewall')
  assert.equal(invocation({ root: clone, argv1: `${clone}/bin/shapewall.js`, cwd: clone }).command, 'node bin/shapewall.js')
  const unknown = invocation({ root: clone, argv1: '/somewhere/else.js' })
  assert.equal(unknown.command, 'shapewall')
  assert.match(unknown.note, /npx shapewall/)
})

test('doctor --install-browser says "Downloading" only when Chromium is not there yet', async () => {
  const { chromiumInstalled, installBrowserNote } = await import('../src/doctor.js')
  const fake = (file) => ({ executablePath: () => file })
  assert.equal(await chromiumInstalled({ chromium: fake(process.execPath) }), true)
  assert.equal(await chromiumInstalled({ chromium: fake(path.join(tempDir('no-chromium'), 'chrome')) }), false)
  assert.match(installBrowserNote(true), /already installed/)
  assert.doesNotMatch(installBrowserNote(true), /Downloading/)
  assert.match(installBrowserNote(false), /^Downloading Chromium/)
})

test('the headless shell is enough for capture; the full Chromium is checked only for a window', async () => {
  const { chromiumInstalled, headlessShellDir } = await import('../src/doctor.js')
  const root = tempDir('pw-browsers')
  const full = path.join(root, 'chromium-1248', 'chrome-linux64', 'chrome')
  const fake = { executablePath: () => full }
  assert.equal(headlessShellDir(full), path.join(root, 'chromium_headless_shell-1248'))
  assert.equal(headlessShellDir('/opt/google/chrome/chrome'), null)
  assert.equal(await chromiumInstalled({ chromium: fake }), false)
  fs.mkdirSync(path.join(root, 'chromium_headless_shell-1248'), { recursive: true })
  fs.writeFileSync(path.join(root, 'chromium_headless_shell-1248', 'INSTALLATION_COMPLETE'), '')
  assert.equal(await chromiumInstalled({ chromium: fake }), true, 'the headless shell alone is enough')
  assert.equal(await chromiumInstalled({ chromium: fake, headed: true }), false, 'a window needs the full Chromium')
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, '')
  assert.equal(await chromiumInstalled({ chromium: fake, headed: true }), true)
})

test('doctor --install-browser needs no config: a missing one is a skip there, a FAIL otherwise', async () => {
  const dir = tempDir('doctor-optional')
  const configFile = path.join(dir, 'shapewall.config.json')
  const optional = await runDoctor({ configFile, port: 0, launch: false, network: false, configOptional: true })
  const config = optional.checks.find((check) => check.name === 'config')
  assert.equal(config.status, 'skip')
  assert.match(config.fix, /init" in your app's project folder/)
  assert.ok(!/npx shapewall /.test(config.fix), 'never the bare npx shapewall (not on npm)')
  const strict = await runDoctor({ configFile, port: 0, launch: false, network: false })
  assert.equal(strict.checks.find((check) => check.name === 'config').status, 'fail')
})

test('bad values are named: comments status and variant add', async () => {
  const file = writeSample('named-values')
  await assert.rejects(
    run(['comments', 'status', '1', 'bogus', '--config', file]),
    /unknown status 'bogus' \(use: queued, working, done, needs-human, clear\)/,
  )
  await assert.rejects(
    run(['variant', 'add', 'nosuch', '--url', 'http://127.0.0.1:9/', '--config', file]),
    /no page 'nosuch' on board "sample"; pages: home, pricing, app/,
  )
  await assert.rejects(run(['variant', 'add', 'pricng', '--url', 'http://127.0.0.1:9/', '--config', file]), /did you mean pricing\?/)
})

test('config: expectStatus is a status or a list; bad values are reported', () => {
  const config = normalizeConfig({
    ...structuredClone(SAMPLE),
    pages: [
      { id: 'a', path: '/a', expectStatus: 404 },
      { id: 'b', path: '/b', expectStatus: [404, 410, 404] },
      { id: 'c', path: '/c' },
    ],
  })
  assert.deepEqual(
    config.boards[0].pages.map((page) => page.expectStatus),
    [[404], [404, 410], null],
  )
  for (const bad of ['404', 99, [], [200, 'x'], 600]) {
    assert.throws(
      () => normalizeConfig({ ...structuredClone(SAMPLE), pages: [{ id: 'a', path: '/a', expectStatus: bad }] }),
      /expectStatus/,
    )
  }
  assert.throws(() => normalizeConfig({ ...structuredClone(SAMPLE), boardUrl: 'ftp://x' }), /boardUrl/)
})

test('links in messages: config boardUrl, else a running serve, else the default port', () => {
  const config = sampleConfig('board-url')
  assert.equal(boardUrlFor(config, { env: {} }), 'http://127.0.0.1:4600/')
  assert.equal(githubSettings(config, {}).boardUrl, 'http://127.0.0.1:4600/')
  writeServeState(config, servedUrl('127.0.0.1', 47311))
  assert.equal(runningBoardUrl(config), 'http://127.0.0.1:47311/')
  assert.equal(boardUrlFor(config, { env: {} }), 'http://127.0.0.1:47311/')
  assert.equal(githubSettings(config, {}).boardUrl, 'http://127.0.0.1:47311/')
  // A server's own address wins over another server's file; the config wins over both.
  assert.equal(boardUrlFor(config, { env: {}, boardUrl: 'http://127.0.0.1:5000/' }), 'http://127.0.0.1:5000/')
  const configured = { ...config, boardUrl: 'https://review.example.com/' }
  assert.equal(boardUrlFor(configured, { env: {} }), 'https://review.example.com/')
  assert.equal(boardUrlFor(configured, { env: { SHAPEWALL_BOARD_URL: 'https://env.example.com/' } }), 'https://env.example.com/')
  clearServeState(config)
  assert.equal(runningBoardUrl(config), null)
  // A file left by a server that is gone is ignored.
  fs.writeFileSync(path.join(config.outputDir, 'serve.json'), JSON.stringify({ url: 'http://127.0.0.1:1234/', pid: 2 ** 22 + 7 }))
  assert.equal(runningBoardUrl(config), null)
  assert.equal(servedUrl('0.0.0.0', 80), 'http://127.0.0.1:80/')
  assert.equal(servedUrl('::1', 80), 'http://[::1]:80/')
})

test('broken links: same-site only by default, board pages take their capture result, partial runs merge', async () => {
  const board = normalizeConfig({
    ...structuredClone(SAMPLE),
    baseUrl: 'http://site.test/app',
  }).boards[0]
  const found = new Map()
  collectLinks(
    found,
    [
      'http://site.test/app/pricing',
      'http://site.test/app/gone#x',
      'http://site.test/other',
      'https://ext.test/',
      'mailto:a@b',
      'javascript:x',
    ],
    {
      baseUrl: board.baseUrl,
      pageId: 'home',
    },
  )
  assert.deepEqual([...found.keys()], ['http://site.test/app/pricing', 'http://site.test/app/gone'])
  const requested = []
  const manifestPages = { pricing: { desktop: { status: 'failed', httpStatus: 404, error: 'HTTP 404' } } }
  const result = await checkLinks(found, {
    board,
    baseUrl: board.baseUrl,
    manifestPages,
    request: async (url) => (requested.push(url), { status: 410 }),
  })
  assert.deepEqual(requested, ['http://site.test/app/gone'], 'a board page is not requested again')
  assert.deepEqual(
    result.broken.map((item) => [item.path, item.status]),
    [
      ['/gone', 410],
      ['/pricing', 404],
    ],
  )
  // Recapturing pricing (now fine) and home drops their old entries.
  const merged = mergeBroken(
    [...result.broken, { url: 'http://site.test/app/x', path: '/x', kind: 'site', status: 404, from: ['app'] }],
    [],
    {
      recaptured: ['home', 'pricing'],
      board,
      baseUrl: board.baseUrl,
      manifestPages: { pricing: { desktop: { status: 'ok', httpStatus: 200 } } },
    },
  )
  assert.deepEqual(
    merged.map((item) => item.path),
    ['/x'],
  )
})
