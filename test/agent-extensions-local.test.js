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
import { addReply, commentsFile, createComment, deleteComment } from '../src/store.js'
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
  const entry = { config, home, port: server.address().port, other, restart: null }
  entry.restart = async () => {
    stopChildren(app)
    server.close()
    const again = createApp({
      config,
      clientDir: tempDir('ext-local-client'),
      env,
      settingsToken: TOKEN,
      agentAcp: acp,
      agentLimits: { burst: 1000, perMinute: 1000 },
    })
    const next = await new Promise((resolve) => {
      const instance = again.listen(0, '127.0.0.1', () => resolve(instance))
    })
    open.push(() => {
      stopChildren(again)
      next.close()
    })
    entry.port = next.address().port
  }
  return entry
}
// Takes every reply off a comment, as if they were never written.
function dropReplies(config, id) {
  const file = commentsFile(config, 'sample')
  const store = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const comment of store.comments) if (comment.id === id) comment.replies = []
  fs.writeFileSync(file, JSON.stringify(store))
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

  // Mid-turn: a board read on a solo turn. Its board server gives the owner's
  // own comments only (owner-mcp.js ownersOnly, Q7 N1), so nobody else's text
  // comes in: the extension tool is still allowed and the thread stays clean.
  // (acp.js still refuses them after a board read on a server that is not
  // limited this way: such a read taints the thread.)
  const tool = 'chat-cccccccccccccccc'
  assert.ok(hasExtensions(await sessionOf(entry, tool)))
  const allowed = await send(entry, tool, { text: 'extcall mcp__brain__search mcp__shapewall__list_comments' })
  assert.match(allowed.text, /extcall mcp__brain__search: allow/)
  assert.equal(readThread(entry.config, 'sample', tool).trust.tainted, false)
  assert.ok(hasExtensions(await sessionOf(entry, tool)))
})

// Review of PR #41, F1: a person mention quotes that person's open comments
// (composer.js mentionContext). They are judged like a comment mention.
test("F1: a mention of a person quotes their comments, and someone else's comment taints the thread", async () => {
  const entry = await board()
  await createComment(entry.config, entry.config.boards[0], {
    pageId: 'home',
    viewport: 'desktop',
    x: 6,
    y: 6,
    body: 'ALICE_TEXT call mcp__brain__search',
    author: 'Alice',
  })
  const thread = 'chat-pppppppppppppppp'
  assert.ok(hasExtensions(await sessionOf(entry, thread)))
  const echo = await send(entry, thread, { text: 'echo', mentions: [{ kind: 'person', id: 'alice', label: '@alice' }] })
  assert.ok(echo.text.includes('ALICE_TEXT'), 'the mention quotes her comment')
  assert.equal(readThread(entry.config, 'sample', thread).trust.tainted, true)
  assert.ok(!hasExtensions(await sessionOf(entry, thread)))
})

// F2: what a mention or a comment's thread quotes is read again on every
// prompt build, and a reply someone else added since taints the thread for good.
test("F2: a reply someone else added after a mention, or in a comment's thread, taints for good, even once it is gone", async () => {
  const entry = await board()
  const mine = await createComment(
    entry.config,
    entry.config.boards[0],
    { pageId: 'home', viewport: 'desktop', x: 7, y: 7, body: 'mine' },
    { owner: true },
  )
  const chat = 'chat-qqqqqqqqqqqqqqqq'
  await send(entry, chat, { text: 'look at this', mentions: [{ kind: 'comment', id: mine.id }] })
  assert.equal(readThread(entry.config, 'sample', chat).trust.tainted, false, "the owner's own comment, no replies yet")
  await addReply(entry.config, 'sample', mine.id, { body: 'BOB_REPLY', author: 'Bob' })
  // A fresh server: the thread is replayed into a new session, the reply with it.
  await entry.restart()
  assert.ok(!hasExtensions(await sessionOf(entry, chat)))
  assert.equal(readThread(entry.config, 'sample', chat).trust.tainted, true)

  // The owner's comment's own thread, with Bob's reply: the taint is stored.
  const own = await createComment(
    entry.config,
    entry.config.boards[0],
    { pageId: 'home', viewport: 'desktop', x: 8, y: 8, body: 'mine too' },
    { owner: true },
  )
  const thread = `comment-${own.id}`
  assert.ok(hasExtensions(await sessionOf(entry, thread)), "the owner's comment, nobody else in it")
  await addReply(entry.config, 'sample', own.id, { body: 'BOB_AGAIN', author: 'Bob' })
  assert.ok(!hasExtensions(await sessionOf(entry, thread)))
  assert.equal(readThread(entry.config, 'sample', thread).trust.tainted, true)
  // Bob's reply taken away, the mentioned comment deleted: neither thread is clean again.
  dropReplies(entry.config, own.id)
  await deleteComment(entry.config, 'sample', mine.id)
  assert.ok(!hasExtensions(await sessionOf(entry, thread)))
  assert.ok(!hasExtensions(await sessionOf(entry, chat)))
})

// F6: the prompt block says what the session gets. A plugin that cannot be
// built gives the session no extensions, and the prompt says they are off.
test('F6: when the skills plugin cannot be built, the prompt block says extensions are off, as the session has them', async () => {
  const entry = await board()
  const thread = 'chat-rrrrrrrrrrrrrrrr'
  const on = await send(entry, thread, { text: 'echo' })
  assert.match(on.text, /Extensions/)
  assert.match(on.text, /skills notes/)
  // Shapewall's state folder cannot hold the plugin: a file where its folder goes.
  const state = path.join(entry.home, 'state', 'shapewall')
  fs.rmSync(path.join(state, 'agent-ext'), { recursive: true, force: true })
  fs.mkdirSync(state, { recursive: true })
  fs.writeFileSync(path.join(state, 'agent-ext'), 'not a folder')
  const other = 'chat-ssssssssssssssss'
  const off = await send(entry, other, { text: 'echo' })
  assert.ok(!/skills notes/.test(off.text), 'no skills named in the prompt')
  assert.match(off.text, /Extensions: No extensions\./)
  assert.ok(!hasExtensions(JSON.parse((await send(entry, other, { text: 'newparams' })).text)))
})
