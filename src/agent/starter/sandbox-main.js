// `shapewall agent sandbox`: the starter agent inside its container. Not for
// people to run: `shapewall agent run` starts it and talks to it over stdin
// and stdout (rpc.js).
//
// It reads the task, runs the optional setup command, then the turn loop
// with the fixed tools, and ends with one `result` line. The model is called
// through the host (rpc.js, method "model"): there is no API key in here, so
// no command the agent runs, approved or not, can read one.

import { createOpenAIBackend } from '../backends/openai.js'
import { runLoop } from './loop.js'
import { starterSystemPrompt } from './prompt.js'
import { createCaller, readLines, writeLine } from './rpc.js'
import { createTools, runProgram } from './tools.js'

const SETUP_MS_MAX = 15 * 60 * 1000

export async function runSandbox({ input = process.stdin, output = process.stdout, root = '/work', now = () => Date.now() } = {}) {
  const caller = createCaller(output)
  const controller = new AbortController()
  const task = await new Promise((resolve, reject) => {
    let first = true
    readLines(input, (message) => {
      if (first) {
        first = false
        if (message.t !== 'task') reject(new Error('the first message must be the task'))
        else resolve(message)
        return
      }
      if (['answer', 'head', 'chunk', 'end'].includes(message.t)) caller.handle(message)
      else if (message.t === 'stop') {
        controller.abort(message.reason || 'stopped')
        caller.cancel('the run was stopped')
      }
    })
    input.on('end', () => {
      if (first) reject(new Error('no task on stdin'))
      controller.abort('stopped')
      caller.cancel('the run was stopped')
    })
  })
  const emit = (event) => writeLine(output, { t: 'event', ...event })
  const started = now()
  const deadline = started + Math.max(1000, Number(task.budget?.wallMs) || 60000)
  const remainingMs = () => Math.max(1000, deadline - now())
  const settings = {
    // Not reached: the host sends the request to the endpoint it was configured with.
    baseUrl: 'http://model.shapewall.invalid/v1',
    model: task.model.model,
    keyVar: null,
    tools: true,
    vision: false,
    usage: true,
    temperature: task.model.temperature ?? null,
    answerTokens: task.model.maxTokens || null,
    maxTokens: null,
    // The host times each call (and retries it once), and always ends it.
    connectTimeoutMs: 0,
  }
  const backend = createOpenAIBackend(settings, { env: {}, fetchImpl: caller.fetch })
  const tools = createTools({
    root,
    rpc: caller,
    testCommand: task.tools?.testCommand || null,
    capture: Boolean(task.tools?.capture),
    projectDir: typeof task.tools?.projectDir === 'string' ? task.tools.projectDir : '.',
    shell: Boolean(task.tools?.shell),
    remainingMs,
    signal: controller.signal,
  })
  let setup = null
  if (task.tools?.setupCommand) {
    emit({ type: 'tool', id: 'setup', name: 'setup', label: 'Set up the project', state: 'running' })
    const result = await runProgram(task.tools.setupCommand, {
      cwd: root,
      timeoutMs: Math.min(SETUP_MS_MAX, remainingMs()),
      signal: controller.signal,
    })
    setup = { ok: result.code === 0, code: result.code, output: result.output.slice(-4000) }
    emit({
      type: 'tool',
      id: 'setup',
      name: 'setup',
      label: 'Set up the project',
      state: setup.ok ? 'done' : 'error',
      detail: setup.ok ? 'done' : `exit ${result.code}`,
    })
  }
  const taskText =
    setup && !setup.ok
      ? `${task.text}\n\n[Shapewall] The setup command failed (exit ${setup.code}). Its output ends:\n${setup.output}`
      : task.text
  const outcome = await runLoop({
    backend,
    settings,
    system: starterSystemPrompt({ tools: tools.names }),
    task: taskText,
    tools,
    budget: { turns: task.budget.turns, tokens: task.budget.tokens },
    deadline,
    emit,
    signal: controller.signal,
    now,
  })
  writeLine(output, {
    t: 'result',
    stop: outcome.stop,
    text: outcome.text,
    error: outcome.error || null,
    usage: outcome.usage,
    status: tools.state.status,
    statusNote: tools.state.statusNote,
    changed: [...tools.state.changed],
    setup: setup ? { ok: setup.ok, code: setup.code } : null,
    ms: now() - started,
  })
  return outcome
}
