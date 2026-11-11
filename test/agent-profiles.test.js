// Real ACP wire interactions against software stubs only. No provider login or real agents.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, stopChildren } from '../src/server/app.js'
import { saveUserAgentEntry, userAgentEntry, validateUserEntry } from '../src/agent/user-settings.js'
import { agentSettings } from '../src/agent/config.js'
import { acpHandshake } from '../src/agent/backends/acp.js'
import { createComment } from '../src/store.js'
import { sampleConfig, tempDir, request } from './helpers.js'

const TOKEN = 'native-profile-fixture-capability'
const STUB = fileURLToPath(new URL('./fixtures/acp-stub.mjs', import.meta.url))
const profiles = [
  { id: 'claude', label: 'Claude Code', acpCommand: 'claude-agent-acp' },
  { id: 'codex', label: 'Codex', acpCommand: 'codex-acp' },
  { id: 'goose', label: 'goose', acpCommand: 'goose acp --with-builtin developer' },
]
async function board(
  t,
  {
    saved = true,
    max = 2,
    crash = false,
    handshakeBarrier = false,
    config = sampleConfig('profiles'),
    env: priorEnv = null,
    ...options
  } = {},
) {
  const home = tempDir('profiles-home')
  const bin = path.join(home, 'bin')
  const started = path.join(home, 'handshake-started')
  const release = path.join(home, 'handshake-release')
  fs.mkdirSync(bin)
  for (const profile of profiles) {
    fs.writeFileSync(
      path.join(bin, profile.acpCommand.split(' ')[0]),
      handshakeBarrier && profile.id === 'codex'
        ? `#!/bin/sh\n: > "${started}"\nwhile [ ! -f "${release}" ]; do sleep 0.01; done\nexit 3\n`
        : crash && profile.id === 'codex'
          ? '#!/bin/sh\nexit 3\n'
          : `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`,
      { mode: 0o755 },
    )
  }
  const env = priorEnv || { HOME: home, XDG_CONFIG_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  if (saved) saveUserAgentEntry(config.dir, { backend: 'acp', acpCommand: profiles[0].acpCommand, profiles }, env)
  for (let i = 0; i < 2; i++)
    await createComment(config, config.boards[0], { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: 'Fixture' })
  const app = createApp({
    config,
    env,
    clientDir: tempDir('profiles-client'),
    settingsToken: TOKEN,
    agentLimits: { runsMax: max, burst: 100, perMinute: 100, acp: { idleMs: 30000 } },
    ...options,
  })
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`
  const headers = { Origin: origin, 'X-Shapewall-Settings-Token': TOKEN }
  const api = (method, endpoint, body, extra = {}) => request(port, method, endpoint, { body, headers: { ...headers, ...extra } })
  const base = '/api/agent/boards/sample/threads/'
  const select = (thread, profileId, extra) => api('POST', `${base}${thread}/profile`, { profileId }, extra)
  const send = (thread, text) =>
    fetch(`${origin}${base}${thread}/messages`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
  const close = async () => {
    stopChildren(app)
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
  t.after(close)
  return { app, port, config, env, api, base, select, send, close, started, release }
}

async function finish(response) {
  assert.equal(response.status, 200)
  const text = await response.text()
  const done = text.split('\n\n').find((block) => block.startsWith('event: done\n'))
  assert.ok(done, text)
  return JSON.parse(/^data: (.*)$/m.exec(done)[1]).message
}

// Wait for actual streamed wire evidence, with a bounded failure instead of timing guesses.
async function firstEvent(response, eventName) {
  const reader = response.body.getReader()
  let text = ''
  const timeout = setTimeout(() => reader.cancel(), 5000)
  try {
    while (!text.includes(`event: ${eventName}\n`)) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`No ${eventName}: ${text}`)
      text += new TextDecoder().decode(value)
    }
  } finally {
    clearTimeout(timeout)
  }
  return { reader, text }
}

const POSIX = process.platform !== 'win32'
test('failed handshake spawn releases its slot without an exit event', async () => {
  const root = tempDir('handshake-missing-program')
  const processPool = { agents: new Set(), max: 1, epoch: 0 }
  const settings = { label: 'Fixture agent', acp: { argv: [path.join(root, 'missing-executable')] } }
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await acpHandshake(settings, { root, processPool, timeoutMs: 1000 })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'agent_start')
    assert.equal(processPool.agents.size, 0)
  }
  const recovered = await acpHandshake({ ...settings, acp: { argv: [process.execPath, STUB] } }, { root, processPool, timeoutMs: 1000 })
  assert.equal(recovered.ok, true, 'a later valid handshake can use the released slot')
})

test('profiles validate private commands, unique ids, labels, and leave legacy settings valid', () => {
  assert.equal(validateUserEntry({ backend: 'acp', acpCommand: 'codex-acp' }).problems.length, 0)
  for (const value of [
    [...profiles, profiles[0]],
    [{ ...profiles[0], id: '../x' }],
    [{ ...profiles[0], acpCommand: 'x\nwhoami' }],
    [{ ...profiles[0], token: 'no' }],
    [{ ...profiles[0], label: '' }],
  ])
    assert.ok(validateUserEntry({ profiles: value }).problems.length)
  assert.deepEqual(validateUserEntry({ profiles }).entry.profiles, profiles)
})

test(
  'native connect confirms fixed server commands, tests handshake, preserves other profiles and old form saves',
  { skip: !POSIX },
  async (t) => {
    const b = await board(t, { saved: false })
    for (const id of ['claude', 'codex', 'goose']) {
      const first = await b.api('POST', '/api/agent/settings/profiles/connect', { agentId: id, acpCommand: 'untrusted-command' })
      assert.equal(first.status, 200)
      assert.deepEqual(first.json.confirm, [
        { kind: 'command', command: profiles.find((p) => p.id === id).acpCommand, projectRoot: fs.realpathSync(b.config.dir) },
      ])
      const next = await b.api('POST', '/api/agent/settings/profiles/connect', { agentId: id, confirm: first.json.confirmHash })
      assert.equal(next.json.connected, true, JSON.stringify(next.json))
      assert.equal(next.json.saved.profiles.length, ['claude', 'codex', 'goose'].indexOf(id) + 1)
    }
    const before = userAgentEntry(b.config.dir, b.env).entry
    const saved = await b.api('POST', '/api/agent/settings', { settings: { backend: 'acp', acpCommand: 'claude-agent-acp' } })
    assert.deepEqual(saved.json.saved.profiles, profiles)
    assert.equal(saved.json.saved.acpCommand, before.acpCommand)
    const publicView = await b.api('GET', `${b.base}board`)
    assert.deepEqual(
      publicView.json.profiles.map((p) => p.id),
      ['default', 'claude', 'codex', 'goose'],
    )
    assert.doesNotMatch(JSON.stringify(publicView.json), /acpCommand|argv|XDG_CONFIG_HOME/)
  },
)

test('failed native handshake restores all old settings; operator command cannot be bypassed', { skip: !POSIX }, async (t) => {
  const b = await board(t, { saved: false, crash: true })
  saveUserAgentEntry(b.config.dir, { profiles: [profiles[0]] }, b.env)
  const first = await b.api('POST', '/api/agent/settings/profiles/connect', { agentId: 'codex' })
  const next = await b.api('POST', '/api/agent/settings/profiles/connect', { agentId: 'codex', confirm: first.json.confirmHash })
  assert.equal(next.json.connected, false)
  assert.deepEqual(next.json.saved.profiles, [profiles[0]])
  assert.equal(next.json.saved.acpCommand, undefined)
  assert.equal(agentSettings(b.config, b.env, { acp: STUB, profileId: 'claude' }).configured, false)
  const locked = await board(t, { agentAcp: STUB })
  assert.equal((await locked.select('board', 'codex')).status, 400)
  assert.equal((await locked.api('POST', '/api/agent/settings/profiles/connect', { agentId: 'codex' })).json.error.code, 'acp_overridden')
})

test('profile selection is owner-only, same-origin, per-thread and survives transcript writes/restart', { skip: !POSIX }, async (t) => {
  const b = await board(t)
  assert.equal((await b.select('board', 'codex', { 'X-Shapewall-Settings-Token': '' })).status, 403)
  assert.equal((await b.select('board', 'codex', { Origin: 'http://elsewhere.invalid' })).status, 403)
  assert.equal((await b.select('board', 'untrusted')).status, 400)
  assert.equal((await b.select('board', 'codex')).status, 200)
  assert.equal((await b.select('comment-1', 'goose')).status, 200)
  const reply = await finish(await b.send('board', 'pid'))
  assert.match(reply.text, /\d+/)
  assert.equal((await b.api('GET', `${b.base}board`)).json.profileId, 'codex')
  assert.equal((await b.api('GET', `${b.base}comment-1`)).json.agent.label, 'goose')
  const denied = await b.api('POST', `${b.base}board/messages`, { text: 'pid' }, { 'X-Shapewall-Settings-Token': '' })
  assert.equal(denied.status, 403)
  // New router with same files has no in-memory ownerThreads marker.
  const fresh = await board(t, { config: b.config, env: b.env, saved: false })
  const deleteDenied = await fresh.api('DELETE', `${fresh.base}board`, undefined, { 'X-Shapewall-Settings-Token': '' })
  assert.equal(deleteDenied.status, 403)
  assert.equal((await fresh.api('GET', `${fresh.base}board`)).json.profileId, 'codex')
})

test('switching resets only that thread, keeps history, removed profile fails closed', { skip: !POSIX }, async (t) => {
  const b = await board(t)
  await b.select('board', 'claude')
  const old = await finish(await b.send('board', 'pid'))
  await b.select('board', 'codex')
  const next = await finish(await b.send('board', 'pid'))
  assert.notEqual(old.text, next.text)
  assert.equal((await b.api('GET', `${b.base}board`)).json.messages.length, 4)
  assert.equal((await b.api('DELETE', '/api/agent/settings/profiles/codex')).status, 200)
  const failed = await b.send('board', 'pid')
  assert.equal(failed.status, 409)
  assert.equal((await failed.json()).error.code, 'agent_not_configured')
  assert.equal((await b.select('board', 'default')).status, 200)
  await finish(await b.send('board', 'pid'))
})

test('profiles share global run and process caps, keep other active profiles, and owner stop/approvals', { skip: !POSIX }, async (t) => {
  const b = await board(t, { max: 2 })
  await b.select('board', 'claude')
  await b.select('comment-1', 'codex')
  await b.select('comment-2', 'goose')
  const first = await b.send('board', 'slowly')
  const active1 = await firstEvent(first, 'text')
  const second = await b.send('comment-1', 'permission')
  const active2 = await firstEvent(second, 'tool')
  assert.equal(b.app.locals.agentRouter.processes().filter((item) => item.busy).length, 2)
  assert.equal((await b.api('DELETE', '/api/agent/settings/profiles/goose')).status, 409)
  assert.equal((await b.api('POST', '/api/agent/settings/test', {})).json.error.code, 'agent_running')
  assert.equal((await b.select('board', 'goose')).status, 409)
  const overflow = await b.send('comment-2', 'pid')
  assert.equal(overflow.status, 429)
  await overflow.body.cancel()
  assert.equal((await b.api('POST', `${b.base}board/stop`, {}, { 'X-Shapewall-Settings-Token': '' })).status, 403)
  assert.equal((await b.api('POST', `${b.base}board/stop`, {})).json.stopped, true)
  await active1.reader.cancel()
  const permissionBlock = active2.text.split('\n\n').find((line) => line.startsWith('event: tool\n'))
  const permission = JSON.parse(/^data: (.*)$/m.exec(permissionBlock)[1])
  assert.equal(
    (
      await b.api(
        'POST',
        `${b.base}comment-1/permissions/${permission.id}`,
        { optionId: permission.options[0].optionId },
        { 'X-Shapewall-Settings-Token': '' },
      )
    ).status,
    403,
  )
  assert.equal(
    (await b.api('POST', `${b.base}comment-1/permissions/${permission.id}`, { optionId: permission.options[0].optionId })).status,
    200,
  )
  while (!(await active2.reader.read()).done) {
    /* wait for the approved turn */
  }
  // A third profile evicts idle ACP state globally, rather than leaving one pool per profile.
  await finish(await b.send('comment-2', 'pid'))
  assert.equal(b.app.locals.agentRouter.processes().length, 2)
  assert.ok(b.app.locals.agentRouter.processes().some((item) => item.thread === 'sample/comment-2'))
  // Revisiting another profile still respects the shared process budget.
  const previous = await finish(await b.send('comment-1', 'pid'))
  assert.match(previous.text, /\d+/)
  assert.equal(b.app.locals.agentRouter.processes().length, 2)
})

test('named profiles cannot grant agent execution on a shared board', { skip: !POSIX }, async (t) => {
  const b = await board(t, { shared: true, allowRemoteAgent: true, chat: true })
  const selected = await b.select('board', 'codex')
  assert.equal(selected.status, 403)
  // A profile chosen by a prior private server is still not executable by a shared visitor.
  const { setThreadProfile } = await import('../src/agent/threads.js')
  await setThreadProfile(b.config, 'sample', 'board', 'codex')
  const response = await b.send('board', 'pid')
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.code, 'control_needs_owner')
  assert.equal(b.app.locals.agentRouter.processes().length, 0)
})

test('connection handshake excludes turns/profile changes until rollback completes', { skip: !POSIX }, async (t) => {
  const b = await board(t, { handshakeBarrier: true })
  saveUserAgentEntry(b.config.dir, { backend: 'acp', acpCommand: profiles[0].acpCommand, profiles: [profiles[0]] }, b.env)
  const first = await b.api('POST', '/api/agent/settings/profiles/connect', { agentId: 'codex' })
  t.after(() => fs.writeFileSync(b.release, 'release fixture'))
  const pending = b.api('POST', '/api/agent/settings/profiles/connect', { agentId: 'codex', confirm: first.json.confirmHash })
  const deadline = Date.now() + 5000
  while (!fs.existsSync(b.started)) {
    assert.ok(Date.now() < deadline, 'fixture handshake should start')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const message = await b.send('board', 'pid')
  assert.equal(message.status, 409)
  assert.equal((await message.json()).error.code, 'test_running')
  assert.equal((await b.select('board', 'claude')).json.error.code, 'test_running')
  assert.deepEqual(
    b.app.locals.agentRouter.processes().map((item) => item.thread),
    ['doctor'],
  )
  fs.writeFileSync(b.release, 'release fixture')
  const failed = await pending
  assert.equal(failed.json.connected, false)
  assert.deepEqual(failed.json.saved.profiles, [profiles[0]])
  await finish(await b.send('board', 'pid'))
})

test('retiring native processes hold the global slot until actual exit', { skip: !POSIX }, async (t) => {
  const b = await board(t, { max: 1 })
  saveUserAgentEntry(
    b.config.dir,
    {
      backend: 'acp',
      acpCommand: profiles[0].acpCommand,
      profiles: profiles.map((profile) => ({ ...profile, acpCommand: `${profile.acpCommand} --retire-slow` })),
    },
    b.env,
  )
  await b.select('board', 'claude')
  const first = await finish(await b.send('board', 'pid'))
  const pid = Number(/pid (\d+)/.exec(first.text)?.[1])
  assert.ok(pid > 0)
  await b.select('board', 'codex')
  assert.doesNotThrow(() => process.kill(pid, 0), 'fixture remains alive during termination grace')
  assert.equal(b.app.locals.agentRouter.processes().length, 1, 'retiring process retains its reservation')
  const second = await finish(await b.send('board', 'pid'))
  assert.notEqual(first.text, second.text)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'replacement starts only after previous child exits')
  assert.equal(b.app.locals.agentRouter.processes().length, 1)
  // Explicit connection tests share the same slot, including idle and retiring sessions.
  const checked = await b.api('POST', '/api/agent/settings/test', {})
  assert.equal(checked.json.ok, true)
  const secondPid = Number(/pid (\d+)/.exec(second.text)?.[1])
  assert.throws(() => process.kill(secondPid, 0), { code: 'ESRCH' })
  assert.ok(b.app.locals.agentRouter.processes().length <= 1)
})

test(
  'one list of agents: a legacy default command shows as a profile, joins the list on the next connect, and removal moves the default',
  { skip: !POSIX },
  async (t) => {
    const b = await board(t, { saved: false })
    // Settings from before profiles: one-click Connect saved only the default command.
    saveUserAgentEntry(b.config.dir, { backend: 'acp', acpCommand: 'claude-agent-acp' }, b.env)
    const legacy = await b.api('GET', '/api/agent/settings')
    assert.deepEqual(legacy.json.profiles, [
      {
        id: 'claude',
        label: 'Claude Code',
        command: 'claude-agent-acp',
        legacy: true,
        default: true,
        state: 'ready',
        loginHint: 'run `claude` in a terminal and use /login, or start the agent with `claude-agent-acp --cli` and use /login there',
        // Its default icon: the product mark (src/agent/agent-logos.js).
        logo: 'claude',
      },
    ])
    assert.equal(legacy.json.saved.profiles, undefined, 'nothing is rewritten by reading')
    const chat = await b.api('GET', b.base + 'board')
    assert.equal(chat.json.profiles[0].sameAs, undefined, 'the default is its own entry until it joins the list')

    // Adding Codex keeps Claude Code in the list; only the new command is confirmed.
    const first = await b.api('POST', '/api/agent/settings/profiles/connect', { agentId: 'codex' })
    assert.deepEqual(
      first.json.confirm.map((item) => item.command),
      ['codex-acp'],
    )
    const next = await b.api('POST', '/api/agent/settings/profiles/connect', { agentId: 'codex', confirm: first.json.confirmHash })
    assert.equal(next.json.connected, true, JSON.stringify(next.json))
    assert.deepEqual(next.json.saved.profiles, [profiles[0], profiles[1]])
    assert.equal(next.json.saved.acpCommand, 'claude-agent-acp', 'new chats still use Claude Code')
    assert.deepEqual(
      next.json.profiles.map((item) => [item.id, item.default]),
      [
        ['claude', true],
        ['codex', false],
      ],
    )
    const picker = await b.api('GET', b.base + 'board')
    assert.deepEqual(
      picker.json.profiles.map((item) => [item.id, item.label, item.sameAs || null]),
      [
        ['default', 'Claude Code', 'claude'],
        ['claude', 'Claude Code', null],
        ['codex', 'Codex', null],
      ],
    )

    // Removing the agent new chats use moves them to the next one, without asking again.
    const removed = await b.api('DELETE', '/api/agent/settings/profiles/claude')
    assert.equal(removed.status, 200, JSON.stringify(removed.json))
    assert.equal(removed.json.confirm, undefined)
    assert.equal(removed.json.saved.acpCommand, 'codex-acp')
    assert.deepEqual(removed.json.saved.profiles, [profiles[1]])
    const last = await b.api('DELETE', '/api/agent/settings/profiles/codex')
    assert.equal(last.json.saved.acpCommand, undefined)
    assert.equal(last.json.saved.backend, undefined)
    assert.deepEqual(last.json.profiles, [])
  },
)

test('removing a legacy default command shown as a profile clears it', { skip: !POSIX }, async (t) => {
  const b = await board(t, { saved: false })
  saveUserAgentEntry(b.config.dir, { backend: 'acp', acpCommand: 'claude-agent-acp' }, b.env)
  const removed = await b.api('DELETE', '/api/agent/settings/profiles/claude')
  assert.equal(removed.status, 200)
  assert.equal(removed.json.saved.acpCommand, undefined)
  assert.deepEqual(removed.json.profiles, [])
})

test(
  'the default agent: chosen from Settings without a new confirmation; chats that chose another keep it',
  { skip: !POSIX },
  async (t) => {
    const b = await board(t)
    const before = await b.api('GET', '/api/agent/settings')
    assert.deepEqual(
      before.json.profiles.map((item) => [item.id, item.default]),
      [
        ['claude', true],
        ['codex', false],
        ['goose', false],
      ],
    )
    assert.equal(before.json.endpoint, null, 'no endpoint saved')
    assert.deepEqual(
      before.json.known.map((item) => item.id),
      ['claude', 'codex', 'goose', 'gemini'],
      'every agent Shapewall knows, found or not',
    )
    assert.equal((await b.select('comment-1', 'goose')).status, 200)
    const made = await b.api('POST', '/api/agent/settings/profiles/codex/default', {})
    assert.equal(made.status, 200, JSON.stringify(made.json))
    assert.equal(made.json.confirm, undefined, 'a connected command was confirmed when it was connected')
    assert.equal(made.json.saved.acpCommand, 'codex-acp')
    assert.deepEqual(made.json.saved.profiles, profiles, 'the list is unchanged')
    assert.deepEqual(
      made.json.profiles.filter((item) => item.default).map((item) => item.id),
      ['codex'],
    )
    const picker = await b.api('GET', b.base + 'board')
    assert.equal(picker.json.profiles[0].sameAs, 'codex')
    assert.equal(picker.json.agent.label, 'Codex')
    assert.equal((await b.api('GET', b.base + 'comment-1')).json.agent.label, 'goose', 'a chat that chose an agent keeps it')
    assert.equal((await b.api('POST', '/api/agent/settings/profiles/nobody/default', {})).status, 404)
    assert.equal((await b.api('POST', '/api/agent/settings/profiles/endpoint/default', {})).json.error.code, 'no_endpoint')
    // The owner's capability, as every settings route.
    assert.equal((await b.api('POST', '/api/agent/settings/profiles/claude/default', {}, { 'X-Shapewall-Settings-Token': '' })).status, 404)
  },
)

test('profiles saved without a default connection: the first one is the default', { skip: !POSIX }, async (t) => {
  const b = await board(t, { saved: false })
  saveUserAgentEntry(b.config.dir, { profiles: [profiles[1], profiles[0]] }, b.env)
  const current = agentSettings(b.config, b.env)
  assert.equal(current.configured, true)
  assert.equal(current.label, 'Codex')
  assert.equal(current.defaultProfile, 'codex')
  const view = await b.api('GET', '/api/agent/settings')
  assert.deepEqual(
    view.json.profiles.map((item) => [item.id, item.default]),
    [
      ['codex', true],
      ['claude', false],
    ],
  )
  assert.equal((await b.api('GET', b.base + 'board')).json.profiles[0].sameAs, 'codex')
  // The config's own endpoint stays the default when nothing else is marked.
  const withEndpoint = { ...b.config, agent: { baseUrl: 'http://127.0.0.1:9/v1', model: 'local-model' } }
  assert.equal(agentSettings(withEndpoint, b.env).backend, 'openai-compatible')
  assert.equal(agentSettings(withEndpoint, b.env).defaultProfile, undefined)
  // Making one the default stores it as the default connection.
  const made = await b.api('POST', '/api/agent/settings/profiles/claude/default', {})
  assert.equal(made.json.saved.acpCommand, 'claude-agent-acp')
  assert.equal(made.json.saved.backend, 'acp')
})

test('agent states: a login failure shows on that agent only, with its sign-in hint; a test clears it', { skip: !POSIX }, async (t) => {
  const b = await board(t)
  assert.equal((await b.api('GET', '/api/agent/status')).json.state, 'ready')
  assert.equal((await b.select('board', 'codex')).status, 200)
  const reply = await finish(await b.send('board', 'loginsay'))
  assert.equal(reply.error?.code, 'agent_auth', JSON.stringify(reply))
  const thread = await b.api('GET', b.base + 'board')
  const states = Object.fromEntries(thread.json.profiles.map((item) => [item.id, item.state]))
  assert.deepEqual(states, { default: 'ready', claude: 'ready', codex: 'login', goose: 'ready' })
  assert.equal(thread.json.profiles.find((item) => item.id === 'codex').loginHint, 'run `codex login` in a terminal')
  assert.equal(thread.json.agent.state, 'login')
  const settings = await b.api('GET', '/api/agent/settings')
  assert.equal(settings.json.profiles.find((item) => item.id === 'codex').state, 'login')
  // Test connection for that agent: the handshake works, so it reads ready again.
  const tested = await b.api('POST', '/api/agent/settings/test', { profileId: 'codex' })
  assert.equal(tested.json.ok, true, JSON.stringify(tested.json))
  assert.equal((await b.api('GET', b.base + 'board')).json.agent.state, 'ready')
  assert.equal((await b.api('POST', '/api/agent/settings/test', { profileId: 'nobody' })).status, 400)
})

test('the saved endpoint (Other) can be the default, and a connected agent again after it', { skip: !POSIX }, async (t) => {
  const b = await board(t, { saved: false })
  saveUserAgentEntry(
    b.config.dir,
    { backend: 'acp', acpCommand: 'claude-agent-acp', baseUrl: 'http://127.0.0.1:9/v1', model: 'local-model', profiles: [profiles[1]] },
    b.env,
  )
  const before = await b.api('GET', '/api/agent/settings')
  assert.deepEqual(before.json.endpoint, {
    label: 'local-model',
    icon: null,
    tint: null,
    model: 'local-model',
    host: '127.0.0.1:9',
    default: false,
  })
  assert.deepEqual(
    before.json.profiles.map((item) => [item.id, item.legacy || false, item.default]),
    [
      ['claude', true, true],
      ['codex', false, false],
    ],
  )
  const endpoint = await b.api('POST', '/api/agent/settings/profiles/endpoint/default', {})
  assert.equal(endpoint.status, 200, JSON.stringify(endpoint.json))
  assert.equal(endpoint.json.saved.backend, 'openai-compatible')
  assert.equal(endpoint.json.endpoint.default, true)
  assert.equal(endpoint.json.endpoint.state, 'ready')
  assert.deepEqual(
    endpoint.json.saved.profiles.map((item) => item.id),
    ['claude', 'codex'],
    'the command saved before profiles stays in the list',
  )
  const back = await b.api('POST', '/api/agent/settings/profiles/claude/default', {})
  assert.equal(back.json.saved.backend, 'acp')
  assert.equal(back.json.saved.acpCommand, 'claude-agent-acp')
  assert.equal(back.json.endpoint.default, false)
})
