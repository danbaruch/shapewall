#!/usr/bin/env node
// A stub ACP agent for the tests: newline-delimited JSON-RPC on stdio, written
// by hand (not with the SDK) so the tests check Shapewall against the wire
// format. It never calls a model. What it does depends on the prompt's last
// text block:
//
//   "stream"            -> three text chunks and a thought, then end_turn
//   "tools"             -> a plan, a tool call that runs and completes, a failed one, then text
//   "permission"        -> asks session/request_permission, then says which option came back
//   "slowly"            -> a word every 30 ms until session/cancel (then stopReason cancelled)
//   "ignore cancel"     -> a word every 30 ms and ignores session/cancel
//   "read PATH"         -> fs/read_text_file, then the content or the error message
//   "write PATH"        -> fs/write_text_file with "written by stub", then ok or the error
//   "run CMD ARGS..."   -> terminal/create, wait_for_exit, output, release; then the output or the error
//   "env"               -> the names of its environment variables, as JSON
//   "caps"              -> the client capabilities it was given, as JSON
//   "pid"               -> its process id
//   "cwd"               -> its working folder, what is in it, and the session cwd
//   "runenv N=V CMD..."  -> like run, with env for the terminal
//   "echo"              -> every prompt block it got, as JSON
//   "crash"             -> exits with code 3 mid-turn
//   "edit PATH"         -> asks to edit PATH with ACP diff content (oldText/newText), then the option
//   "rawedit PATH"      -> asks to edit PATH with Claude Code style rawInput (old_string/new_string)
//   "longedit PATH"     -> like edit, adding a 1000-character line with a bidi override
//   "loginsay"          -> answers only "Invalid API key · Please run /login" (an auth stop)
//   "usage"             -> a usage_update (32000 of 128000) and the turn's token counts in the answer
//   "nextsteps"         -> text that ends with a <next-steps> block
//   "config"            -> the session's model and effort values, as JSON
//   "mode"              -> the session's mode
//   anything else       -> "Hello from the ACP stub."
//
// STUB_ACP_MODE=auth: session/new answers auth_required. STUB_ACP_MODE=silent:
// never answers initialize. STUB_ACP_MODE=noimage: no image prompt capability.
// STUB_ACP_MODE=promptauth: the session starts, every prompt fails with auth_required.
// --options: session/new lists model, thought_level and mode config options,
// and session/set_config_option switches them. --modes: the older way, a
// `modes` list in session/new switched with session/set_mode. --slow-new:
// session/new takes 400 ms (the composer's "Loading options").

import fs from 'node:fs'
import process from 'node:process'

const MODE = process.env.STUB_ACP_MODE || ''
const OPTIONS = process.argv.includes('--options')
const MODES = process.argv.includes('--modes')
const SLOW_NEW = process.argv.includes('--slow-new')
const config = { model: 'stub-fast', effort: 'medium' }
let mode = 'ask'
const modes = () => ({
  currentModeId: mode,
  availableModes: [
    { id: 'ask', name: 'Ask' },
    { id: 'architect', name: 'Architect', description: 'Plans before it edits' },
    { id: 'bypassPermissions', name: 'Bypass permissions' },
  ],
})
const configOptions = () => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: config.model,
    options: [
      { value: 'stub-fast', name: 'Stub fast', description: 'Quick answers' },
      { value: 'stub-deep', name: 'Stub deep', description: 'Slower, more careful' },
    ],
  },
  {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    type: 'select',
    currentValue: config.effort,
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
  // Shapewall offers Ask and Plan, never Yolo (it would act without asking).
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: mode,
    options: [
      { value: 'ask', name: 'Ask' },
      { value: 'plan', name: 'Plan' },
      { value: 'yolo', name: 'Yolo' },
    ],
  },
  // Never shown by Shapewall: a permission setting.
  {
    id: 'approvals',
    name: 'Approval policy',
    type: 'select',
    currentValue: 'ask',
    options: [
      { value: 'ask', name: 'Ask' },
      { value: 'never', name: 'Never ask' },
    ],
  },
]
let nextId = 1
const waiting = new Map()
let clientCapabilities = null
let cancelled = new Set()
let buffer = ''
let sessionCwd = null

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    waiting.set(id, { resolve, reject })
    send({ id, method, params })
  })
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } })
const say = (sessionId, text) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    handle(message)
  }
})
const slowRetirement = process.argv.includes('--retire-slow')
if (slowRetirement) process.on('SIGTERM', () => {})
process.stdin.on('end', () => (slowRetirement ? setTimeout(() => process.exit(0), 350) : process.exit(0)))

function handle(message) {
  if (message.id !== undefined && !message.method) {
    const entry = waiting.get(message.id)
    waiting.delete(message.id)
    if (message.error) entry?.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
    else entry?.resolve(message.result)
    return
  }
  if (message.method === 'session/cancel') {
    cancelled.add(message.params.sessionId)
    return
  }
  const reply = (result) => send({ id: message.id, result })
  const fail = (code, text) => send({ id: message.id, error: { code, message: text } })
  if (message.method === 'initialize') {
    if (MODE === 'silent') return
    clientCapabilities = message.params.clientCapabilities
    return reply({
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: MODE !== 'noimage', embeddedContext: true } },
      agentInfo: { name: 'acp-stub', title: 'ACP stub', version: '1.0.0' },
      authMethods: [{ id: 'stub-login', name: 'Log in to the stub' }],
    })
  }
  if (message.method === 'session/new') {
    if (MODE === 'auth') return fail(-32000, 'Authentication required')
    sessionCwd = message.params.cwd
    const answer = () =>
      reply({
        sessionId: `stub-session-${process.pid}`,
        ...(OPTIONS ? { configOptions: configOptions() } : {}),
        ...(MODES ? { modes: modes() } : {}),
      })
    if (SLOW_NEW) return void setTimeout(answer, 400)
    return answer()
  }
  if (message.method === 'session/set_mode') {
    if (!MODES || !modes().availableModes.some((item) => item.id === message.params.modeId)) return fail(-32602, 'unknown mode')
    mode = message.params.modeId
    return reply({})
  }
  if (message.method === 'session/set_config_option') {
    const option = OPTIONS && configOptions().find((item) => item.id === message.params.configId)
    if (!option || !option.options.some((item) => item.value === message.params.value)) return fail(-32602, 'unknown option')
    if (option.id === 'mode') mode = message.params.value
    else config[option.id] = message.params.value
    return reply({ configOptions: configOptions() })
  }
  if (message.method === 'session/prompt') {
    prompt(message.params)
      .then((result) => reply(typeof result === 'string' ? { stopReason: result } : result))
      .catch((error) => fail(error.code || -32603, error.message))
    return
  }
  if (message.id !== undefined) fail(-32601, `Method not found: ${message.method}`)
}

async function prompt({ sessionId, prompt: blocks }) {
  cancelled.delete(sessionId)
  if (MODE === 'promptauth') throw Object.assign(new Error('Authentication required'), { code: -32000 })
  const last =
    [...blocks]
      .reverse()
      .find((block) => block.type === 'text')
      ?.text?.trim() || ''
  const [word, ...rest] = last.split(/\s+/)
  if (last === 'unsupported model') {
    say(sessionId, "The 'unavailable-model' model is not supported when using Codex with a ChatGPT account.")
    return 'end_turn'
  }
  if (last === 'stream') {
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking about it.' } })
    for (const part of ['Hello ', 'from ', 'the stream.']) {
      say(sessionId, part)
      await sleep(20)
    }
    return 'end_turn'
  }
  if (last === 'tools') {
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read the page', priority: 'high', status: 'completed' },
        { content: 'Suggest a fix', priority: 'medium', status: 'in_progress' },
      ],
    })
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'Read index.html',
      kind: 'read',
      status: 'pending',
      locations: [{ path: `${sessionCwd}/index.html` }],
    })
    await sleep(20)
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' })
    await sleep(20)
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' })
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-2', title: 'Search the web', kind: 'fetch', status: 'in_progress' })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: 'failed' })
    say(sessionId, 'Done with tools.')
    return 'end_turn'
  }
  if (last === 'permission') {
    const result = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'call-edit', title: 'Edit styles.css', kind: 'edit', rawInput: { file_path: 'styles.css' } },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    })
    say(sessionId, result.outcome.outcome === 'selected' ? `Permission: ${result.outcome.optionId}.` : 'Permission: cancelled.')
    return cancelled.has(sessionId) ? 'cancelled' : 'end_turn'
  }
  if (last === 'slowly' || last === 'ignore cancel') {
    for (let index = 0; index < 400; index += 1) {
      if (last === 'slowly' && cancelled.has(sessionId)) return 'cancelled'
      say(sessionId, `word${index} `)
      await sleep(30)
    }
    return 'end_turn'
  }
  if (word === 'read') {
    try {
      const result = await request('fs/read_text_file', { sessionId, path: rest.join(' ') })
      say(sessionId, `Read: ${result.content}`)
    } catch (error) {
      say(sessionId, `Read refused: ${error.message}`)
    }
    return 'end_turn'
  }
  if (word === 'write') {
    try {
      await request('fs/write_text_file', { sessionId, path: rest.join(' '), content: 'written by stub' })
      say(sessionId, 'Write ok.')
    } catch (error) {
      say(sessionId, `Write refused: ${error.message}`)
    }
    return 'end_turn'
  }
  if (word === 'run' || word === 'runenv') {
    // runenv NAME=VALUE[,NAME=VALUE] CMD ARGS...
    const env =
      word === 'runenv'
        ? rest
            .shift()
            .split(',')
            .map((pair) => ({ name: pair.split('=')[0], value: pair.split('=').slice(1).join('=') }))
        : undefined
    try {
      const { terminalId } = await request('terminal/create', {
        sessionId,
        command: rest[0],
        args: rest.slice(1),
        env,
        outputByteLimit: 4096,
      })
      const exit = await request('terminal/wait_for_exit', { sessionId, terminalId })
      const output = await request('terminal/output', { sessionId, terminalId })
      await request('terminal/release', { sessionId, terminalId })
      say(sessionId, `Ran (exit ${exit.exitCode}): ${output.output.trim()}`)
    } catch (error) {
      say(sessionId, `Run refused: ${error.message}`)
    }
    return 'end_turn'
  }
  if (last === 'env') {
    say(sessionId, JSON.stringify(Object.keys(process.env).sort()))
    return 'end_turn'
  }
  if (last === 'caps') {
    say(sessionId, JSON.stringify(clientCapabilities))
    return 'end_turn'
  }
  if (last === 'cwd') {
    say(sessionId, JSON.stringify({ cwd: process.cwd(), files: fs.readdirSync(process.cwd()), sessionCwd }))
    return 'end_turn'
  }
  if (last === 'pid') {
    say(sessionId, `pid ${process.pid}`)
    return 'end_turn'
  }
  if (last === 'echo') {
    say(sessionId, JSON.stringify(blocks))
    return 'end_turn'
  }
  if (word === 'edit' || word === 'rawedit' || word === 'longedit') {
    const file = rest.join(' ')
    // longedit: a 1000-character line with a bidi override in it.
    const long = 'L'.repeat(500) + String.fromCharCode(0x202e) + 'R'.repeat(499)
    const toolCall =
      word === 'edit' || word === 'longedit'
        ? {
            toolCallId: 'call-diff',
            title: 'Edit ' + file,
            kind: 'edit',
            content: [
              word === 'edit'
                ? { type: 'diff', path: file, oldText: 'one\ntwo\nthree\n', newText: 'one\n2\nthree\n' }
                : { type: 'diff', path: file, oldText: 'one\n', newText: 'one\n' + long + '\n' },
            ],
          }
        : {
            toolCallId: 'call-raw',
            title: 'Edit ' + file,
            kind: 'edit',
            rawInput: { file_path: file, old_string: 'Hello', new_string: 'Hi there' },
          }
    const result = await request('session/request_permission', {
      sessionId,
      toolCall,
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    })
    say(sessionId, result.outcome.outcome === 'selected' ? 'Permission: ' + result.outcome.optionId + '.' : 'Permission: cancelled.')
    return 'end_turn'
  }
  if (last === 'loginsay') {
    say(sessionId, 'Invalid API key · Please run /login')
    return 'end_turn'
  }
  if (last === 'crash') {
    say(sessionId, 'About to crash.')
    process.stderr.write('stub: crashing on purpose\n')
    setTimeout(() => process.exit(3), 20)
    await sleep(1000)
    return 'end_turn'
  }
  if (last === 'usage') {
    update(sessionId, { sessionUpdate: 'usage_update', used: 32000, size: 128000 })
    say(sessionId, 'Counted.')
    return { stopReason: 'end_turn', usage: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 } }
  }
  if (last === 'nextsteps') {
    say(sessionId, 'Here you go.\n<next-steps>\nFix comment #1\n- Show the phone layout\n</next-steps>')
    return 'end_turn'
  }
  if (last === 'mode') {
    say(sessionId, mode)
    return 'end_turn'
  }
  if (last === 'config') {
    say(sessionId, JSON.stringify(config))
    return 'end_turn'
  }
  say(sessionId, 'Hello from the ACP stub.')
  return 'end_turn'
}
