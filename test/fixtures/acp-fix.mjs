// Scripted coding agent for the local feedback-loop fixture. No model calls.
// Modes: edit (default), fail, no-edit, inspect, login, slow, and branch: like edit,
// but first checks that it runs in an agent branch worktree and that a write
// to the person's checkout is refused (agent branch mode). branch-media: like
// branch, and the comment's images and drawing must arrive as image blocks in
// the prompt and as readable files outside the worktree through get_comment.
// slow: like edit, after a pause of 1.5 s that session/cancel ends (the turn
// then stops as cancelled, nothing edited), so a batch can be cancelled mid-item.
import fs from 'node:fs'
import readline from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const mode = process.argv[2] || 'edit'
let cwd
let servers = []
let nextId = 100
const pending = new Map()
let cancelTurn = null
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
const ask = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    send({ id, method, params })
  })
const say = (sessionId, text) =>
  send({
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  })
const lines = readline.createInterface({ input: process.stdin })
lines.on('close', () => process.exit(0))
lines.on('line', async (line) => {
  const message = JSON.parse(line)
  if (!message.method) {
    const wait = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) wait?.reject(new Error(message.error.message))
    else wait?.resolve(message.result)
    return
  }
  const reply = (result) => send({ id: message.id, result })
  if (message.method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } })
  if (message.method === 'session/new') {
    cwd = message.params.cwd
    servers = message.params.mcpServers
    return reply({ sessionId: 'fixture' })
  }
  if (message.method === 'session/cancel') return cancelTurn?.()
  if (message.method !== 'session/prompt') return
  const { sessionId, prompt } = message.params
  try {
    if (mode === 'slow') {
      const cancelled = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 1500)
        cancelTurn = () => {
          clearTimeout(timer)
          resolve(true)
        }
      })
      cancelTurn = null
      if (cancelled) return reply({ stopReason: 'cancelled' })
    }
    if (mode === 'inspect') {
      say(sessionId, JSON.stringify(servers))
      return reply({ stopReason: 'end_turn' })
    }
    // An agent that is not signed in: ACP's auth_required, before any work.
    if (mode === 'login') return send({ id: message.id, error: { code: -32000, message: 'Authentication required' } })
    if (mode === 'no-edit') {
      say(sessionId, 'I need more information.')
      return reply({ stopReason: 'end_turn' })
    }
    if (mode === 'branch' || mode === 'branch-media') {
      const marker = '/.shapewall/agent-worktrees/'
      if (!cwd.includes(marker)) throw new Error(`Not in an agent worktree: ${cwd}`)
      const checkout = cwd.slice(0, cwd.indexOf(marker))
      let escaped = true
      try {
        await ask('fs/write_text_file', { sessionId, path: `${checkout}/index.html`, content: 'escaped' })
      } catch {
        escaped = false
      }
      if (escaped) throw new Error('A write to the checkout was allowed')
    }
    await ask('fs/write_text_file', {
      sessionId,
      path: `${cwd}/index.html`,
      content: '<!doctype html><html><body><h1>Fixed fixture heading</h1></body></html>',
    })
    if (mode === 'fail') throw new Error('Fixture stops after an edit')
    // Verify the actual injected MCP process, not only a model tool schema.
    const server = servers[0]
    if (!server) throw new Error('Owner tools were not injected')
    const client = new Client({ name: 'fake-acp-fixture', version: '1' })
    const transport = new StdioClientTransport({ command: server.command, args: server.args, stderr: 'pipe' })
    await client.connect(transport)
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name)
      if (!names.includes('reply_to_comment') || names.includes('create_github_issue')) throw new Error('Unexpected owner tool scope')
      const context = prompt
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      const id = Number(/"id":\s*(\d+)/.exec(context)?.[1] || 1)
      const result = await client.callTool({
        name: 'reply_to_comment',
        arguments: { id, body: 'Changed the fixture heading and verified owner tools.' },
      })
      if (result.isError) throw new Error(result.content[0].text)
      if (mode === 'branch-media') {
        const images = prompt.filter((block) => block.type === 'image').length
        if (images < 2) throw new Error(`Expected the comment image and drawing in the prompt, got ${images} images`)
        const got = await client.callTool({ name: 'get_comment', arguments: { id, image: 'none' } })
        const item = JSON.parse(got.content.find((block) => block.type === 'text').text).comment
        const files = [item.files?.markup, ...(item.files?.images || []).map((image) => image.path)]
        if (files.length < 2 || files.some((file) => !file)) throw new Error(`Missing comment files: ${JSON.stringify(item.files)}`)
        for (const file of files) {
          if (file.startsWith(cwd)) throw new Error(`A comment file points into the worktree: ${file}`)
          if (!fs.statSync(file).isFile()) throw new Error(`Not a file: ${file}`)
        }
        say(sessionId, `Saw ${images} images and ${files.length} comment files. `)
      }
      say(sessionId, `Changed the fixture heading. Owner tools: ${names.join(', ')}.`)
    } finally {
      await client.close()
    }
    reply({ stopReason: 'end_turn' })
  } catch (error) {
    send({ id: message.id, error: { code: -32001, message: error.message } })
  }
})
