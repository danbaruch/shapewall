// Extensions on a local board, through its real chat route (src/agent/routes.js)
// and the stub agent named as Claude Code: the owner's own chat gets the
// agent config folder's skills and servers; a thread that mentions someone
// else's comment, that comment's own thread (an open turn) and a chat a
// board tool tainted mid-turn never do.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, stopChildren } from '../src/server/app.js'
import { normalizeConfig } from '../src/config.js'
import { saveUserAgentEntry } from '../src/agent/user-settings.js'
import { readThread } from '../src/agent/threads.js'
import { createComment } from '../src/store.js'
import { SAMPLE, tempDir } from './helpers.js'

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-stub.mjs')
const TOKEN = 'ext-local-settings-token'
const open = []
after(() => {
  for (const close of open) close()
})

function privateDir(name) {
  const dir = tempDir(name)
  fs.chmodSync(dir, 0o700)
  return dir
}

async function board() {
  const dir = privateDir('ext-local-project')
  const config = normalizeConfig(structuredClone(SAMPLE), { dir, file: path.join(dir, 'shapewall.config.json') })
  const home = privateDir('ext-local-home')
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state') }
  const folder = privateDir('ext-local-folder')
  fs.mkdirSync(path.join(folder, 'skills', 'notes'), { recursive: true })
  fs.writeFileSync(path.join(folder, 'skills', 'notes', 'SKILL.md'), '---\ndescription: Notes\n---\n')
  fs.writeFileSync(path.join(folder, '.claude.json'), JSON.stringify({ mcpServers: { brain: { command: '/usr/bin/brain-mcp' } } }))
  saveUserAgentEntry(config.dir, { agentConfig: folder, capabilities: { allowTool: ['mcp__brain__search'] } }, env)
  const bin = privateDir('ext-local-bin')
  const acp = path.join(bin, 'claude-agent-acp')
  fs.writeFileSync(acp, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" --ro-modes "$@"\n`, { mode: 0o755 })
  const other = await createComment(config, config.boards[0], { pageId: 'home', viewport: 'desktop', x: 5, y: 5, body: 'Someone else' })
  const app = createApp({
    config,
    clientDir: tempDir('ext-local-client'),
    env,
    settingsToken: TOKEN,
    agentAcp: acp,
    agentLimits: { burst: 1000, perMinute: 1000 },
  })
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  open.push(() => {
    stopChildren(app)
    server.close()
  })
  return { config, port: server.address().port, other }
}

async function send(entry, threadId, body) {
  const response = await fetch(`http://127.0.0.1:${entry.port}/api/agent/boards/sample/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${entry.port}`, 'X-Shapewall-Settings-Token': TOKEN },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const done = text
    .split('\n\n')
    .filter((block) => /^event: done$/m.test(block))
    .map((block) => JSON.parse(/^data: (.*)$/m.exec(block)[1]))[0]
  assert.ok(done, `${response.status} ${text.slice(0, 300)}`)
  return done.message
}
const sessionOf = async (entry, threadId, extra = {}) => JSON.parse((await send(entry, threadId, { text: 'newparams', ...extra })).text)
const hasExtensions = (sent) =>
  Boolean(sent._meta?.claudeCode?.options?.plugins?.length) && (sent.mcpServers || []).some((server) => server.name === 'brain')

test("a local owner's own chat gets the folder's extensions; someone else's comment, its thread and a board tool's result end them", async () => {
  const entry = await board()
  // The owner's own chat: a trusted turn, a clean thread.
  const mine = 'chat-aaaaaaaaaaaaaaaa'
  const sent = await sessionOf(entry, mine)
  assert.ok(hasExtensions(sent), JSON.stringify(sent))
  assert.deepEqual(sent._meta.claudeCode.options.skills, ['notes'])
  assert.deepEqual(readThread(entry.config, 'sample', mine).trust, { tainted: false, authors: ['owner'] })
  assert.match((await send(entry, mine, { text: 'extcall mcp__brain__search' })).text, /extcall mcp__brain__search: allow/)
  assert.match((await send(entry, mine, { text: 'extcall mcp__brain__other' })).text, /extcall mcp__brain__other: reject/)

  // A chat that mentions a comment someone else wrote: tainted, no extensions from then on.
  const mention = 'chat-bbbbbbbbbbbbbbbb'
  assert.ok(hasExtensions(await sessionOf(entry, mention)))
  const mentioned = await sessionOf(entry, mention, { mentions: [{ kind: 'comment', id: entry.other.id }] })
  assert.ok(!hasExtensions(mentioned))
  assert.equal(readThread(entry.config, 'sample', mention).trust.tainted, true)
  assert.ok(!hasExtensions(await sessionOf(entry, mention)), 'never again')

  // The thread of a comment someone else wrote: open, and it reads their text. Never.
  const theirs = `comment-${entry.other.id}`
  assert.ok(!hasExtensions(await sessionOf(entry, theirs)))

  // Mid-turn: a board tool's result comes in, the extension tool is refused, the thread is tainted.
  const tool = 'chat-cccccccccccccccc'
  assert.ok(hasExtensions(await sessionOf(entry, tool)))
  const refused = await send(entry, tool, { text: 'extcall mcp__brain__search mcp__shapewall__list_comments' })
  assert.match(refused.text, /extcall mcp__brain__search: reject/)
  assert.equal(readThread(entry.config, 'sample', tool).trust.tainted, true)
  assert.ok(!hasExtensions(await sessionOf(entry, tool)))
})
