// Extensions in a real ACP session (src/agent/backends/acp.js), against the
// stub agent named as Claude Code: a trusted turn's session gets the skills
// plugin and the extension servers; a turn without them never reuses that
// session; an extension tool is allowed by exact name only; and a board tool
// whose result is other people's text, mid-turn, refuses every extension
// tool for the rest of the turn and ends the session with it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBackend } from '../src/agent/backends/index.js'
import { extensionSession } from '../src/agent/agent-config-folder.js'
import { tempDir } from './helpers.js'

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-stub.mjs')

function claudeBin() {
  const bin = tempDir('ext-acp-bin')
  const file = path.join(bin, 'claude-agent-acp')
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" --ro-modes "$@"\n`, { mode: 0o755 })
  return file
}
const FOUND = {
  dir: '/x',
  skills: [{ name: 'notes', description: null, root: '/x/skills/notes', files: [] }],
  servers: [{ name: 'brain', command: '/usr/bin/brain-mcp', args: ['--stdio'], env: {} }],
  skipped: [],
}
const EXT = extensionSession(FOUND, '/state/agent-ext/k/plugin', ['mcp__brain__search'], { env: { PATH: '/bin', HOME: '/home/x' } })

function backendOn(argv, settings = {}) {
  return createBackend(
    { configured: true, backend: 'acp', label: 'Claude Code', vision: false, acp: { argv }, readOnly: true, ...settings },
    { env: { PATH: process.env.PATH, HOME: os.homedir() }, root: tempDir('ext-acp-root'), log: () => {} },
  )
}
async function turn(backend, prompt, { thread = 'sample/chat-aaaaaaaaaaaaaaaa', extensions = null } = {}) {
  let text = ''
  const events = []
  for await (const event of backend.stream({
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    signal: new AbortController().signal,
    thread,
    ...(extensions ? { extensions } : {}),
  })) {
    events.push(event)
    if (event.type === 'text') text += event.text
  }
  return { text, events }
}

test(
  'a turn with extensions gets the plugin, the Skill tool and the servers; a turn without them gets a session of its own',
  { skip: process.platform === 'win32' },
  async () => {
    const backend = backendOn([claudeBin()])
    try {
      const sent = JSON.parse((await turn(backend, 'newparams', { extensions: EXT })).text)
      const options = sent._meta.claudeCode.options
      assert.deepEqual(options.plugins, [{ type: 'local', path: '/state/agent-ext/k/plugin' }])
      assert.deepEqual(options.skills, ['notes'])
      assert.ok(options.tools.includes('Skill'))
      assert.deepEqual(options.settingSources, [])
      assert.equal(options.strictMcpConfig, true)
      assert.ok(!(options.allowedTools || []).some((tool) => tool.startsWith('mcp__brain')))
      const brain = sent.mcpServers.find((server) => server.name === 'brain')
      assert.deepEqual(brain.args, ['--stdio'])
      const first = (await turn(backend, 'pid', { extensions: EXT })).text
      // The same thread without extensions: a fresh session, with none of them.
      const plain = (await turn(backend, 'pid')).text
      assert.notEqual(plain, first, 'never the session that had extensions')
      const bare = JSON.parse((await turn(backend, 'newparams')).text)
      assert.ok(!('plugins' in bare._meta.claudeCode.options))
      assert.ok(!bare._meta.claudeCode.options.tools.includes('Skill'))
      assert.ok(!bare.mcpServers.some((server) => server.name === 'brain'))
    } finally {
      backend.close()
    }
  },
)

test(
  "an extension tool is allowed by its exact name only, and never once a board tool brought other people's text in",
  { skip: process.platform === 'win32' },
  async () => {
    const backend = backendOn([claudeBin()])
    try {
      assert.match((await turn(backend, 'extcall mcp__brain__search', { extensions: EXT })).text, /extcall mcp__brain__search: allow/)
      const other = await turn(backend, 'extcall mcp__brain__delete_all', { extensions: EXT })
      assert.match(other.text, /extcall mcp__brain__delete_all: reject/)
      const before = (await turn(backend, 'pid', { extensions: EXT })).text
      // Mid-turn: list_comments' result comes first, then the allowed tool is asked for.
      const tainted = await turn(backend, 'extcall mcp__brain__search mcp__shapewall__list_comments', { extensions: EXT })
      assert.match(tainted.text, /extcall mcp__brain__search: reject/)
      assert.equal(tainted.events.filter((event) => event.type === 'taint').length, 1)
      // ...and the session ended with the turn: the next one starts afresh.
      const after = (await turn(backend, 'pid', { extensions: EXT })).text
      assert.notEqual(after, before)
    } finally {
      backend.close()
    }
  },
)

test('an agent that is not Claude Code never gets extensions', { skip: process.platform === 'win32' }, async () => {
  const backend = backendOn([process.execPath, STUB, '--ro-modes'])
  try {
    const sent = JSON.parse((await turn(backend, 'newparams', { extensions: EXT })).text)
    assert.ok(!(sent.mcpServers || []).some((server) => server.name === 'brain'))
    assert.ok(!JSON.stringify(sent).includes('agent-ext'))
    // Its permission requests go the usual way: read only refuses them.
    assert.match((await turn(backend, 'extcall mcp__brain__search', { extensions: EXT })).text, /reject|cancelled/)
  } finally {
    backend.close()
  }
})
