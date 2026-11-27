// One-click agent connect on a local board: which agent CLIs are found on
// PATH (looked up, never started), that only the token-protected settings
// route shows them, the save + confirm + test path the board's Connect
// takes, the local display name in /api/info, and `serve --open` handing the
// browser a private page instead of the token on a command line. Against the
// ACP stub only: never a real agent.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OPEN_LINK_HEADLESS_TTL_MS, OPEN_LINK_TTL_MS, createApp, stopChildren } from '../src/server/app.js'
import { normalizeConfig } from '../src/config.js'
import { saveUserAgentEntry } from '../src/agent/user-settings.js'
import { KNOWN_AGENTS, detectAgents } from '../src/agent/acp/detect.js'
import { gitUserName, localUserName } from '../src/server/local-user.js'
import { SAFE_GIT_FLAGS } from '../src/agent/starter/worktree.js'
import { lookupProgram } from '../src/which.js'
import { detectedAgentsLine } from '../src/cli.js'
import { SAMPLE, request, tempDir } from './helpers.js'

const TOKEN = 'connect-token-for-tests-0123456789ab'
const STUB_ACP = fileURLToPath(new URL('./fixtures/acp-stub.mjs', import.meta.url))
const CLI = fileURLToPath(new URL('../bin/shapewall.js', import.meta.url))
const POSIX = process.platform !== 'win32'
const dirs = []
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

function privateDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

// A folder of programs: `stub` ones run the ACP stub, others write a marker
// file when run (so a test can prove detection starts nothing).
function binDir(programs) {
  const dir = privateDir('shapewall-connect-bin-')
  const marker = path.join(dir, 'ran')
  for (const [name, kind] of Object.entries(programs)) {
    const file = path.join(dir, name)
    const body =
      kind === 'stub'
        ? `#!/bin/sh\nexec "${process.execPath}" "${STUB_ACP}" "$@"\n`
        : kind === 'slow'
          ? `#!/bin/sh\nsleep 1\nexec "${process.execPath}" "${STUB_ACP}" "$@"\n`
          : kind === 'crash'
            ? '#!/bin/sh\nexit 3\n'
            : `#!/bin/sh\necho "$0" >> "${marker}"\n`
    fs.writeFileSync(file, body, { mode: 0o755 })
  }
  return { dir, marker }
}

function project(name) {
  const dir = tempDir(name)
  return normalizeConfig(structuredClone(SAMPLE), { dir, file: path.join(dir, 'shapewall.config.json') })
}

// What a redeemed POST /open answers (src/open-page.js sendTokenHandoff): a
// no-store page that puts the token in the tab's sessionStorage and replaces
// itself with the board. No URL holds the token: no Location, nothing to keep in history.
function handoffOf(answer) {
  assert.equal(answer.status, 200)
  assert.equal(answer.headers.location, undefined)
  assert.equal(answer.headers['cache-control'], 'no-store')
  const csp = answer.headers['content-security-policy']
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1]
  assert.ok(nonce, csp)
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /frame-ancestors 'none'/)
  const script = new RegExp(`<script nonce="${nonce.replace(/[+/=]/g, (c) => `\\${c}`)}">const d = (\\{[^<]*?\\});`).exec(answer.text)
  assert.ok(script, answer.text)
  const data = JSON.parse(script[1])
  assert.equal(data.key, 'shapewall-settings-token')
  return data
}

// The page an open link points at (src/open-page.js): its file, nonce and form action.
function openPageOf(link) {
  const file = fileURLToPath(link)
  const html = fs.readFileSync(file, 'utf8')
  return { file, nonce: /name="nonce" value="([^"]+)"/.exec(html)[1], action: /action="([^"]+)"/.exec(html)[1] }
}

function listen(app) {
  return new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
}

async function board(config, env, options = {}) {
  const app = createApp({ config, clientDir: tempDir('connect-client'), env, settingsToken: TOKEN, ...options })
  const server = await listen(app)
  const port = server.address().port
  const auth = (extra = {}) => ({ 'X-Shapewall-Settings-Token': TOKEN, Origin: `http://127.0.0.1:${port}`, ...extra })
  return {
    port,
    get: (pathname, headers = {}) => request(port, 'GET', pathname, { headers }),
    post: (pathname, body) => request(port, 'POST', pathname, { body, headers: auth() }),
    auth,
    close: () => {
      stopChildren(app)
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

test('detect: adapters and CLIs on PATH, restricted commands, install lines, nothing started', { skip: !POSIX }, () => {
  const { dir, marker } = binDir({ 'claude-agent-acp': 'marker', claude: 'marker', codex: 'marker', goose: 'marker' })
  const found = detectAgents({ PATH: dir })
  assert.deepEqual(
    found.map((item) => [item.id, item.state, item.command]),
    [
      ['claude', 'ready', 'claude-agent-acp'],
      ['codex', 'needs-adapter', 'codex-acp'],
      ['goose', 'ready', 'goose acp --with-builtin developer'],
    ],
  )
  const codex = found.find((item) => item.id === 'codex')
  assert.equal(codex.install, 'npm install -g @agentclientprotocol/codex-acp')
  assert.equal(codex.path, path.join(dir, 'codex'))
  assert.equal(found[0].install, null)
  assert.match(found[0].login, /\/login/)
  // Gemini CLI: neither found, so not listed. And no program was run.
  assert.ok(!found.some((item) => item.id === 'gemini'))
  assert.equal(fs.existsSync(marker), false)
  assert.deepEqual(detectAgents({ PATH: '' }), [])
  // The commands match the restricted Settings > Agent buttons.
  const presets = fs.readFileSync(fileURLToPath(new URL('../client/src/settings/AgentSettings.jsx', import.meta.url)), 'utf8')
  for (const agent of KNOWN_AGENTS) assert.ok(presets.includes(`command: '${agent.command}'`), agent.command)
})

test('detect: shown only on the token-protected settings route', { skip: !POSIX }, async () => {
  const { dir } = binDir({ 'claude-agent-acp': 'marker' })
  const home = privateDir('shapewall-connect-home-')
  const entry = await board(project('connect-detect'), { PATH: dir, XDG_CONFIG_HOME: home, HOME: home })
  try {
    const withToken = await entry.get('/api/agent/settings', entry.auth())
    assert.equal(withToken.status, 200)
    assert.deepEqual(
      withToken.json.detected.map((item) => item.id),
      ['claude'],
    )
    // Without the token: a plain 404, and neither /api/info nor the chat status says what is installed.
    const without = await entry.get('/api/agent/settings')
    assert.equal(without.status, 404)
    assert.doesNotMatch(without.text, /claude/)
    const info = await entry.get('/api/info')
    assert.doesNotMatch(info.text, /claude-agent-acp|detected/)
    const status = await entry.get('/api/agent/status')
    assert.doesNotMatch(status.text, /claude-agent-acp|detected/)
  } finally {
    await entry.close()
  }
})

test('connect route: an agent id only, the same confirm as a new command, test ok, chat on', { skip: !POSIX }, async () => {
  const { dir } = binDir({ 'claude-agent-acp': 'stub' })
  const home = privateDir('shapewall-connect-home-')
  const config = project('connect-save')
  const entry = await board(config, { PATH: `${dir}${path.delimiter}${process.env.PATH}`, XDG_CONFIG_HOME: home, HOME: home })
  try {
    assert.equal((await entry.get('/api/agent/status')).json.configured, false)
    // A command from the board is ignored: the server uses its own for the id.
    const first = await entry.post('/api/agent/settings/connect', {
      agentId: 'claude',
      acpCommand: 'rm -rf /',
      settings: { acpCommand: 'x' },
    })
    assert.deepEqual(first.json.confirm, [{ kind: 'command', command: 'claude-agent-acp', projectRoot: fs.realpathSync(config.dir) }])
    assert.equal(fs.existsSync(path.join(home, 'shapewall', 'agents.json')), false, 'nothing saved before the confirm')
    // A wrong hash asks again and saves nothing.
    const wrong = await entry.post('/api/agent/settings/connect', { agentId: 'claude', confirm: 'not-the-hash' })
    assert.equal(wrong.json.confirmHash, first.json.confirmHash)
    assert.equal(fs.existsSync(path.join(home, 'shapewall', 'agents.json')), false)

    const done = await entry.post('/api/agent/settings/connect', { agentId: 'claude', confirm: first.json.confirmHash })
    assert.equal(done.status, 200)
    assert.equal(done.json.connected, true)
    assert.equal(done.json.result.label, 'Claude Code')
    assert.match(done.json.result.message, /^Handshake ok, login not checked/)
    assert.ok(done.json.result.details.some((line) => /claude/.test(line) && /\/login/.test(line)))
    assert.equal(done.json.saved.acpCommand, 'claude-agent-acp')
    assert.equal(done.json.saved.backend, 'acp')
    const status = (await entry.get('/api/agent/status')).json
    assert.equal(status.configured, true)
    assert.equal(status.backend, 'acp')
    // Connected already: the same command needs no confirm the second time.
    const again = await entry.post('/api/agent/settings/connect', { agentId: 'claude' })
    assert.equal(again.json.connected, true)
  } finally {
    await entry.close()
  }
})

test('connect route: unknown ids, agents not installed, no token, another origin are refused', { skip: !POSIX }, async () => {
  const { dir } = binDir({ 'claude-agent-acp': 'stub', codex: 'marker' })
  const home = privateDir('shapewall-connect-home-')
  const entry = await board(project('connect-refused'), { PATH: dir, XDG_CONFIG_HOME: home, HOME: home })
  try {
    const unknown = await entry.post('/api/agent/settings/connect', { agentId: 'evil' })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.json.error.code, 'unknown_agent')
    // codex is there but not codex-acp; gemini is not there at all.
    for (const agentId of ['codex', 'gemini']) {
      const missing = await entry.post('/api/agent/settings/connect', { agentId })
      assert.equal(missing.status, 409, agentId)
      assert.equal(missing.json.error.code, 'agent_not_found')
    }
    const noToken = await request(entry.port, 'POST', '/api/agent/settings/connect', {
      body: { agentId: 'claude' },
      headers: { Origin: `http://127.0.0.1:${entry.port}` },
    })
    assert.equal(noToken.status, 404)
    const otherOrigin = await request(entry.port, 'POST', '/api/agent/settings/connect', {
      body: { agentId: 'claude' },
      headers: entry.auth({ Origin: 'http://evil.example' }),
    })
    assert.equal(otherOrigin.status, 403)
    const proxied = await request(entry.port, 'POST', '/api/agent/settings/connect', {
      body: { agentId: 'claude' },
      headers: entry.auth({ 'X-Forwarded-For': '203.0.113.9' }),
    })
    assert.equal(proxied.status, 403)
    assert.equal(fs.existsSync(path.join(home, 'shapewall', 'agents.json')), false)
  } finally {
    await entry.close()
  }
})

test('connect route: an agent that does not start is reported and what was saved before comes back', { skip: !POSIX }, async () => {
  const { dir } = binDir({ 'claude-agent-acp': 'crash' })
  const home = privateDir('shapewall-connect-home-')
  const config = project('connect-crash')
  const env = { PATH: dir, XDG_CONFIG_HOME: home, HOME: home }
  // An endpoint was set up before.
  saveUserAgentEntry(config.dir, { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2', label: 'Local' }, env)
  const entry = await board(config, env)
  try {
    const first = await entry.post('/api/agent/settings/connect', { agentId: 'claude' })
    const done = await entry.post('/api/agent/settings/connect', { agentId: 'claude', confirm: first.json.confirmHash })
    assert.equal(done.status, 200)
    assert.equal(done.json.connected, false)
    assert.match(done.json.result.message, /did not start/)
    assert.deepEqual(
      { ...done.json.saved, updatedAt: undefined },
      { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2', label: 'Local', updatedAt: undefined },
    )
    const status = (await entry.get('/api/agent/status')).json
    assert.equal(status.backend, 'openai-compatible')
    assert.equal(status.label, 'Local')
  } finally {
    await entry.close()
  }
})

test('local name: SHAPEWALL_USER_NAME, then git user.name, then the OS user; only for this machine on a board not shared', async () => {
  const config = project('connect-name')
  const home = privateDir('shapewall-connect-home-')
  assert.equal(
    localUserName(config.dir, { PATH: process.env.PATH, HOME: home, SHAPEWALL_USER_NAME: ' Robin\u0007 Tester ' }),
    'Robin Tester',
  )
  const git = spawnSync('git', ['--version'])
  if (git.status === 0) {
    const repo = tempDir('connect-name-repo')
    spawnSync('git', ['init', '-q'], { cwd: repo })
    spawnSync('git', ['config', 'user.name', 'Casey Git'], { cwd: repo })
    assert.equal(localUserName(repo, { PATH: process.env.PATH, HOME: home }), 'Casey Git')
  }
  // No git name: the OS user name; none of them: no name (the board asks on the first comment).
  const nogit = privateDir('shapewall-connect-nogit-')
  assert.equal(localUserName(nogit, { PATH: process.env.PATH, HOME: home }, { userInfo: () => ({ username: ' casey ' }) }), 'casey')
  assert.equal(localUserName(nogit, { PATH: process.env.PATH, HOME: home }, { userInfo: () => ({ username: '' }) }), null)
  // A container's or CI runner's account is not a person: no name, so the board asks.
  for (const username of ['node', 'root', 'Runner'])
    assert.equal(localUserName(nogit, { PATH: process.env.PATH, HOME: home }, { userInfo: () => ({ username }) }), null, username)
  assert.equal(
    localUserName(
      nogit,
      { PATH: process.env.PATH, HOME: home },
      {
        userInfo: () => {
          throw new Error('no passwd entry')
        },
      },
    ),
    null,
  )

  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, SHAPEWALL_USER_NAME: 'Robin Tester' }
  const local = await board(config, env)
  const shared = await board(config, env, { allowedHosts: null, shared: true, settingsToken: null })
  try {
    assert.deepEqual((await local.get('/api/info')).json.localUser, { name: 'Robin Tester' })
    // Through a proxy on this machine, the visitor is not the owner.
    assert.equal((await local.get('/api/info', { 'X-Forwarded-For': '203.0.113.9' })).json.localUser, undefined)
    assert.equal((await shared.get('/api/info')).json.localUser, undefined)
  } finally {
    await local.close()
    await shared.close()
  }
})

test('local name: git is an absolute program, started outside the project with -C and the safe flags', { skip: !POSIX }, () => {
  // A git planted in the project and reachable only through relative PATH entries never runs.
  const projectDir = privateDir('shapewall-connect-planted-')
  const marker = path.join(projectDir, 'ran')
  fs.writeFileSync(path.join(projectDir, 'git'), `#!/bin/sh\necho ran > "${marker}"\necho Planted\n`, { mode: 0o755 })
  const relative = path.relative(process.cwd(), projectDir)
  for (const PATH of ['', '.', relative, `.:${relative}:`]) {
    assert.equal(gitUserName(projectDir, { PATH, HOME: projectDir }), null, JSON.stringify(PATH))
  }
  assert.equal(fs.existsSync(marker), false)
  assert.equal(lookupProgram('git', { PATH: relative }), null)
  assert.equal(lookupProgram('git', { PATH: projectDir }).path, path.join(projectDir, 'git'))

  // How the real git is started.
  const calls = []
  const spawnRecord = (program, args, options) => {
    calls.push({ program, args, options })
    return { status: 0, stdout: 'Casey Git\n' }
  }
  const bin = binDir({ git: 'marker' })
  assert.equal(gitUserName(projectDir, { PATH: `.:${bin.dir}`, HOME: projectDir }, { spawn: spawnRecord }), 'Casey Git')
  const [call] = calls
  assert.equal(call.program, path.join(bin.dir, 'git'))
  assert.ok(path.isAbsolute(call.program))
  assert.notEqual(call.options.cwd, projectDir)
  assert.equal(call.options.cwd, os.tmpdir())
  assert.equal(call.options.shell, false)
  assert.equal(call.options.env.GIT_CONFIG_NOSYSTEM, '1')
  assert.deepEqual(call.args.slice(0, SAFE_GIT_FLAGS.length), SAFE_GIT_FLAGS)
  assert.ok(call.args.includes('core.hooksPath=/dev/null') && call.args.includes('core.fsmonitor=false'))
  assert.deepEqual(call.args.slice(SAFE_GIT_FLAGS.length), ['-C', projectDir, 'config', '--get', 'user.name'])
})

test('detect: relative PATH entries are skipped; on Windows only .exe/.com are ready, .cmd needs a shell', { skip: !POSIX }, () => {
  const { dir, marker } = binDir({ 'claude-agent-acp': 'marker' })
  const relative = path.relative(process.cwd(), dir)
  assert.deepEqual(detectAgents({ PATH: `.:${relative}:` }), [])
  assert.equal(detectAgents({ PATH: `${relative}:${dir}` })[0].path, path.join(dir, 'claude-agent-acp'))

  const win = privateDir('shapewall-connect-win-')
  fs.writeFileSync(path.join(win, 'claude-agent-acp.cmd'), '@echo off\r\n')
  fs.writeFileSync(path.join(win, 'goose.exe'), 'MZ')
  fs.writeFileSync(path.join(win, 'gemini.bat'), '@echo off\r\n')
  const found = detectAgents({ Path: win }, { platform: 'win32' })
  assert.deepEqual(
    found.map((item) => [item.id, item.state, path.basename(item.path)]),
    [
      ['claude', 'needs-shell', 'claude-agent-acp.cmd'],
      ['goose', 'ready', 'goose.exe'],
      ['gemini', 'needs-shell', 'gemini.bat'],
    ],
  )
  assert.equal(found[0].install, null)
  // A .cmd with an .exe of the same name later on PATH: the .exe wins.
  const later = privateDir('shapewall-connect-win2-')
  fs.writeFileSync(path.join(later, 'claude-agent-acp.exe'), 'MZ')
  assert.equal(detectAgents({ Path: `${win};${later}` }, { platform: 'win32' })[0].state, 'ready')
  assert.equal(fs.existsSync(marker), false)
})

test('connect route: refused while --agent-acp or SHAPEWALL_AGENT_ACP sets the command', { skip: !POSIX }, async () => {
  const { dir } = binDir({ 'claude-agent-acp': 'stub' })
  const home = privateDir('shapewall-connect-home-')
  const env = { PATH: dir, XDG_CONFIG_HOME: home, HOME: home }
  for (const [how, options, extraEnv] of [
    ['env', {}, { SHAPEWALL_AGENT_ACP: STUB_ACP }],
    ['flag', { agentAcp: STUB_ACP }, {}],
  ]) {
    const entry = await board(project(`connect-override-${how}`), { ...env, ...extraEnv }, options)
    try {
      const refused = await entry.post('/api/agent/settings/connect', { agentId: 'claude' })
      assert.equal(refused.status, 409, how)
      assert.equal(refused.json.error.code, 'acp_overridden')
      assert.match(refused.json.error.message, how === 'flag' ? /--agent-acp/ : /SHAPEWALL_AGENT_ACP/)
      assert.equal(fs.existsSync(path.join(home, 'shapewall', 'agents.json')), false)
    } finally {
      await entry.close()
    }
  }
})

test('connect route: a save while its test runs is refused, so the restore cannot lose it', { skip: !POSIX }, async () => {
  const { dir } = binDir({ 'claude-agent-acp': 'slow' })
  const home = privateDir('shapewall-connect-home-')
  const entry = await board(project('connect-race'), {
    PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    XDG_CONFIG_HOME: home,
    HOME: home,
  })
  try {
    const first = await entry.post('/api/agent/settings/connect', { agentId: 'claude' })
    const connecting = entry.post('/api/agent/settings/connect', { agentId: 'claude', confirm: first.json.confirmHash })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const save = await entry.post('/api/agent/settings', { settings: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' } })
    assert.equal(save.status, 409)
    assert.equal(save.json.error.code, 'test_running')
    const again = await entry.post('/api/agent/settings/connect', { agentId: 'claude' })
    assert.equal(again.status, 409)
    const done = await connecting
    assert.equal(done.json.connected, true)
    assert.equal(done.json.saved.acpCommand, 'claude-agent-acp')
    // Once it is over, saving works again.
    const later = await entry.post('/api/agent/settings', { settings: { ...done.json.saved, label: 'Mine' } })
    assert.equal(later.status, 200)
    assert.equal(later.json.saved.label, 'Mine')
  } finally {
    await entry.close()
  }
})

test('open link: a 0600 page posts a one-use nonce, a minute, local and direct only, no-store; none without a token', async (t) => {
  const home = privateDir('shapewall-connect-home-')
  const env = { PATH: process.env.PATH, XDG_CONFIG_HOME: home, HOME: home }
  const config = project('connect-open')
  const app = createApp({ config, clientDir: tempDir('connect-open-client'), env, settingsToken: TOKEN })
  const server = await listen(app)
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/`
  const redeem = (nonce, headers = {}) =>
    request(port, 'POST', '/open', {
      body: `nonce=${nonce}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null', ...headers },
    })
  try {
    const link = app.locals.openLink(base)
    assert.equal(new URL(link).protocol, 'file:')
    const first = openPageOf(link)
    assert.equal(path.dirname(first.file), config.outputDir)
    assert.equal(first.action, `${base}open`)
    assert.match(first.nonce, /^[A-Za-z0-9_-]{32}$/)
    assert.ok(!link.includes(first.nonce), 'the nonce is not in the link')
    if (POSIX) assert.equal(fs.statSync(first.file).mode & 0o777, 0o600)
    // GET never redeems, not even with the nonce in the path.
    assert.equal((await request(port, 'GET', `/open/${first.nonce}`)).status, 410)
    assert.equal((await request(port, 'GET', '/open')).status, 410)
    const opened = await redeem(first.nonce)
    assert.deepEqual(handoffOf(opened), { key: 'shapewall-settings-token', token: TOKEN, target: './' })
    assert.equal(opened.headers['cache-control'], 'no-store')
    assert.equal(fs.existsSync(first.file), false, 'the page is removed once used')
    const second = await redeem(first.nonce)
    assert.equal(second.status, 410)
    assert.ok(!second.text.includes(TOKEN))
    assert.equal(second.headers['cache-control'], 'no-store')
    // Through a proxy, or from another site: refused, and the nonce is spent.
    for (const headers of [{ 'X-Forwarded-For': '203.0.113.9' }, { Origin: 'https://evil.example' }]) {
      const spent = openPageOf(app.locals.openLink(base))
      assert.equal((await redeem(spent.nonce, headers)).status, 410)
      assert.equal((await redeem(spent.nonce)).status, 410)
      assert.equal(fs.existsSync(spent.file), false)
    }
    // A made-up nonce.
    assert.equal((await redeem('not-a-real-nonce')).status, 410)
    // Expired after a minute.
    const stale = openPageOf(app.locals.openLink(base))
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    t.mock.timers.tick(OPEN_LINK_TTL_MS + 1)
    const expired = await redeem(stale.nonce)
    t.mock.timers.reset()
    assert.equal(expired.status, 410)
    assert.match(expired.text, /used or has expired/)
    // No browser could be opened for it: five minutes, then gone.
    const kept = app.locals.openLink(base)
    const keptLate = app.locals.openLink(base)
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    app.locals.keepOpenLink(kept)
    app.locals.keepOpenLink(keptLate)
    t.mock.timers.tick(OPEN_LINK_TTL_MS * 3)
    const stillOpen = await redeem(openPageOf(kept).nonce)
    t.mock.timers.tick(OPEN_LINK_HEADLESS_TTL_MS)
    const tooLate = await redeem(openPageOf(keptLate).nonce)
    t.mock.timers.reset()
    assert.equal(handoffOf(stillOpen).token, TOKEN)
    assert.equal(tooLate.status, 410)
    // At stop, every waiting page goes.
    const waiting = openPageOf(app.locals.openLink(base))
    stopChildren(app)
    assert.equal(fs.existsSync(waiting.file), false, 'pages are removed at stop')
  } finally {
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
  }
  // A shared board has no settings token, so no open link either.
  const shared = createApp({ config: project('connect-open-shared'), clientDir: tempDir('connect-open-client'), env, allowedHosts: null })
  assert.equal(shared.locals.openLink, null)
})

for (const headless of [false, true])
  test(
    `serve --open${headless ? ' with no browser' : ''}: the opener argv holds neither the token nor the nonce, and no output holds the nonce`,
    { skip: !POSIX },
    async () => {
      // The real serve: a fake xdg-open records what it was given (and, headless, fails as with no display).
      const bin = privateDir('shapewall-connect-opener-')
      const log = path.join(bin, 'args.txt')
      fs.writeFileSync(
        path.join(bin, 'xdg-open'),
        `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}.tmp"\nmv "${log}.tmp" "${log}"\n${headless ? 'exit 3\n' : ''}`,
        { mode: 0o755 },
      )
      const home = privateDir('shapewall-connect-home-')
      const dir = tempDir('connect-serve-argv')
      fs.writeFileSync(path.join(dir, 'shapewall.config.json'), JSON.stringify(SAMPLE))
      const env = {
        PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
        HOME: home,
        XDG_CONFIG_HOME: home,
        SHAPEWALL_PRINT_OWNER_LINK: '1',
      }
      const child = spawn(
        process.execPath,
        [CLI, 'serve', '--port', '0', '--open', '--no-chat', '--config', path.join(dir, 'shapewall.config.json')],
        {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let output = ''
      child.stdout.on('data', (chunk) => (output += chunk))
      child.stderr.on('data', (chunk) => (output += chunk))
      const ended = new Promise((resolve) => child.once('exit', resolve))
      try {
        const deadline = Date.now() + 15000
        while (!fs.existsSync(log) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
        if (headless)
          while (!/open this link/.test(output) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
        const token = /#settings-token=([A-Za-z0-9_-]+)/.exec(output)?.[1]
        assert.ok(token, output)
        const argv = fs.readFileSync(log, 'utf8')
        const args = argv.trim().split('\n')
        assert.equal(args.length, 1)
        assert.equal(new URL(args[0]).protocol, 'file:')
        const page = openPageOf(args[0])
        assert.equal(path.dirname(page.file), path.join(dir, '.shapewall'))
        assert.equal(fs.statSync(page.file).mode & 0o777, 0o600)
        assert.ok(!argv.includes(page.nonce), 'the nonce is not in the opener arguments')
        assert.ok(!argv.includes(token), 'the token is not in the opener arguments')
        assert.ok(!output.includes(page.nonce), 'the nonce is not in the output')
        if (headless) assert.match(output, /open this link: file:\/\/.*expires in 5 minutes/)
        const opened = new URL(page.action)
        assert.equal(opened.pathname, '/open')
        const post = (nonce) =>
          request(Number(opened.port), 'POST', '/open', {
            body: `nonce=${nonce}`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' },
          })
        if (!headless) {
          const answer = await post(page.nonce)
          assert.equal(handoffOf(answer).token, token)
          assert.equal(fs.existsSync(page.file), false, 'the page is removed once used')
          assert.equal((await post(page.nonce)).status, 410)
        }
        // A page still waiting at stop (headless: not used) is removed.
        child.kill('SIGTERM')
        await ended
        assert.deepEqual(
          fs.readdirSync(path.join(dir, '.shapewall')).filter((name) => name.startsWith('open-')),
          [],
        )
        assert.ok(!output.includes(page.nonce), 'the nonce is not in the output')
      } finally {
        child.kill('SIGKILL')
      }
    },
  )

for (const chat of [true, false])
  test(
    `serve --open with chat ${chat ? 'on' : 'off'}: private owner link keeps the token off command lines`,
    { skip: !POSIX },
    async () => {
      // The real serve: a fake xdg-open records what it was given.
      const bin = privateDir('shapewall-connect-opener-')
      const log = path.join(bin, 'args.txt')
      fs.writeFileSync(path.join(bin, 'xdg-open'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}.tmp"\nmv "${log}.tmp" "${log}"\n`, {
        mode: 0o755,
      })
      const { dir: agents } = binDir({ 'claude-agent-acp': 'marker' })
      const home = privateDir('shapewall-connect-home-')
      const dir = tempDir('connect-serve')
      fs.writeFileSync(path.join(dir, 'shapewall.config.json'), JSON.stringify(SAMPLE))
      const env = {
        PATH: [bin, agents, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
        HOME: home,
        XDG_CONFIG_HOME: home,
        // Not a terminal here: the owner link is printed only on request.
        SHAPEWALL_PRINT_OWNER_LINK: '1',
      }
      const child = spawn(
        process.execPath,
        [CLI, 'serve', '--port', '0', '--open', ...(!chat ? ['--no-chat'] : []), '--config', path.join(dir, 'shapewall.config.json')],
        {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let output = ''
      child.stdout.on('data', (chunk) => (output += chunk))
      try {
        const deadline = Date.now() + 15000
        while (!fs.existsSync(log) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
        const token = /#settings-token=([A-Za-z0-9_-]+)/.exec(output)?.[1]
        assert.ok(token, output)
        if (chat) assert.match(output, /Agents found on this machine: Claude Code\. Connect one in the Agent panel/)
        const args = fs.readFileSync(log, 'utf8').trim().split('\n')
        assert.equal(args.length, 1)
        const page = openPageOf(args[0])
        const opened = new URL(page.action)
        assert.equal(opened.protocol, 'http:')
        assert.equal(opened.hostname, '127.0.0.1')
        assert.equal(opened.pathname, '/open')
        assert.ok(!args[0].includes(token), 'the token is not in the opener arguments')
        assert.ok(!args[0].includes(page.nonce), 'the nonce is not in the opener arguments')
        const post = () =>
          request(Number(opened.port), 'POST', '/open', {
            body: `nonce=${page.nonce}`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' },
          })
        const answer = await post()
        assert.equal(handoffOf(answer).token, token)
        assert.equal((await post()).status, 410)
        const info = await request(Number(opened.port), 'GET', '/api/info', { headers: { 'X-Shapewall-Settings-Token': token } })
        assert.equal(info.json.shareEnabled, true, 'sharing remains available with chat off')
        if (!chat) assert.equal(info.json.agent, null)
      } finally {
        child.kill('SIGTERM')
      }
    },
  )

test('serve line: ready agents, ones missing their adapter or needing a shell, nothing when none', () => {
  assert.equal(
    detectedAgentsLine([
      { label: 'Claude Code', state: 'ready' },
      { label: 'goose', state: 'ready' },
      { label: 'Codex', state: 'needs-adapter' },
      { label: 'Gemini CLI', state: 'needs-shell' },
    ]),
    'Agents found on this machine: Claude Code, goose. Connect one in the Agent panel (open the link above). Installed without their ACP adapter: Codex (the Agent panel shows the install line). Installed only as .cmd wrappers, which need a shell: Gemini CLI (see the chat docs).',
  )
  assert.equal(detectedAgentsLine([]), null)
  // A first run that did not ask for chat: only agents ready to connect, no adapter or shell jargon.
  const found = [
    { label: 'Claude Code', state: 'needs-adapter' },
    { label: 'Gemini CLI', state: 'needs-shell' },
  ]
  assert.equal(detectedAgentsLine(found, { detail: false }), null)
  assert.equal(
    detectedAgentsLine([{ label: 'goose', state: 'ready' }, ...found], { detail: false }),
    'Agents found on this machine: goose. Connect one in the Agent panel (open the link above).',
  )
})
