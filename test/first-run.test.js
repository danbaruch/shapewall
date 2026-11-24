// The first-run fixes: what an agent's mode lets it do, where a shot landed,
// plain load errors, ports, doctor's install/site/node checks, config key
// warnings, the installer's output, unmatched selectors, deleting a comment
// from the CLI, init's page list, a missing package, and the board's
// stale-chunk recovery.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { modePermission, sessionOptions } from '../src/agent/backends/acp.js'
import { localPermissionLine, modeInEffect } from '../client/src/chat/composerModel.js'
import { landedElsewhere, landedNote, landedWarning, shownDestination } from '../src/capture/destination.js'
import { allFailedHint, netErrorCode, plainLoadError } from '../src/capture/load-errors.js'
import { nextFreePort, portInUse, probePort } from '../src/ports.js'
import { listenFailure } from '../src/cli/serve.js'
import { checkInstall, checkNode, checkPort, checkSite, configWarningChecks, installerLine, UNSUPPORTED_OS_NOTE } from '../src/doctor.js'
import { configKeyWarnings, didYouMean, formatKeyWarning, keyWarningLines } from '../src/config-keys.js'
import { normalizeConfig } from '../src/config.js'
import { warningLines } from '../src/checks/cli.js'
import { unmatchedNote } from '../src/comments-cli.js'
import { pageLines } from '../src/cli/init.js'
import { missingPackageMessage } from '../src/missing-package.js'
import { removeComment } from '../src/cli/comments.js'
import { loadConfig } from '../src/config.js'
import { createComment, getComment } from '../src/store.js'
import {
  CHUNK_RELOAD_WINDOW_MS,
  canRecoverFromChunkLoad,
  claimErrorReport,
  isChunkRecoveryPending,
  recoverFromChunkLoad,
  resetChunkRecoveryForTests,
} from '../client/src/lib/chunk-reload.js'
import { SAMPLE, tempDir } from './helpers.js'

test('modePermission: what each agent mode lets it do, from the mode names the adapters report', () => {
  assert.equal(modePermission('claude', 'auto', 'Auto'), 'acts')
  assert.equal(modePermission('claude', 'bypassPermissions', 'Bypass Permissions'), 'acts')
  assert.equal(modePermission('claude', 'default', 'Default'), 'asks')
  assert.equal(modePermission('claude', 'plan', 'Plan'), 'reads')
  assert.equal(modePermission('goose', 'approve', 'Approve'), 'asks')
  assert.equal(modePermission('codex', 'read-only', 'Read Only'), 'reads')
  assert.equal(modePermission('other', 'something', 'Something'), null)
  const options = sessionOptions(
    [],
    {
      currentModeId: 'auto',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'auto', name: 'Auto' },
      ],
    },
    'claude',
  )
  const mode = options.find((option) => option.category === 'mode')
  assert.equal(mode.currentValue, 'auto', 'the mode in effect is reported even when it acts without asking')
  assert.deepEqual(
    mode.values.map((value) => [value.value, value.permission]),
    [
      ['default', 'asks'],
      ['auto', 'acts'],
    ],
  )
})

test('the agent panel says what the agent may do, and the mode in effect when there is one', () => {
  assert.equal(modeInEffect([]), null)
  const mode = modeInEffect([{ category: 'mode', currentValue: 'auto', values: [{ value: 'auto', name: 'Auto', permission: 'acts' }] }])
  assert.deepEqual(mode, { name: 'Auto', permission: 'acts' })
  const none = localPermissionLine(null)
  assert.match(none, /its own permission settings, so it may change files or run commands without asking/)
  assert.doesNotMatch(none, /It asks before/)
  assert.match(localPermissionLine(mode), /Its mode now is Auto, which acts without asking/)
  assert.match(localPermissionLine({ name: 'Default', permission: 'asks' }), /Its mode now is Default: it asks here before/)
  assert.match(localPermissionLine({ name: 'Plan', permission: 'reads' }), /does not change files/)
  assert.match(localPermissionLine({ name: 'Custom', permission: null }), /may change files.*Its mode now is Custom\./)
})

test('a shot that landed on another page is noticed, said on its line and warned about', () => {
  assert.equal(landedElsewhere('http://x.test/app/', 'http://x.test/app'), null, 'a trailing slash is not a move')
  assert.equal(landedElsewhere('http://x.test/app', 'http://x.test/app?ref=1#top'), null, 'query and hash are not compared')
  assert.equal(landedElsewhere('http://x.test/app/', 'http://x.test/login/?next=/app/'), 'http://x.test/login/?next=/app/')
  assert.equal(landedElsewhere('http://x.test/', 'https://auth.example.test/sso'), 'https://auth.example.test/sso')
  assert.equal(shownDestination('http://x.test/app/', 'https://auth.example.test/sso?x=1'), 'https://auth.example.test/sso')
  assert.equal(landedNote('http://x.test/app/', 'http://x.test/login/'), ' (landed on /login/, not /app/)')
  assert.equal(landedNote('http://x.test/app/', 'http://x.test/app/'), '')
  const lines = landedWarning([
    { page: 'app', viewport: 'desktop', status: 'ok', redirected: true, url: 'http://x.test/app/', finalUrl: 'http://x.test/login/' },
    { page: 'home', viewport: 'desktop', status: 'ok', url: 'http://x.test/', finalUrl: 'http://x.test/' },
  ])
  assert.match(lines[0], /^Warning: 1 shot landed on another page/)
  assert.equal(lines[1], '  app desktop: /app/ -> /login/')
  assert.match(
    lines[2],
    /sign-in redirect\. Record a login with ".*auth record" \(see Auth in https:\/\/shapewall\.com\/docs\/config#auth\)/,
  )
  assert.deepEqual(landedWarning([{ status: 'ok' }]), [])
})

test('a page that did not load is said in plain words, with the next step after a run that all failed', () => {
  const refused = 'page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4799/'
  assert.equal(netErrorCode(refused), 'ERR_CONNECTION_REFUSED')
  assert.equal(plainLoadError(refused, 'http://127.0.0.1:4799/'), 'connection refused at http://127.0.0.1:4799 (is your app running?)')
  assert.equal(
    plainLoadError('net::ERR_NAME_NOT_RESOLVED at http://no-such-host.invalid/', 'http://no-such-host.invalid/'),
    'host not found: no-such-host.invalid (check baseUrl)',
  )
  assert.equal(plainLoadError('Timeout 30000ms exceeded', 'http://x.test/'), null, 'not a network error: shown as it is')
  const shots = [
    { status: 'failed', netError: 'refused' },
    { status: 'failed', netError: 'refused' },
  ]
  assert.match(allFailedHint(shots, 'http://127.0.0.1:4799'), /^Nothing answered at http:\/\/127\.0\.0\.1:4799\. Start your app/)
  assert.equal(allFailedHint([...shots, { status: 'ok' }], 'http://127.0.0.1:4799'), null, 'some loaded: no hint')
})

async function occupied() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve))
  return { server, port: server.address().port }
}

test('a taken port: said plainly, with a port that is free, for serve and for doctor', async () => {
  const { server, port } = await occupied()
  try {
    assert.equal(await probePort(port), 'in-use')
    const free = await nextFreePort(port)
    assert.ok(free > port)
    assert.equal(await probePort(free), 'free')
    assert.equal(await nextFreePort(port, '127.0.0.1', { tries: 3, probe: async () => 'in-use' }), null)
    const { message, fix } = portInUse({ port: 4600, host: '127.0.0.1', free: 4601, command: (next) => 'shapewall serve --port ' + next })
    assert.equal(message, 'Port 4600 on 127.0.0.1 is in use.')
    assert.equal(fix, 'Use "shapewall serve --port 4601" (port 4601 is free), or stop what is using port 4600.')

    const error = Object.assign(new Error('listen EADDRINUSE: address already in use'), { code: 'EADDRINUSE' })
    const friendly = await listenFailure(error, { port, host: '127.0.0.1', config: null, flags: { config: 'site.json' } })
    assert.match(
      friendly.message,
      new RegExp('^Port ' + port + ' on 127\\.0\\.0\\.1 is in use\\. Use ".*serve --port \\d+ --config site\\.json"'),
    )
    assert.doesNotMatch(friendly.message, /EADDRINUSE/)
    const other = new Error('boom')
    assert.equal(await listenFailure(other, { port, host: '127.0.0.1', config: null }), other)

    const check = await checkPort(port)
    assert.equal(check.status, 'warn')
    const suggested = Number(/--port (\d+)/.exec(check.fix)[1])
    assert.equal(await probePort(suggested), 'free', 'the port doctor suggests is free')
    const mine = await checkPort(port, '127.0.0.1', { running: 'http://127.0.0.1:' + port + '/' })
    assert.equal(mine.status, 'ok')
    assert.match(mine.message, /already serving this project/)
  } finally {
    server.close()
  }
})

test('doctor: an incomplete install fails, the Node floor is exact, and a site that does not answer warns', async () => {
  const lookIn = () => ['/nm']
  const exists = (file) => file === path.join('/nm', 'express', 'package.json')
  assert.equal(checkInstall({ dependencies: { express: '1' }, lookIn, exists }).status, 'ok')
  const broken = checkInstall({ dependencies: { express: '1', ws: '1' }, lookIn, exists })
  assert.equal(broken.status, 'fail')
  assert.match(broken.message, /install is incomplete: a dependency is missing \(ws\)/)

  assert.equal(checkNode('22.19.0', '>=22.19.0').status, 'ok')
  assert.equal(checkNode('24.0.0', '>=22.19.0').status, 'ok')
  const old = checkNode('22.13.1', '>=22.19.0')
  assert.equal(old.status, 'fail')
  assert.match(old.message, /needs 22\.19\.0 or newer/)

  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  const dead = await checkSite('http://127.0.0.1:4799', { fetchImpl: async () => Promise.reject(refused) })
  assert.equal(dead.status, 'warn')
  assert.match(dead.message, /Nothing answers at http:\/\/127\.0\.0\.1:4799 \(connection refused\): is your app running\?/)
  assert.match(dead.fix, /serve works without it/)
  const gated = await checkSite('http://x.test', { fetchImpl: async () => ({ status: 401 }) })
  assert.equal(gated.status, 'ok')
  assert.match(gated.message, /needs a sign-in/)
  assert.equal((await checkSite('http://x.test', { fetchImpl: async () => ({ status: 502 }) })).status, 'warn')
  assert.equal((await checkSite('http://x.test', { fetchImpl: async () => ({ status: 200 }) })).status, 'ok')
})

test('config keys Shapewall does not use are warned about, with the key that was meant', () => {
  assert.equal(didYouMean('baseURL', ['baseUrl', 'pages']), 'baseUrl')
  assert.equal(didYouMean('viewport', ['viewports']), 'viewports')
  assert.equal(didYouMean('zzz', ['pages']), null)
  const warnings = configKeyWarnings({
    $schema: 'x',
    baseUrl: 'http://x.test',
    conccurency: 2,
    waitFor: '#app',
    pages: [{ id: 'home', path: '/', titel: 'Home' }],
  })
  assert.deepEqual(
    warnings.map((warning) => formatKeyWarning(warning)),
    [
      '"conccurency" is not a config key, so it is ignored. Did you mean "concurrency"?',
      '"waitFor" is ignored here: "waitFor" is a page key, set on each page.',
      '"titel" at pages[0].titel is not a config key, so it is ignored. Did you mean "title"?',
    ],
  )
  assert.match(keyWarningLines(warnings)[0], /^Warning: the config has 3 keys Shapewall does not use/)
  assert.deepEqual(keyWarningLines([]), [])

  // A required key under the wrong case: the error says so instead of "got undefined" alone.
  assert.throws(
    () => normalizeConfig({ baseURL: 'http://x.test', pages: [{ id: 'home', path: '/' }] }, { dir: '/p' }),
    /the config has "baseURL"; keys are case-sensitive, so rename it to "baseUrl"/,
  )
  const config = normalizeConfig({ baseUrl: 'http://x.test', viewport: [], pages: [{ id: 'home', path: '/' }] }, { dir: '/p' })
  assert.equal(config.warnings.length, 1)
  assert.equal(Object.keys(config).includes('warnings'), false, 'not part of the config itself')
  assert.equal(configWarningChecks(config)[0].status, 'warn')
  assert.deepEqual(configKeyWarnings(SAMPLE), [], 'the sample config is clean')
})

test('checks: warnings are printed in the terminal, with a sign-in pointer for a changed destination', () => {
  const { lines, views } = warningLines([
    {
      pageId: 'app',
      viewport: { name: 'desktop' },
      findings: [
        { id: 'destination-changed', severity: 'warning', title: 'The page ended up at another URL' },
        { id: 'x', severity: 'advisory', title: 'Minor' },
      ],
    },
    { pageId: 'home', viewport: { name: 'desktop' }, findings: [] },
  ])
  assert.equal(views, 1)
  assert.equal(
    lines[0],
    '  warning app desktop: The page ended up at another URL. If it is a sign-in page, record a login (Auth in https://shapewall.com/docs/config); if the page moved, update its path.',
  )
  assert.equal(lines[1], "1 advisory not shown. Every finding is in --json and on the board's Checks.")
  assert.deepEqual(warningLines([]).lines, [])
})

test("doctor --install-browser: Playwright's BEWARE becomes one calm note and its box is dropped", () => {
  const state = { noted: false }
  const beware = 'BEWARE: your OS is not officially supported by Playwright; downloading fallback build for ubuntu24.04-x64.'
  assert.equal(installerLine(beware, state), UNSUPPORTED_OS_NOTE)
  assert.equal(installerLine(beware, state), null)
  assert.equal(installerLine(beware, state), null)
  assert.equal(installerLine('╔═══╗', state), null)
  assert.equal(installerLine('Chromium 140.0 downloaded to /x', state), 'Chromium 140.0 downloaded to /x')
})

test('a --selector that matches nothing: where the pin goes, and the board does not invent an element name', () => {
  const note = unmatchedNote({ selector: '#nope', viewport: 'desktop', pageId: 'home', none: true, mapFile: 'm.json' })
  assert.match(note, /^note: "#nope" finds no element in the latest desktop capture\./)
  assert.match(note, /pin sits near the top-left corner of the page \(2% across, 2% down\)/)
  assert.match(note, /comments selectors --page home \(or read m\.json\)/)
  // The board's label for such an anchor (commentParts.jsx, JSX, so read as text here).
  const parts = fs.readFileSync(new URL('../client/src/board/commentParts.jsx', import.meta.url), 'utf8')
  assert.match(parts, /UNMATCHED_ANCHOR_LABEL = 'a selector the capture did not have'/)
})

test('comments delete asks first, needs --yes without a terminal, and deletes on yes', async () => {
  const dir = tempDir('cli-delete')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(SAMPLE))
  const config = loadConfig(file)
  const board = config.boards[0]
  const comment = await createComment(config, board, {
    pageId: 'home',
    viewport: 'desktop',
    x: 10,
    y: 10,
    body: 'Fix the hero',
    author: 'dan',
  })
  const lines = []
  const out = (line) => lines.push(line)
  await assert.rejects(removeComment(config, board, String(comment.id), {}, out, { interactive: false }), /Add --yes to confirm/)
  let asked = ''
  const no = await removeComment(config, board, String(comment.id), {}, out, {
    interactive: true,
    ask: async (question) => {
      asked = question
      return false
    },
  })
  assert.equal(no, 1)
  assert.match(asked, /^Delete #\d+ on .*\("Fix the hero"\)\? This cannot be undone\. \[y\/N\] $/)
  assert.ok(getComment(config, board.id, comment.id), 'still there')
  assert.equal(await removeComment(config, board, String(comment.id), { yes: true }, out), 0)
  assert.match(lines.at(-1), /^Deleted #\d+ on /)
  assert.throws(() => getComment(config, board.id, comment.id))
})

test('init lists every page when only a line or two would be hidden', () => {
  const pages = Array.from({ length: 9 }, (_, index) => ({ id: 'p' + index, path: '/' + index, group: 'g' }))
  assert.equal(pageLines(pages, 8).split('\n').length, 9, 'no "and 1 more"')
  const many = Array.from({ length: 12 }, (_, index) => ({ id: 'p' + index, path: '/' + index, group: 'g' }))
  assert.match(pageLines(many, 8), /\.\.\. and 4 more$/)
})

test('a missing dependency is said as an incomplete install, with the fix', () => {
  const error = Object.assign(new Error("Cannot find package 'express' imported from /x/src/server.js"), { code: 'ERR_MODULE_NOT_FOUND' })
  assert.match(missingPackageMessage(error), /install is incomplete: the package "express" is missing/)
  assert.equal(missingPackageMessage(new Error('other')), null)
})

function memoryStorage() {
  const data = new Map()
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)), data }
}
const STALE = new TypeError('Failed to fetch dynamically imported module: http://x.test/assets/Settings-abc.js')

test('stale chunk: one automatic reload per path per release per window, none without storage', () => {
  resetChunkRecoveryForTests()
  const storage = memoryStorage()
  let reloads = 0
  const deps = (extra = {}) => ({ storage, release: 'r1', path: '/', now: 1000, reload: () => (reloads += 1), ...extra })
  assert.equal(recoverFromChunkLoad(new Error('boom'), deps()), false, 'not a chunk error')
  assert.equal(canRecoverFromChunkLoad(STALE, deps()), true)
  assert.equal(recoverFromChunkLoad(STALE, deps()), true)
  assert.equal(reloads, 1)
  assert.equal(isChunkRecoveryPending(), true)
  assert.equal(claimErrorReport(STALE, deps()), false, 'nothing reported while the reload is pending')
  assert.equal(recoverFromChunkLoad(STALE, deps()), true, 'already under way: no second reload')
  assert.equal(reloads, 1)

  // After the reload (a fresh page): the budget is spent for this path and release.
  resetChunkRecoveryForTests()
  assert.equal(canRecoverFromChunkLoad(STALE, deps({ now: 2000 })), false)
  assert.equal(recoverFromChunkLoad(STALE, deps({ now: 2000 })), false)
  assert.equal(reloads, 1)
  assert.equal(claimErrorReport(STALE, deps({ now: 2000 })), true, 'reported once')
  assert.equal(claimErrorReport(STALE, deps({ now: 3000 })), false, 'not again in the window')
  assert.equal(claimErrorReport(new Error('boom'), deps({ now: 3000 })), true, 'other errors are reported')
  // Another path, a newer release, or the window over: one more reload.
  assert.equal(canRecoverFromChunkLoad(STALE, deps({ path: '/console' })), true)
  assert.equal(canRecoverFromChunkLoad(STALE, deps({ release: 'r2' })), true)
  assert.equal(canRecoverFromChunkLoad(STALE, deps({ now: 1000 + CHUNK_RELOAD_WINDOW_MS })), true)

  // No storage, or storage that does not keep what is written: never reload (it could loop).
  for (const broken of [
    null,
    { getItem: () => null, setItem: () => {} },
    {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    },
  ]) {
    resetChunkRecoveryForTests()
    assert.equal(recoverFromChunkLoad(STALE, deps({ storage: broken })), false)
  }
  assert.equal(reloads, 1)
  resetChunkRecoveryForTests()
})
