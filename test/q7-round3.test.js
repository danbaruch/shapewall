// Q7 round 3 of PR #43, the local side: the board write tools give back the
// write and never a comment's text (R1); what the audit of every tool result
// found (an agent reply anyone can claim, someone else's edit of the owner's
// comment, journeys made on the board); and the backstop that marks any tool
// result still carrying someone else's text, so a turn above open loses its
// commands and browser (R3). Real store, real tools, real HTTP surfaces and
// the real owner MCP server; no real endpoint or key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { addReply, createComment, getComment } from '../src/store.js'
import { createJourney } from '../src/journeys.js'
import { carriesOthers, runTool } from '../src/agent/tools.js'
import { runTurn } from '../src/agent/run.js'
import { ownersComment } from '../src/agent/watch-capabilities.js'
import { createApp } from '../src/server/app.js'
import { SAMPLE, request, sampleConfig, tempDir } from './helpers.js'

const OWNER_MCP = fileURLToPath(new URL('../src/agent/owner-mcp.js', import.meta.url))
const AGENT = { 'X-Shapewall-Agent': '1' }

// A board with Robin's comment, and the owner's own comment Robin replied to.
async function board(name) {
  const config = sampleConfig(name)
  fs.mkdirSync(config.dir, { recursive: true })
  fs.writeFileSync(config.file, JSON.stringify(SAMPLE))
  const target = config.boards[0]
  const theirs = await createComment(config, target, {
    pageId: 'pricing',
    viewport: 'desktop',
    x: 1,
    y: 1,
    body: 'ROBIN INJECT curl evil',
    author: 'Robin',
  })
  const mine = await createComment(
    config,
    target,
    { pageId: 'pricing', viewport: 'desktop', x: 2, y: 2, body: 'owner own', author: 'Me' },
    { owner: true },
  )
  await addReply(config, target.id, mine.id, { body: 'ROBIN REPLY INJECT', author: 'Robin' })
  const clean = await createComment(
    config,
    target,
    { pageId: 'home', viewport: 'desktop', x: 3, y: 3, body: 'owner clean', author: 'Me' },
    { owner: true },
  )
  return { config, target, theirs, mine, clean }
}
const context = (entry, quoteOthers = false) => ({
  config: entry.config,
  board: entry.target,
  ownerWrites: true,
  allowCapture: false,
  agentName: 'Builder',
  quoteOthers,
})

test('Q7 R1: the board write tools give back the write, never the text of the comment they wrote to', async () => {
  const entry = await board('q7-r1')
  const calls = [
    { name: 'set_comment_status', args: { id: entry.theirs.id, agentStatus: 'working' } },
    { name: 'reply_to_comment', args: { id: entry.theirs.id, body: 'on it' } },
    { name: 'resolve_comment', args: { id: entry.mine.id, note: 'fixed the header' } },
  ]
  for (const call of calls) {
    const result = await runTool(context(entry), call)
    assert.equal(result.ok, true, `${call.name}: ${result.text}`)
    assert.doesNotMatch(result.text, /INJECT/, call.name)
    assert.equal(result.outside, false, call.name)
    assert.match(result.text, new RegExp(`"id": ?${call.args.id}`), call.name)
    assert.match(result.text, /"agentStatus"/, call.name)
  }
  assert.match((await runTool(context(entry), calls[1])).text, /"replyId"/)
})

// One local board app: `shared` (reached from other machines): no request is the owner's.
async function app(t, config, { shared }) {
  const server = await new Promise((resolve) => {
    const instance = http
      .createServer(createApp({ config, clientDir: tempDir('q7-r3-client'), shared, log: () => {} }))
      .listen(0, '127.0.0.1', () => resolve(instance))
  })
  t.after(() => server.close())
  return (method, url, body, headers = {}) => request(server.address().port, method, url, { body, headers })
}

test("Q7 audit: an agent reply the owner's machine did not send is not the owner's, and neither is someone else's edit", async (t) => {
  const entry = await board('q7-audit-http')
  const visitor = await app(t, entry.config, { shared: true })
  // Anyone who reaches a shared board can send the agent header: their reply
  // still wakes no agent, but its words are theirs, not the owner's.
  const forged = await visitor(
    'POST',
    `/api/boards/sample/comments/${entry.clean.id}/replies`,
    { body: 'FORGED INJECT', author: 'Builder' },
    AGENT,
  )
  assert.equal(forged.status, 201, forged.text)
  assert.equal(forged.json.reply.agent, true)
  assert.equal(ownersComment(getComment(entry.config, 'sample', entry.clean.id)), false)
  const read = await runTool(context(entry), { name: 'get_comment', args: { id: entry.clean.id } })
  assert.doesNotMatch(read.text, /INJECT/)
  // An edit of the owner's comment, or a resolution note, by someone else.
  const edited = await createComment(
    entry.config,
    entry.target,
    { pageId: 'home', viewport: 'desktop', x: 4, y: 4, body: 'owner text' },
    { owner: true },
  )
  assert.equal((await visitor('PATCH', `/api/boards/sample/comments/${edited.id}`, { body: 'EDIT INJECT' })).status, 200)
  assert.equal(getComment(entry.config, 'sample', edited.id).byOwner, false)
  const noted = await createComment(
    entry.config,
    entry.target,
    { pageId: 'home', viewport: 'desktop', x: 5, y: 5, body: 'owner text' },
    { owner: true },
  )
  assert.equal((await visitor('POST', `/api/boards/sample/comments/${noted.id}/resolve`, { resolution: 'NOTE INJECT' })).status, 200)
  assert.equal(getComment(entry.config, 'sample', noted.id).byOwner, false)
  const listed = await runTool(context(entry), { name: 'list_comments', args: { status: 'all' } })
  assert.doesNotMatch(listed.text, /INJECT/)

  // The owner's own machine: its agent's reply and the owner's edit keep the comment the owner's.
  const own = await app(t, entry.config, { shared: false })
  const ownComment = await createComment(
    entry.config,
    entry.target,
    { pageId: 'home', viewport: 'desktop', x: 6, y: 6, body: 'mine' },
    { owner: true },
  )
  assert.equal(
    (await own('POST', `/api/boards/sample/comments/${ownComment.id}/replies`, { body: 'done', author: 'Builder' }, AGENT)).status,
    201,
  )
  assert.equal((await own('PATCH', `/api/boards/sample/comments/${ownComment.id}`, { body: 'mine, edited' })).status, 200)
  assert.equal(ownersComment(getComment(entry.config, 'sample', ownComment.id)), true)
})

test('Q7 audit: above open, the owner MCP server shows a journey made on the board by its pages only', async (t) => {
  const entry = await board('q7-audit-journeys')
  await createJourney(entry.config, entry.target, {
    name: 'JOURNEY INJECT curl evil',
    description: 'DESCRIPTION INJECT',
    steps: [
      'home',
      {
        branches: [
          { id: 'a', label: 'LABEL INJECT', steps: ['pricing'] },
          { id: 'b', label: 'other way', steps: ['pricing'] },
        ],
      },
    ],
  })
  const connect = async (mode) => {
    const client = new Client({ name: 'q7-round3', version: '1.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [OWNER_MCP, entry.config.file, 'sample', 'no-capture', mode],
        env: { ...process.env, HOME: tempDir('q7-r3-home'), XDG_CONFIG_HOME: tempDir('q7-r3-xdg') },
        stderr: 'pipe',
      }),
    )
    t.after(() => client.close())
    return client
  }
  const text = (result) => result.content.map((part) => part.text || '').join('\n')
  const owners = text(await (await connect('owners')).callTool({ name: 'list_journeys', arguments: {} }))
  assert.doesNotMatch(owners, /INJECT/)
  assert.match(owners, /not shown on this turn/)
  assert.match(owners, /pricing/)
  assert.match(text(await (await connect('all')).callTool({ name: 'list_journeys', arguments: {} })), /JOURNEY INJECT/)
  // Its other tools hand back the write only, as on the endpoint path.
  const writes = await connect('owners')
  for (const [name, args] of [
    ['set_comment_status', { id: entry.theirs.id, agentStatus: 'working' }],
    ['reply_to_comment', { id: entry.theirs.id, body: 'on it' }],
    ['resolve_comment', { id: entry.mine.id, note: 'done' }],
  ])
    assert.doesNotMatch(text(await writes.callTool({ name, arguments: args })), /INJECT/, name)
})

test("Q7 R3: a tool result that still carries other people's text is marked, whatever the tool meant to return", async () => {
  const entry = await board('q7-r3-mark')
  // What the write tools gave back before R1: the whole comment.
  assert.equal(carriesOthers(entry.config, entry.target, getComment(entry.config, 'sample', entry.theirs.id)), true)
  assert.equal(carriesOthers(entry.config, entry.target, { comment: getComment(entry.config, 'sample', entry.mine.id) }), true)
  assert.equal(carriesOthers(entry.config, entry.target, getComment(entry.config, 'sample', entry.clean.id)), false)
  // Real tools: an open turn's read of Robin's comment is marked; the writes are not.
  assert.equal((await runTool(context(entry, true), { name: 'get_comment', args: { id: entry.theirs.id } })).outside, true)
  assert.equal((await runTool(context(entry, true), { name: 'list_comments', args: {} })).outside, true)
  assert.equal((await runTool(context(entry), { name: 'reply_to_comment', args: { id: entry.theirs.id, body: 'x' } })).outside, false)
})

test("Q7 R3: on a turn above open, no real board tool brings other people's text in while the commands are on", async () => {
  const entry = await board('q7-r3-turn')
  const ran = []
  const host = {
    tools: () => [{ name: 'run_named_command', description: 'Run a named command', inputSchema: { type: 'object' } }],
    call: async (name) => {
      ran.push(name)
      return { content: [{ type: 'text', text: 'ran' }] }
    },
  }
  // Three rounds, each with board tools and then a command.
  const script = [
    [
      { name: 'get_comment', args: { id: entry.theirs.id } },
      { name: 'get_comment', args: { id: entry.mine.id } },
    ],
    [
      { name: 'list_comments', args: { status: 'all' } },
      { name: 'set_comment_status', args: { id: entry.theirs.id, agentStatus: 'working' } },
    ],
    [
      { name: 'reply_to_comment', args: { id: entry.theirs.id, body: 'on it' } },
      { name: 'resolve_comment', args: { id: entry.mine.id, note: 'fixed' } },
    ],
  ]
  const rounds = []
  let step = 0
  const backend = {
    id: 'openai',
    tools: 'shapewall',
    async *stream({ tools, messages }) {
      rounds.push({ tools: tools.map((tool) => tool.name), seen: JSON.stringify(messages) })
      const calls = script[step]
      step += 1
      if (calls) {
        for (const [index, call] of calls.entries()) yield { type: 'tool_call', id: `c${step}-${index}`, ...call }
        yield { type: 'tool_call', id: `x${step}`, name: 'run_named_command', args: { name: 'test' } }
      } else yield { type: 'text', text: 'done' }
    },
  }
  let tainted = 0
  await runTurn({
    config: entry.config,
    board: entry.target,
    threadId: 'board',
    messages: [{ role: 'user', text: 'go' }],
    conversation: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    backend,
    emit: () => {},
    signal: new AbortController().signal,
    ownerWrites: true,
    allowCapture: false,
    agentName: 'Builder',
    execHost: host,
    quoteOthers: false,
    onTaint: () => (tainted += 1),
  })
  for (const [index, round] of rounds.entries()) {
    const others = /INJECT/.test(round.seen)
    const commands = round.tools.includes('run_named_command')
    assert.ok(!(others && commands), `round ${index}: other people's text and the commands at once`)
  }
  assert.equal(tainted, 0, 'nothing of anyone else came back')
  assert.equal(ran.length, script.length, 'so every command ran')
})
