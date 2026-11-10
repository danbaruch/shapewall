import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createApp, stopChildren } from '../src/server/app.js'
import { createMcpServer } from '../src/mcp.js'
import { projectChanged, projectSnapshot, finishFix } from '../src/agent/feedback-loop.js'
import { toolSpecs, runTool } from '../src/agent/tools.js'
import { createComment, getComment } from '../src/store.js'
import { SAMPLE, sampleConfig, tempDir, request } from './helpers.js'
import { loadConfig } from '../src/config.js'
import { watchComments } from '../src/watch.js'
const valid = { pageId: 'home', viewport: 'desktop', x: 20, y: 20, body: 'Fix heading' }
const token = 'owner-loop-test-token'
const fixture = path.resolve('test/fixtures/acp-fix.mjs')
const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })

function setup(name) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(SAMPLE))
  return loadConfig(file)
}
const fakeCapture = async ({ config, boardId, only }) => {
  assert.deepEqual(only, ['home'])
  const dir = path.join(config.outputDir, boardId, 'captures')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      capturedAt: new Date().toISOString(),
      pages: { home: { desktop: { status: 'ok', version: '20261106T010101001Z-abcd' } } },
    }),
  )
  return { ok: true, failed: 0, total: 1 }
}

test('write tools require owner capability; capture allowlist and no-capture apply at execution too', async () => {
  const config = sampleConfig('owner-tools')
  const board = config.boards[0]
  const comment = await createComment(config, board, valid)
  assert.deepEqual(
    toolSpecs().map((tool) => tool.name),
    ['list_pages', 'list_comments', 'get_comment'],
  )
  assert.ok(toolSpecs({ ownerWrites: true }).some((tool) => tool.name === 'resolve_comment'))
  const denied = await runTool({ config, board }, { name: 'reply_to_comment', args: { id: comment.id, body: 'no' } })
  assert.equal(denied.ok, false)
  assert.equal(getComment(config, board.id, comment.id).replies.length, 0)
  const write = await runTool({ config, board, ownerWrites: true }, { name: 'reply_to_comment', args: { id: comment.id, body: 'yes' } })
  assert.equal(write.ok, true)
  let captures = 0
  for (const args of [{ pageIds: ['../secret'] }, { pageIds: ['home'] }]) {
    assert.equal(
      (
        await runTool(
          { config, board, ownerWrites: true, allowCapture: args.pageIds[0] !== 'home', capture: () => captures++ },
          { name: 'recapture_pages', args },
        )
      ).ok,
      false,
    )
  }
  assert.equal(captures, 0)
})

test('ACP: no injected MCP tools on shared boards; tokenless and proxied requests on a local board are refused', async () => {
  for (const options of [{ shared: true, allowRemoteAgent: true }, {}, { proxy: true }]) {
    const config = setup('loop-untrusted')
    const app = createApp({ config, settingsToken: token, agentAcp: `${process.execPath} ${fixture} inspect`, ...options })
    const server = await listen(app)
    const port = server.address().port
    try {
      const headers = {
        Origin: `http://127.0.0.1:${port}`,
        ...(options.shared || options.proxy ? { 'X-Shapewall-Settings-Token': token } : {}),
        ...(options.proxy ? { Via: 'proxy' } : {}),
      }
      const result = await request(port, 'POST', '/api/agent/boards/sample/threads/board/messages', {
        headers,
        body: { text: 'Inspect tools' },
      })
      assert.doesNotMatch(result.text, /owner-mcp/)
      if (options.shared) {
        // Shared with --allow-remote-agent: whoever reaches it may chat, with no owner tools.
        assert.equal(result.status, 200)
        assert.match(result.text, /"text":"\[\]"/)
      } else {
        // A direct local board has an owner capability: without it (no token,
        // or the token through a proxy) the agent does not run at all.
        assert.equal(result.status, 403)
        assert.match(result.text, /control_needs_owner/)
      }
    } finally {
      stopChildren(app)
      await new Promise((resolve) => server.close(resolve))
    }
  }
})

test('scoped ACP MCP server refuses alternate board ids and GitHub tools', async () => {
  const config = sampleConfig('loop-mcp')
  const server = createMcpServer({ config, boardId: 'sample', toolNames: ['list_pages', 'reply_to_comment'] })
  const client = new Client({ name: 'scope-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  await client.connect(b)
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ['list_pages', 'reply_to_comment'],
    )
    assert.equal((await client.callTool({ name: 'list_pages', arguments: { board: 'another' } })).isError, true)
  } finally {
    await client.close()
    await server.close()
  }
})

test('metadata snapshot detects source edits and excludes store, dependencies and symlinks', () => {
  const config = sampleConfig('snapshot')
  fs.writeFileSync(path.join(config.dir, 'index.html'), 'Before')
  const before = projectSnapshot(config)
  fs.mkdirSync(config.outputDir, { recursive: true })
  fs.writeFileSync(path.join(config.outputDir, 'chat.json'), 'changed')
  fs.mkdirSync(path.join(config.dir, 'node_modules'))
  fs.writeFileSync(path.join(config.dir, 'node_modules', 'ignore'), 'dependency')
  fs.symlinkSync('/etc', path.join(config.dir, 'symlink'))
  assert.equal(projectChanged(before, projectSnapshot(config)), false)
  fs.writeFileSync(path.join(config.dir, 'index.html'), 'After!')
  assert.equal(projectChanged(before, projectSnapshot(config)), true)
})

test('failed and unchanged fixes never become done or recapture', async () => {
  for (const status of ['error', 'done', 'stopped']) {
    const config = sampleConfig('loop-failure')
    const board = config.boards[0]
    const comment = await createComment(config, board, valid)
    let captures = 0
    await finishFix({ config, board, id: comment.id, reply: { status }, changed: status !== 'done', capture: () => captures++ })
    assert.equal(captures, 0)
    assert.equal(getComment(config, board.id, comment.id).agentStatus, 'needs-human')
  }
})

test('watch --recapture captures a silent successful command; a failed capture needs a person', async () => {
  for (const fails of [false, true]) {
    const config = setup('watch-recapture')
    await createComment(config, config.boards[0], valid)
    let captures = 0
    await watchComments({
      config,
      exec: `${process.execPath} -e ''`,
      recapture: true,
      once: true,
      log: () => {},
      capture: async (input) => {
        captures++
        if (fails) throw new Error('Dev server is down')
        return fakeCapture(input)
      },
    })
    assert.equal(captures, 1)
    assert.equal(getComment(config, 'sample', 1).agentStatus, fails ? 'needs-human' : 'done')
    assert.match(getComment(config, 'sample', 1).replies[0].body, fails ? /Dev server is down/ : /no original capture/)
  }
  await assert.rejects(watchComments({ config: setup('watch-invalid'), recapture: true, once: true }), /needs --exec/)
})

test('owner capability injects scoped ACP tools, no-capture drops capture, and later tokenless turns are refused', async () => {
  for (const allowCapture of [true, false]) {
    const config = setup('owner-capability')
    const app = createApp({ config, settingsToken: token, allowCapture, agentAcp: `${process.execPath} ${fixture} inspect` })
    const server = await listen(app)
    const port = server.address().port
    const headers = { Origin: `http://127.0.0.1:${port}`, 'X-Shapewall-Settings-Token': token }
    try {
      const info = await request(port, 'GET', '/api/info', { headers })
      assert.equal(info.json.agent.ownerWrites, true)
      assert.equal(info.json.agent.fixWithAgent, allowCapture)
      const owner = await request(port, 'POST', '/api/agent/boards/sample/threads/board/messages', { headers, body: { text: 'Inspect' } })
      assert.match(owner.text, /owner-mcp.js/)
      assert.match(owner.text, allowCapture ? /capture/ : /no-capture/)
      const untrusted = await request(port, 'POST', '/api/agent/boards/sample/threads/board/messages', {
        headers: { Origin: headers.Origin },
        body: { text: 'Inspect' },
      })
      assert.equal(untrusted.status, 403)
      assert.match(untrusted.text, /control_needs_owner/)
      const again = await request(port, 'POST', '/api/agent/boards/sample/threads/board/messages', {
        headers,
        body: { text: 'Inspect again' },
      })
      assert.match(again.text, /owner-mcp.js/)
    } finally {
      stopChildren(app)
      await new Promise((resolve) => server.close(resolve))
    }
  }
})

test('fix request failures, no edits and failed capture leave explicit needs-human status', async () => {
  for (const mode of ['no-edit', 'fail', 'edit']) {
    const config = setup(`fix-${mode}`)
    const comment = await createComment(config, config.boards[0], valid)
    const app = createApp({ config, settingsToken: token, agentAcp: `${process.execPath} ${fixture} ${mode}` })
    const server = await listen(app)
    const port = server.address().port
    try {
      const result = await request(port, 'POST', `/api/agent/boards/sample/threads/comment-${comment.id}/messages`, {
        headers: { Origin: `http://127.0.0.1:${port}`, 'X-Shapewall-Settings-Token': token },
        body: { text: 'Fix heading', fix: true },
      })
      assert.equal(result.status, 200)
      const saved = getComment(config, 'sample', comment.id)
      assert.equal(saved.agentStatus, 'needs-human', JSON.stringify(saved))
      assert.equal(saved.status, 'open')
      assert.ok(saved.replies.some((reply) => /No project|stopped|verification needs/.test(reply.body)))
    } finally {
      stopChildren(app)
      await new Promise((resolve) => server.close(resolve))
    }
  }
})

test('tokenless, proxied and cross-origin callers cannot approve, stop or reset an owner ACP session', async () => {
  const config = setup('owner-controls')
  const stub = path.resolve('test/fixtures/acp-stub.mjs')
  const app = createApp({ config, settingsToken: token, agentAcp: `${process.execPath} ${stub}` })
  const server = await listen(app)
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`
  const base = '/api/agent/boards/sample/threads/board'
  const ownerHeaders = { Origin: origin, 'X-Shapewall-Settings-Token': token }
  let ownerPid
  const turn = async (answer) => {
    const response = await fetch(`${origin}${base}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ownerHeaders },
      body: JSON.stringify({ text: 'permission' }),
    })
    assert.equal(response.status, 200)
    const events = []
    let buffer = ''
    const decoder = new TextDecoder()
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const raw = /^data: (.*)$/m.exec(block)?.[1]
        if (!raw) continue
        const data = JSON.parse(raw)
        events.push(data)
        if (data.kind === 'permission' && data.state === 'pending') await answer(data)
      }
    }
    return events
  }
  try {
    const result = await turn(async (card) => {
      ownerPid = app.locals.agentRouter.backend().processes()[0].pid
      for (const headers of [
        { Origin: origin },
        { ...ownerHeaders, Via: 'untrusted proxy' },
        { ...ownerHeaders, Origin: 'https://attacker.invalid' },
      ]) {
        for (const [method, suffix, body] of [
          ['POST', '/stop', {}],
          ['DELETE', '', undefined],
          ['POST', `/permissions/${card.id}`, { optionId: 'allow' }],
        ]) {
          const denied = await request(port, method, `${base}${suffix}`, { headers, body })
          assert.equal(denied.status, 403, `${method} ${suffix}: ${denied.text}`)
          assert.equal(denied.json.error.code, 'control_needs_owner')
        }
      }
      const process = app.locals.agentRouter.backend().processes()[0]
      assert.equal(process.pid, ownerPid)
      assert.equal(process.busy, true, 'denied controls leave the owner run active')
      const approved = await request(port, 'POST', `${base}/permissions/${card.id}`, { headers: ownerHeaders, body: { optionId: 'allow' } })
      assert.equal(approved.status, 200)
    })
    assert.equal(result.at(-1).message.status, 'done')
    assert.match(result.at(-1).message.text, /Permission: allow/)
    assert.equal((await request(port, 'DELETE', base)).status, 403, 'idle owner sessions still need owner control')
    const stopped = await turn(async () => {
      assert.equal((await request(port, 'POST', `${base}/stop`, { body: {} })).status, 403)
      assert.equal((await request(port, 'POST', `${base}/stop`, { headers: ownerHeaders, body: {} })).status, 200)
    })
    assert.equal(stopped.at(-1).message.status, 'stopped')
    assert.equal((await request(port, 'DELETE', base, { headers: ownerHeaders })).status, 200)
    assert.equal(app.locals.agentRouter.backend().processes().length, 0)
  } finally {
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
  }
})
