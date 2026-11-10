// Scripted coding agent for the local feedback-loop fixture. No model calls.
import readline from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const mode = process.argv[2] || 'edit'
let cwd
let servers = []
let nextId = 100
const pending = new Map()
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
  if (message.method !== 'session/prompt') return
  const { sessionId, prompt } = message.params
  try {
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
      say(sessionId, `Changed the fixture heading. Owner tools: ${names.join(', ')}.`)
    } finally {
      await client.close()
    }
    reply({ stopReason: 'end_turn' })
  } catch (error) {
    send({ id: message.id, error: { code: -32001, message: error.message } })
  }
})
