// What an agent is called and how it looks (src/agent/identity.js): the
// name's rules, where it is saved, who may change it, the uploaded icon's
// path, the product marks, and that none of it restarts an agent.
// ACP wire interactions run against the software stub only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createApp, stopChildren } from '../src/server/app.js'
import { loadConfig } from '../src/config.js'
import { agentSettings, publicAgentInfo } from '../src/agent/config.js'
import { KNOWN_AGENTS } from '../src/agent/acp/detect.js'
import { AGENT_LOGOS, agentLogo, logoForAgent } from '../src/agent/agent-logos.js'
import { AGENT_ICONS, AGENT_NAME_MAX, AGENT_TINTS, cleanAgentName, isAgentIcon, uploadHashes } from '../src/agent/identity.js'
import { iconDir, readIcon } from '../src/agent/icon-store.js'
import { saveUserAgentEntry, savedAgentName, userAgentEntry, userSettingsFile, validateUserEntry } from '../src/agent/user-settings.js'
import { addReply, createComment, getComment } from '../src/store.js'
import { agentRows } from '../client/src/settings/agentRows.js'
import { formFrom } from '../client/src/settings/agentForm.js'
import { pickerProfiles } from '../client/src/chat/profiles.js'
import { SAMPLE, sampleConfig, tempDir, request } from './helpers.js'
import { jpegWithExif, solidPng, webpWithExif } from './comment-media-fixtures.js'

const TOKEN = 'identity-fixture-capability'
const STUB = fileURLToPath(new URL('./fixtures/acp-stub.mjs', import.meta.url))
const OWNER_MCP = fileURLToPath(new URL('../src/agent/owner-mcp.js', import.meta.url))
const POSIX = process.platform !== 'win32'
const profiles = [
  { id: 'claude', label: 'Claude Code', acpCommand: 'claude-agent-acp' },
  { id: 'codex', label: 'Codex', acpCommand: 'codex-acp' },
]
const settings = '/api/agent/settings'
// What the board sends for an upload: a 256 by 256 RGBA PNG, in base64.
const icon256 = (color = [20, 120, 200, 255]) => solidPng(256, 256, color).toString('base64')

// `codex`: how codex-acp behaves. 'slow': its handshake takes 1.5 s, as a real
// agent's takes seconds (the stub's is instant). 'slow-fail': it exits after 1.5 s.
async function board(t, { saved = true, codex = null, config = sampleConfig('identity'), ...options } = {}) {
  const home = tempDir('identity-home')
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  for (const name of ['claude-agent-acp', 'codex-acp', 'gemini', 'mystery-acp']) {
    const body =
      name === 'codex-acp' && codex === 'slow-fail'
        ? '#!/bin/sh\nsleep 1.5\nexit 3\n'
        : `#!/bin/sh\nexec "${process.execPath}" "${STUB}" ${name === 'codex-acp' && codex === 'slow' ? '--slow-init=1500 ' : ''}"$@"\n`
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 })
  }
  const env = { HOME: home, XDG_CONFIG_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  if (saved) saveUserAgentEntry(config.dir, { backend: 'acp', acpCommand: profiles[0].acpCommand, profiles }, env)
  await createComment(config, config.boards[0], { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: 'Fixture' })
  const app = createApp({
    config,
    env,
    clientDir: tempDir('identity-client'),
    settingsToken: TOKEN,
    agentLimits: { runsMax: 2, burst: 100, perMinute: 100, acp: { idleMs: 30000 } },
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
  const send = (thread, text) =>
    fetch(`${origin}${base}${thread}/messages`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
  t.after(async () => {
    stopChildren(app)
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })
  return { app, port, origin, config, env, api, base, send, home }
}

async function finish(response) {
  assert.equal(response.status, 200)
  const text = await response.text()
  const done = text.split('\n\n').find((block) => block.startsWith('event: done\n'))
  assert.ok(done, text)
  return JSON.parse(/^data: (.*)$/m.exec(done)[1]).message
}

test('a name is one line of plain text, trimmed, 1 to 40 characters, without control or direction characters', () => {
  assert.deepEqual(cleanAgentName('  Harry  '), { name: 'Harry', problem: null })
  assert.deepEqual(cleanAgentName(''), { name: null, problem: null }, 'empty: the built-in name')
  assert.deepEqual(cleanAgentName('   '), { name: null, problem: null })
  assert.deepEqual(cleanAgentName(undefined), { name: null, problem: null })
  assert.equal(cleanAgentName('x'.repeat(AGENT_NAME_MAX)).name.length, 40)
  assert.match(cleanAgentName('x'.repeat(AGENT_NAME_MAX + 1)).problem, /at most 40/)
  // Counted as characters a person types: forty emoji are forty.
  assert.equal(cleanAgentName(String.fromCodePoint(0x1f916).repeat(40)).problem, null)
  for (const bad of [
    'Har\nry',
    'Har\try',
    'Har\0ry',
    `Har${String.fromCharCode(0x7f)}ry`,
    `Har${String.fromCharCode(0x202e)}ry`,
    `Har${String.fromCharCode(0x200b)}ry`,
    `Har${String.fromCharCode(0x2028)}ry`,
    `Har${String.fromCharCode(0x2066)}ry`,
  ])
    assert.match(cleanAgentName(bad).problem, /control/, JSON.stringify(bad))
  assert.match(cleanAgentName(42).problem, /text/)
  // Markup is kept as the text it is: the board never reads a name as HTML or Markdown.
  assert.equal(cleanAgentName('<b>**Fixer**</b>').name, '<b>**Fixer**</b>')
})

test('the saved entry takes an icon and a tint per agent, and refuses what is neither', () => {
  const ok = validateUserEntry({
    backend: 'acp',
    acpCommand: 'codex-acp',
    icon: 'ghost',
    tint: 'pink',
    fixedAgent: { label: 'Harry', icon: 'owl' },
    profiles: [{ id: 'codex', label: 'Fixer', acpCommand: 'codex-acp', icon: `upload:${'a'.repeat(32)}`, tint: 'green' }],
  })
  assert.deepEqual(ok.problems, [])
  assert.equal(ok.entry.profiles[0].icon, `upload:${'a'.repeat(32)}`)
  assert.deepEqual(ok.entry.fixedAgent, { label: 'Harry', icon: 'owl' })
  assert.deepEqual([...uploadHashes(ok.entry)], ['a'.repeat(32)])
  for (const bad of [
    { icon: 'https://example.com/x.svg' },
    { icon: '<svg onload=alert(1)>' },
    { icon: 'upload:../../etc/passwd' },
    { tint: '#ff0000' },
    { fixedAgent: { label: 'ok', command: 'rm -rf' } },
    { fixedAgent: { label: 'two\nlines' } },
    { profiles: [{ id: 'codex', label: 'Codex', acpCommand: 'codex-acp', icon: 'javascript:alert(1)' }] },
    { profiles: [{ id: 'codex', label: 'Codex', acpCommand: 'codex-acp', tint: 'url(x)' }] },
  ])
    assert.equal(validateUserEntry(bad).entry, null, JSON.stringify(bad))
  assert.equal(isAgentIcon('boxy'), true)
  assert.equal(isAgentIcon('upload:xyz'), false)
})

test('every built-in icon has a drawing, every tint a colour, and no drawing carries text or a link', () => {
  const source = fs.readFileSync(new URL('../client/src/chat/agentIcons.jsx', import.meta.url), 'utf8')
  assert.equal(AGENT_ICONS.length, 12)
  assert.equal(new Set(AGENT_ICONS).size, 12)
  for (const id of AGENT_ICONS)
    assert.match(source, new RegExp(`\\n  ${id}: \\{\\n    name: '[^']+',\\n    tint: '(${AGENT_TINTS.join('|')})'`), id)
  assert.equal(AGENT_TINTS.length, 8)
  for (const tint of AGENT_TINTS) assert.match(source, new RegExp(`\\n  ${tint}: '[A-Z][a-z]+'`), tint)
  const art = source.slice(source.indexOf('export const BUILT_IN_ICONS'), source.indexOf('export const ICON_IDS'))
  assert.doesNotMatch(art, /<text|<image|href|<script|url\(/)
})

test('product marks: every known agent has one (Codex the OpenAI mark), unknown agents do not; each records its source', () => {
  assert.equal(logoForAgent('claude'), 'claude')
  assert.equal(logoForAgent('gemini'), 'gemini')
  assert.equal(logoForAgent('codex'), 'openai', 'Codex shows the OpenAI mark')
  assert.equal(logoForAgent('goose'), 'goose')
  assert.equal(logoForAgent('my-own-agent'), null)
  assert.equal(logoForAgent('openai'), null, 'a mark id is not an agent id')
  assert.deepEqual(
    AGENT_LOGOS.map((logo) => logo.id),
    ['claude', 'openai', 'goose', 'gemini'],
  )
  assert.equal(agentLogo('nothing'), null)
  for (const logo of AGENT_LOGOS) {
    assert.match(logo.id, /^[a-z][a-z0-9-]*$/)
    assert.ok(logo.name && logo.owner, logo.id)
    // Where it came from, pinned: a Simple Icons release, or the project's own repository at a commit.
    assert.match(
      logo.source,
      /^(Simple Icons \d+\.\d+\.\d+ .*CC0 1\.0, icons\/[a-z]+\.svg|github\.com\/aaif-goose\/goose at [0-9a-f]{40}, [\w/.-]+\.svg \(Apache 2\.0; LF Projects trademark policy\))$/,
      logo.id,
    )
    assert.match(logo.viewBox, /^0 0 (24 24|45 45)$/)
    // One path of plain path data: nothing else can ride along.
    assert.match(logo.path, /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/, logo.id)
    for (const agent of logo.agents)
      assert.ok(
        KNOWN_AGENTS.some((known) => known.id === agent),
        agent,
      )
  }
  // The notices name every mark shipped.
  const thirdParty = fs.readFileSync(new URL('../THIRD_PARTY.md', import.meta.url), 'utf8')
  const notice = fs.readFileSync(new URL('../NOTICE', import.meta.url), 'utf8')
  for (const logo of AGENT_LOGOS) {
    assert.ok(thirdParty.includes(logo.name), `THIRD_PARTY.md names ${logo.name}`)
    assert.ok(notice.includes(logo.owner.replace(/,.*$/, '')), `NOTICE names ${logo.owner}`)
  }
})

test(
  'a known agent with no chosen icon reports its mark; a built-in or an upload overrides it; reset returns to it',
  { skip: !POSIX },
  async (t) => {
    const b = await board(t)
    const status = async () => (await b.api('GET', '/api/agent/status')).json
    let now = await status()
    assert.equal(now.logo, 'claude', 'the default connection runs Claude Code')
    assert.equal(now.icon, null)
    assert.deepEqual(
      now.profiles.map((item) => [item.id, item.logo, item.icon]),
      [
        ['default', 'claude', null],
        ['claude', 'claude', null],
        ['codex', 'openai', null],
      ],
    )
    const view = (await b.api('GET', settings)).json
    assert.deepEqual(
      view.known.map((item) => [item.id, item.logo]),
      [
        ['claude', 'claude'],
        ['codex', 'openai'],
        ['goose', 'goose'],
        ['gemini', 'gemini'],
      ],
    )
    assert.deepEqual(
      agentRows(view).map((row) => [row.id, row.logo]),
      [
        ['claude', 'claude'],
        ['codex', 'openai'],
        ['goose', 'goose'],
        ['gemini', 'gemini'],
      ],
    )
    // A built-in avatar wins over the mark.
    assert.equal((await b.api('POST', settings + '/identity', { id: 'claude', icon: 'owl' })).status, 200)
    now = await status()
    assert.deepEqual([now.icon, now.logo], ['owl', 'claude'])
    // So does an upload.
    const uploaded = await b.api('POST', settings + '/identity/icon', { id: 'claude', png: icon256() })
    assert.equal(uploaded.status, 200, uploaded.text)
    now = await status()
    assert.match(now.icon, /^upload:[0-9a-f]{32}$/)
    // Reset: no icon of its own, the mark again.
    assert.equal((await b.api('POST', settings + '/identity', { id: 'claude', icon: null })).status, 200)
    now = await status()
    assert.deepEqual([now.icon, now.logo], [null, 'claude'])
    // An agent Shapewall does not know has none, whatever it is called.
    saveUserAgentEntry(
      b.config.dir,
      { backend: 'acp', acpCommand: 'mystery-acp', profiles: [{ id: 'mystery', label: 'Claude Code', acpCommand: 'mystery-acp' }] },
      b.env,
    )
    now = await status()
    assert.deepEqual([now.label, now.logo], ['Claude Code', null])
    // An endpoint neither.
    assert.equal(publicAgentInfo(agentSettings({ agent: { baseUrl: 'http://127.0.0.1:9/v1', model: 'm' } }, {})).logo, null)
  },
)

test(
  'Connect takes a name, an icon and a tint; empty falls back to the built-in name; a bad name saves nothing',
  { skip: !POSIX },
  async (t) => {
    const b = await board(t, { saved: false })
    const first = await b.api('POST', settings + '/profiles/connect', { agentId: 'codex' })
    assert.equal(first.json.confirm[0].command, 'codex-acp')
    for (const name of ['x'.repeat(41), 'two\nlines', 7]) {
      const refused = await b.api('POST', settings + '/profiles/connect', { agentId: 'codex', confirm: first.json.confirmHash, name })
      assert.equal(refused.status, 400, JSON.stringify(name))
      assert.equal(refused.json.error.code, 'invalid_name')
    }
    const badIcon = await b.api('POST', settings + '/profiles/connect', {
      agentId: 'codex',
      confirm: first.json.confirmHash,
      icon: `upload:${'a'.repeat(32)}`,
    })
    assert.equal(badIcon.json.error.code, 'invalid_icon', 'an upload is never named from outside')
    assert.equal(userAgentEntry(b.config.dir, b.env).entry, null, 'nothing was saved')
    const connected = await b.api('POST', settings + '/profiles/connect', {
      agentId: 'codex',
      confirm: first.json.confirmHash,
      name: '  Harry ',
      icon: 'bear',
      tint: 'amber',
    })
    assert.equal(connected.json.connected, true, connected.text)
    assert.equal(connected.json.result.label, 'Harry')
    assert.deepEqual(connected.json.saved.profiles, [{ id: 'codex', label: 'Harry', acpCommand: 'codex-acp', icon: 'bear', tint: 'amber' }])
    const status = (await b.api('GET', '/api/agent/status')).json
    assert.deepEqual([status.label, status.icon, status.tint], ['Harry', 'bear', 'amber'])
    // Without a name: the built-in one.
    const claude = await b.api('POST', settings + '/profiles/connect', { agentId: 'claude' })
    const plain = await b.api('POST', settings + '/profiles/connect', { agentId: 'claude', confirm: claude.json.confirmHash, name: '' })
    assert.equal(plain.json.saved.profiles.find((item) => item.id === 'claude').label, 'Claude Code')
  },
)

test(
  'rename later: saved with the agent, shown everywhere a name is, and the running agent is not restarted',
  { skip: !POSIX },
  async (t) => {
    const b = await board(t)
    const pidOf = async () => /pid (\d+)/.exec((await finish(await b.send('board', 'pid'))).text)[1]
    const pid = await pidOf()
    const renamed = await b.api('POST', settings + '/identity', { id: 'claude', name: 'Harry', icon: 'cat', tint: 'violet' })
    assert.equal(renamed.status, 200, renamed.text)
    assert.equal(renamed.json.confirm, undefined, 'display only: nothing to confirm')
    assert.deepEqual(renamed.json.saved.profiles[0], {
      id: 'claude',
      label: 'Harry',
      acpCommand: 'claude-agent-acp',
      icon: 'cat',
      tint: 'violet',
    })
    assert.equal(renamed.json.saved.acpCommand, 'claude-agent-acp', 'the command is untouched')
    assert.equal(await pidOf(), pid, 'the same agent process answers after the rename')
    // The read-only agent info every viewer gets (no settings token here).
    const viewer = await request(b.port, 'GET', '/api/agent/status')
    assert.deepEqual([viewer.json.label, viewer.json.icon, viewer.json.tint, viewer.json.logo], ['Harry', 'cat', 'violet', 'claude'])
    assert.deepEqual(Object.keys(viewer.json).sort(), [
      'backend',
      'chatNeedsOwner',
      'configured',
      'docsUrl',
      'fixWithAgent',
      'host',
      'icon',
      'label',
      'local',
      'loginHint',
      'logo',
      'model',
      'ownerWrites',
      'problem',
      'profiles',
      'sendsKey',
      'state',
      'tint',
      'vision',
    ])
    assert.equal((await request(b.port, 'GET', '/api/info')).json.agent.label, 'Harry')
    const thread = (await b.api('GET', b.base + 'board')).json
    assert.equal(thread.agent.label, 'Harry')
    // The picker (chat header, Fix with ...) and the settings form follow.
    assert.deepEqual(
      pickerProfiles(thread).options.map((option) => [option.id, option.label, option.icon, option.tint, option.logo]),
      [
        ['claude', 'Harry', 'cat', 'violet', 'claude'],
        ['codex', 'Codex', null, null, 'openai'],
      ],
    )
    assert.equal(formFrom(renamed.json).label, 'Harry')
    // An emptied name goes back to the built-in one; the icon stays.
    const emptied = await b.api('POST', settings + '/identity', { id: 'claude', name: '' })
    assert.deepEqual(emptied.json.saved.profiles[0], {
      id: 'claude',
      label: 'Claude Code',
      acpCommand: 'claude-agent-acp',
      icon: 'cat',
      tint: 'violet',
    })
    // The full form's name field names the same agent.
    const form = await b.api('POST', settings, { settings: { backend: 'acp', acpCommand: 'claude-agent-acp', label: 'Fixer' } })
    assert.equal(form.status, 200, form.text)
    assert.equal(form.json.saved.profiles[0].label, 'Fixer')
    assert.equal(form.json.saved.profiles[0].icon, 'cat', 'the form keeps the icon')
    assert.equal((await b.api('GET', '/api/agent/status')).json.label, 'Fixer')
  },
)

test('rename while the agent is mid-answer: saved at once, the answer goes on', { skip: !POSIX }, async (t) => {
  const b = await board(t)
  const slow = await b.send('board', 'slowly')
  const reader = slow.body.getReader()
  await reader.read()
  assert.equal((await b.api('GET', b.base + 'board')).json.running, true)
  // Other settings writes wait for the answer; the name does not.
  assert.equal((await b.api('DELETE', settings + '/profiles/codex')).status, 409)
  const renamed = await b.api('POST', settings + '/identity', { id: 'claude', name: 'Mid Answer' })
  assert.equal(renamed.status, 200, renamed.text)
  const during = (await b.api('GET', b.base + 'board')).json
  assert.equal(during.running, true, 'the turn was not stopped')
  assert.equal(during.agent.label, 'Mid Answer')
  await b.api('POST', b.base + 'board/stop', {})
  await reader.cancel()
})

test('who may change it: the owner on this machine only; a flag or environment command does not block it', { skip: !POSIX }, async (t) => {
  const b = await board(t)
  const body = { id: 'claude', name: 'Mallory' }
  // No settings token: the routes are not there at all.
  for (const route of ['/identity', '/identity/icon'])
    assert.equal((await request(b.port, 'POST', settings + route, { body, headers: { Origin: b.origin } })).status, 404, route)
  // The token from another site, through a proxy, or under another Host: refused.
  for (const extra of [{ Origin: 'https://evil.example.test' }, { Via: 'proxy' }, { 'X-Forwarded-For': '10.0.0.1' }])
    assert.equal((await b.api('POST', settings + '/identity', body, extra)).status, 403, JSON.stringify(extra))
  assert.equal(userAgentEntry(b.config.dir, b.env).entry.profiles[0].label, 'Claude Code')
  // A shared board: no settings writes from the board.
  const shared = await board(t, { shared: true })
  assert.equal((await shared.api('POST', settings + '/identity', body)).status, 403)
  // Unknown agents, icons and tints.
  assert.equal((await b.api('POST', settings + '/identity', { id: 'nobody', name: 'x' })).status, 404)
  assert.equal((await b.api('POST', settings + '/identity', { name: 'x' })).status, 400)
  assert.equal((await b.api('POST', settings + '/identity', { id: 'claude', icon: 'nope' })).json.error.code, 'invalid_icon')
  assert.equal(
    (await b.api('POST', settings + '/identity', { id: 'claude', icon: `upload:${'b'.repeat(32)}` })).json.error.code,
    'invalid_icon',
  )
  assert.equal(
    (await b.api('POST', settings + '/identity', { id: 'claude', tint: 'red; background:url(x)' })).json.error.code,
    'invalid_tint',
  )
  assert.equal((await b.api('POST', settings + '/identity', { id: 'claude', name: 'x'.repeat(41) })).json.error.code, 'invalid_name')

  // --agent-acp fixes the command. Connect and the default are refused, as before...
  const fixed = await board(t, { agentAcp: 'codex-acp' })
  assert.equal((await fixed.api('POST', settings + '/profiles/connect', { agentId: 'codex' })).json.error.code, 'acp_overridden')
  assert.equal((await fixed.api('POST', settings + '/profiles/codex/default', {})).json.error.code, 'acp_overridden')
  // ...the name and the icon are display only, and are not.
  const named = await fixed.api('POST', settings + '/identity', { id: 'default', name: 'Harry', icon: 'cloud', tint: 'green' })
  assert.equal(named.status, 200, named.text)
  assert.deepEqual(named.json.saved.fixedAgent, { label: 'Harry', icon: 'cloud', tint: 'green' })
  assert.deepEqual(named.json.saved.profiles, profiles, 'the saved agents are untouched')
  assert.equal(named.json.env.acp, 'flag')
  assert.deepEqual([named.json.effective.label, named.json.effective.builtInLabel, named.json.effective.icon], ['Harry', 'Codex', 'cloud'])
  const status = (await fixed.api('GET', '/api/agent/status')).json
  assert.deepEqual([status.label, status.icon, status.tint], ['Harry', 'cloud', 'green'])
  assert.match((await finish(await fixed.send('board', 'pid'))).text, /pid \d+/, 'the fixed command still answers')
  // An emptied name: the command's own again.
  const back = await fixed.api('POST', settings + '/identity', { id: 'default', name: '' })
  assert.equal(back.json.effective.label, 'Codex')
  // The same through the environment.
  const config = sampleConfig('identity-env')
  const viaEnv = agentSettings(config, { SHAPEWALL_AGENT_ACP: STUB, HOME: fixed.home, XDG_CONFIG_HOME: fixed.home })
  assert.equal(viaEnv.sources.acpCommand, 'env')
})

test('the endpoint (Other) takes a name, an icon and a tint too, and the form keeps them', { skip: !POSIX }, async (t) => {
  const b = await board(t, { saved: false })
  saveUserAgentEntry(b.config.dir, { backend: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'local-model' }, b.env)
  assert.equal((await b.api('POST', settings + '/identity', { id: 'claude', name: 'x' })).status, 404)
  const named = await b.api('POST', settings + '/identity', { id: 'endpoint', name: 'Local', icon: 'planet', tint: 'cyan' })
  assert.equal(named.status, 200, named.text)
  assert.deepEqual(named.json.endpoint, {
    label: 'Local',
    icon: 'planet',
    tint: 'cyan',
    model: 'local-model',
    host: '127.0.0.1:9',
    default: true,
    state: 'ready',
  })
  const status = (await b.api('GET', '/api/agent/status')).json
  assert.deepEqual([status.label, status.icon, status.tint, status.logo], ['Local', 'planet', 'cyan', null])
  // "default" is the endpoint here.
  assert.equal((await b.api('POST', settings + '/identity', { id: 'default', tint: 'pink' })).json.endpoint.tint, 'pink')
  const form = await b.api('POST', settings, {
    settings: { backend: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'other-model', label: 'Local' },
  })
  assert.deepEqual([form.json.saved.icon, form.json.saved.tint, form.json.saved.label], ['planet', 'pink', 'Local'])
  // Emptied: the model's name.
  assert.equal((await b.api('POST', settings + '/identity', { id: 'endpoint', name: '' })).json.endpoint.label, 'other-model')
})

test('a default command saved before profiles becomes a profile when it is renamed', { skip: !POSIX }, async (t) => {
  const b = await board(t, { saved: false })
  saveUserAgentEntry(b.config.dir, { backend: 'acp', acpCommand: 'claude-agent-acp' }, b.env)
  const renamed = await b.api('POST', settings + '/identity', { id: 'claude', name: 'Old Faithful' })
  assert.equal(renamed.status, 200, renamed.text)
  assert.deepEqual(renamed.json.saved.profiles, [{ id: 'claude', label: 'Old Faithful', acpCommand: 'claude-agent-acp' }])
  assert.equal(renamed.json.saved.acpCommand, 'claude-agent-acp')
  assert.equal((await b.api('GET', '/api/agent/status')).json.label, 'Old Faithful')
})

test(
  'an uploaded icon: only a square PNG from the board, re-encoded, stored privately, served as an image only',
  { skip: !POSIX },
  async (t) => {
    const b = await board(t)
    const upload = (png, id = 'claude') => b.api('POST', settings + '/identity/icon', { id, png })
    // Not an image the board would send.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>')
    for (const [what, bytes] of [
      ['an SVG', svg],
      ['a JPEG', jpegWithExif()],
      ['a WebP', webpWithExif()],
      ['a PNG of another size', solidPng(64, 64)],
      ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>')],
      ['a PNG with data after its end', Buffer.concat([solidPng(256, 256), Buffer.from('<script>alert(1)</script>')])],
    ]) {
      const refused = await upload(bytes.toString('base64'))
      assert.equal(refused.status, 400, what)
      assert.equal(refused.json.error.code, 'invalid_icon', what)
    }
    assert.equal((await upload('not base64!')).status, 400)
    assert.equal((await upload(undefined)).status, 400)
    // Too large: over the 512 KiB an icon may be, and over the body the route reads at all.
    assert.equal((await upload(Buffer.alloc(513 * 1024, 1).toString('base64'))).status, 400)
    assert.equal((await upload(Buffer.alloc(800 * 1024, 1).toString('base64'))).status, 413)
    // Without the owner's token even a small upload is over the limit of the route everyone reaches.
    const outsider = await request(b.port, 'POST', settings + '/identity/icon', {
      body: { id: 'claude', png: icon256() },
      headers: { Origin: b.origin },
    })
    assert.ok([404, 413].includes(outsider.status), String(outsider.status))
    assert.equal((await upload(icon256(), 'nobody')).status, 404)
    assert.equal(fs.existsSync(iconDir(b.env)) ? fs.readdirSync(iconDir(b.env)).length : 0, 0, 'nothing refused was stored')

    // A real one, with a text chunk the server must drop.
    const pixels = solidPng(256, 256, [200, 40, 40, 255])
    const crcTable = Array.from({ length: 256 }, (_, n) => {
      let value = n
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      return value >>> 0
    })
    const chunk = (type, data) => {
      const body = Buffer.concat([Buffer.from(type), data])
      let crc = 0xffffffff
      for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
      const out = Buffer.alloc(body.length + 8)
      out.writeUInt32BE(data.length, 0)
      body.copy(out, 4)
      out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4)
      return out
    }
    const tagged = Buffer.concat([
      pixels.subarray(0, 33),
      chunk('tEXt', Buffer.from('Comment\0private fictional metadata')),
      pixels.subarray(33),
    ])
    const saved = await upload(tagged.toString('base64'))
    assert.equal(saved.status, 200, saved.text)
    const icon = saved.json.saved.profiles[0].icon
    const hash = /^upload:([0-9a-f]{32})$/.exec(icon)[1]
    const stored = readIcon(hash, b.env)
    assert.ok(!stored.includes('private fictional metadata'), 'the metadata is gone')
    assert.deepEqual(PNG.sync.read(stored).data, PNG.sync.read(pixels).data, 'the pixels are kept')
    if (POSIX) {
      assert.equal(fs.statSync(iconDir(b.env)).mode & 0o777, 0o700)
      assert.equal(fs.statSync(path.join(iconDir(b.env), `${hash}.png`)).mode & 0o777, 0o600)
      assert.equal(path.dirname(iconDir(b.env)), path.dirname(userSettingsFile(b.env)), 'next to the agent settings')
    }
    // Served to every viewer of the board, as a PNG and nothing else.
    const served = await fetch(`${b.origin}/api/agent/icons/${hash}`)
    assert.equal(served.status, 200)
    assert.equal(served.headers.get('content-type'), 'image/png')
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff')
    assert.match(served.headers.get('cache-control'), /private, max-age=31536000, immutable/)
    assert.match(served.headers.get('content-security-policy'), /default-src 'none'/)
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), stored)
    // Only this project's icons, only by hash.
    for (const name of ['a'.repeat(32), '..%2f..%2fagents.json', `${hash}.png`, 'x'])
      assert.equal((await fetch(`${b.origin}/api/agent/icons/${name}`)).status, 404, name)
    // The same picture for a second agent is one file; replacing and removing prune it.
    await upload(tagged.toString('base64'), 'codex')
    assert.equal(fs.readdirSync(iconDir(b.env)).length, 1)
    await b.api('POST', settings + '/identity', { id: 'claude', icon: 'ghost' })
    assert.equal(fs.readdirSync(iconDir(b.env)).length, 1, 'Codex still uses it')
    await b.api('POST', settings + '/identity', { id: 'codex', icon: null })
    assert.equal(fs.readdirSync(iconDir(b.env)).length, 0, 'nobody uses it: removed')
    assert.equal((await fetch(`${b.origin}/api/agent/icons/${hash}`)).status, 404)
  },
)

test('replies: a reply marked as the agent keeps its name; the owner MCP server signs with the name the agent has now', async (t) => {
  const dir = tempDir('identity-mcp')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(SAMPLE))
  const config = loadConfig(file)
  const home = tempDir('identity-mcp-home')
  const settingsFile = path.join(home, 'agents.json')
  const env = { SHAPEWALL_AGENT_SETTINGS_FILE: settingsFile }
  saveUserAgentEntry(
    config.dir,
    { backend: 'acp', acpCommand: 'codex-acp', profiles: [{ id: 'codex', label: 'Harry', acpCommand: 'codex-acp' }] },
    env,
  )
  const comment = await createComment(config, config.boards[0], { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: 'Fixture' })
  assert.equal(savedAgentName(config.dir, 'codex', env), 'Harry')
  assert.equal(savedAgentName(config.dir, 'default', env), 'Harry')
  assert.equal(savedAgentName(config.dir, 'fixed', env), null)
  assert.equal(savedAgentName(config.dir, 'gone', env), null)

  // The flag is set only by the server's own tools; a request body's author is a person's.
  const plain = await addReply(config, 'sample', comment.id, { body: 'A person', author: 'Harry' })
  assert.equal(plain.reply.agent, undefined)

  const client = new Client({ name: 'shapewall-test', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [OWNER_MCP, file, 'sample', 'no-capture', 'codex', 'Name at start'],
      env: { ...process.env, ...env },
      stderr: 'pipe',
    }),
  )
  t.after(() => client.close())
  const reply = (body) => client.callTool({ name: 'reply_to_comment', arguments: { id: comment.id, body } })
  await reply('First')
  // Renamed while the session runs: the next reply carries the new name.
  saveUserAgentEntry(
    config.dir,
    { backend: 'acp', acpCommand: 'codex-acp', profiles: [{ id: 'codex', label: 'Fixer', acpCommand: 'codex-acp' }] },
    env,
  )
  await reply('Second')
  // The agent removed from the settings: the name it started with.
  saveUserAgentEntry(config.dir, {}, env)
  await reply('Third')
  const replies = getComment(config, 'sample', comment.id).replies
  assert.deepEqual(
    replies.map((item) => [item.author, item.agent || false, item.body]),
    [
      ['Harry', false, 'A person'],
      ['Harry', true, 'First'],
      ['Fixer', true, 'Second'],
      ['Name at start', true, 'Third'],
    ],
    'earlier replies keep the name they were written with',
  )
})

test('the OpenAI and goose marks are the published files, unchanged, and the notices say where each came from', () => {
  const openai = agentLogo('openai')
  assert.deepEqual(openai.agents, ['codex'])
  assert.match(openai.source, /^Simple Icons 15\.22\.0 /, 'the last release that has the icon')
  // The blossom's outline starts and ends where the published path does.
  assert.ok(openai.path.startsWith('M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108'))
  assert.ok(openai.path.endsWith('v2.9994l-2.5974 1.4997-2.6067-1.4997Z'))
  assert.equal(openai.path.length, 1460)
  assert.equal(agentLogo('goose').path.length, 4754)
  const goose = agentLogo('goose')
  assert.deepEqual(goose.agents, ['goose'])
  assert.ok(goose.path.startsWith('M43.2098 39.2492L39.8118 36.4522C37.9646 34.9318'))
  assert.ok(goose.path.endsWith('43.2132 39.2517L43.2098 39.2492Z'))
  const thirdParty = fs.readFileSync(new URL('../THIRD_PARTY.md', import.meta.url), 'utf8')
  // The OpenAI icon's removal from Simple Icons is said, not hidden.
  assert.match(thirdParty, /simple-icons@15\.22\.0/)
  assert.match(thirdParty, /removed\*\* the icon in 16\.0\.0/)
  assert.match(thirdParty, /https:\/\/openai\.com\/brand/)
  assert.match(thirdParty, /aaif-goose\/goose/)
  assert.ok(thirdParty.includes(goose.source.match(/[0-9a-f]{40}/)[0]), 'the commit the goose mark was taken at')
  assert.match(thirdParty, /lfprojects\.org\/policies\/trademark-policy/)
})

// ---- A name or an icon saved while a Connect is still testing ----
//
// With a real agent the handshake of a one-click Connect takes seconds, and
// the page already lists the agent. Nothing a person does in that window may
// answer "a connection test is running" for a rename.

// Connect Codex and return while its test runs: { done, hash }.
async function connecting(b, extra = {}) {
  const first = await b.api('POST', settings + '/profiles/connect', { agentId: 'codex' })
  const done = b.api('POST', settings + '/profiles/connect', { agentId: 'codex', confirm: first.json.confirmHash, ...extra })
  for (let tries = 0; tries < 100; tries += 1) {
    if ((await b.api('GET', settings)).json.testing) return { done }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('the connection test never started')
}
const onlyClaude = { backend: 'acp', acpCommand: 'claude-agent-acp', profiles: [profiles[0]] }

test('rename during a Connect whose test then succeeds: the save waits for the test and is kept', { skip: !POSIX }, async (t) => {
  const b = await board(t, { saved: false, codex: 'slow' })
  saveUserAgentEntry(b.config.dir, onlyClaude, b.env)
  const { done } = await connecting(b, { name: 'Harry' })
  // While it runs the page says so: on the Agents page and in the agent info of the board.
  const during = (await b.api('GET', settings)).json
  assert.deepEqual(during.testing, { id: 'codex' })
  assert.deepEqual(
    during.profiles.map((item) => [item.id, item.label, item.state]),
    [
      ['claude', 'Claude Code', 'ready'],
      ['codex', 'Harry', 'testing'],
    ],
  )
  const status = (await b.api('GET', '/api/agent/status')).json
  assert.equal(status.profiles.find((item) => item.id === 'codex').state, 'testing')
  assert.equal(status.profiles.find((item) => item.id === 'claude').state, 'ready')
  // The other changes of the page still wait for it (the board disables them meanwhile).
  assert.equal((await b.api('DELETE', settings + '/profiles/claude')).json.error.code, 'test_running')
  assert.equal((await b.api('POST', settings + '/profiles/claude/default', {})).json.error.code, 'test_running')
  assert.equal((await b.api('POST', settings + '/test', { profileId: 'claude' })).json.error.code, 'test_running')

  // A name for another agent: saved at once.
  const started = Date.now()
  const other = await b.api('POST', settings + '/identity', { id: 'claude', name: 'Old Hand', icon: 'bear' })
  assert.equal(other.status, 200, other.text)
  assert.ok(Date.now() - started < 1000, 'it did not wait for the test')
  assert.equal(other.json.testing.id, 'codex', 'and the test is still running')

  // A name and a picture for the agent being connected: both wait, neither is refused.
  let answered = false
  const rename = b.api('POST', settings + '/identity', { id: 'codex', name: 'Fixer', icon: 'owl' }).then((answer) => {
    answered = true
    return answer
  })
  const picture = b.api('POST', settings + '/identity/icon', { id: 'codex', png: icon256() })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(answered, false, 'the save waits for the test')
  assert.equal(fs.existsSync(iconDir(b.env)), false, 'no picture is stored before the agent is there')

  const connected = await done
  assert.equal(connected.json.connected, true, connected.text)
  assert.equal(connected.json.testing, null, 'the answer shows the agent as it is, not "testing"')
  assert.equal(connected.json.profiles.find((item) => item.id === 'codex').state, 'ready')
  const [renamed, uploaded] = await Promise.all([rename, picture])
  assert.equal(renamed.status, 200, renamed.text)
  assert.equal(uploaded.status, 200, uploaded.text)
  const saved = userAgentEntry(b.config.dir, b.env).entry
  assert.deepEqual(saved.profiles[0], { id: 'claude', label: 'Old Hand', acpCommand: 'claude-agent-acp', icon: 'bear' })
  assert.equal(saved.profiles[1].label, 'Fixer')
  assert.match(saved.profiles[1].icon, /^(owl|upload:[0-9a-f]{32})$/, 'the name and an icon, whichever of the two icon saves came last')
  assert.equal((await b.api('GET', settings)).json.testing, null)
  assert.equal((await b.api('GET', '/api/agent/status')).json.profiles.find((item) => item.id === 'codex').label, 'Fixer')
  // The connected agent answers under its new name.
  assert.match((await finish(await b.send('board', 'pid'))).text, /pid \d+/)
})

test(
  'rename during a Connect whose test then fails: the settings go back, nothing is orphaned, and the save says why',
  { skip: !POSIX },
  async (t) => {
    const b = await board(t, { saved: false, codex: 'slow-fail' })
    saveUserAgentEntry(b.config.dir, onlyClaude, b.env)
    const { done } = await connecting(b)
    // Another agent's name and picture, saved meanwhile: kept when the old settings are written back.
    assert.equal((await b.api('POST', settings + '/identity', { id: 'claude', name: 'Old Hand' })).status, 200)
    const kept = await b.api('POST', settings + '/identity/icon', { id: 'claude', png: icon256([10, 200, 90, 255]) })
    assert.equal(kept.status, 200, kept.text)
    // For the agent that will not connect: the saves wait, then say so in words.
    const rename = b.api('POST', settings + '/identity', { id: 'codex', name: 'Fixer', icon: 'owl' })
    const picture = b.api('POST', settings + '/identity/icon', { id: 'codex', png: icon256() })
    const failed = await done
    assert.equal(failed.json.connected, false)
    assert.equal(failed.json.testing, null)
    for (const answer of await Promise.all([rename, picture])) {
      assert.equal(answer.status, 409)
      assert.equal(answer.json.error.code, 'agent_not_connected')
      assert.match(answer.json.error.message, /^Codex did not connect, so .* Nothing was changed\.$/)
      assert.doesNotMatch(answer.json.error.message, /connection test is running/)
    }
    const saved = userAgentEntry(b.config.dir, b.env).entry
    assert.equal(saved.acpCommand, 'claude-agent-acp')
    assert.equal(saved.profiles.length, 1, 'Codex is not there')
    assert.equal(saved.profiles[0].label, 'Old Hand')
    assert.match(saved.profiles[0].icon, /^upload:[0-9a-f]{32}$/)
    assert.equal(saved.fixedAgent, undefined)
    assert.equal(JSON.stringify(saved).includes('Fixer'), false, 'no name left for an agent that is not there')
    // One picture on disk: the kept one. The one for Codex was never stored.
    assert.deepEqual(fs.readdirSync(iconDir(b.env)), [`${saved.profiles[0].icon.slice(7)}.png`])
  },
)

test('Test connection does not hold up a rename: it changes no settings', { skip: !POSIX }, async (t) => {
  const b = await board(t, { codex: 'slow' })
  const tested = b.api('POST', settings + '/test', { profileId: 'codex' })
  for (let tries = 0; tries < 100 && !(await b.api('GET', settings)).json.testing; tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
  const started = Date.now()
  const renamed = await b.api('POST', settings + '/identity', { id: 'codex', name: 'Fixer' })
  assert.equal(renamed.status, 200, renamed.text)
  assert.ok(Date.now() - started < 1000)
  assert.equal(renamed.json.profiles.find((item) => item.id === 'codex').state, 'testing')
  assert.equal((await tested).json.ok, true)
  assert.equal(userAgentEntry(b.config.dir, b.env).entry.profiles[1].label, 'Fixer')
})

test('the board waits longer for a connection test than the test can last', async () => {
  const { ACP_TEST_TIMEOUT_MS, TEST_WAIT_MS } = await import('../src/agent/test-timing.js')
  assert.ok(TEST_WAIT_MS >= ACP_TEST_TIMEOUT_MS + 10000)
  const stream = fs.readFileSync(new URL('../client/src/chat/stream.js', import.meta.url), 'utf8')
  assert.match(stream, /TEST_WAIT_TRIES = Math\.ceil\(TEST_WAIT_MS \/ TEST_RETRY_MS\)/)
  assert.match(
    fs.readFileSync(new URL('../src/agent/settings-routes.js', import.meta.url), 'utf8'),
    /import \{ ACP_TEST_TIMEOUT_MS \} from '\.\/test-timing\.js'/,
  )
})
