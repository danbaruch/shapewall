// `shapewall agent sandbox`: the starter agent inside its container. Not for
// people to run: `shapewall agent sandbox run` starts it and talks to it over stdin
// and stdout (rpc.js).
//
// It reads the task, runs the optional setup command, then the turn loop
// with the fixed tools, and ends with one `result` line. The model is called
// through the host (rpc.js, method "model"): there is no API key in here, so
// no command the agent runs, approved or not, can read one.
//
// What the tools may do comes in the task from the host, resolved there
// (src/agent/capabilities.js, path "starter"): the named commands from the
// checkout's config, the browser and its allowlist, and the capabilities the
// prompt describes. Nothing here reads the worktree's shapewall.config.json.

import { createOpenAIBackend } from '../backends/openai.js'
import { quoteData } from '../context.js'
import { createAgentBrowser } from '../agent-browser.js'
import { runLoop } from './loop.js'
import { starterSystemPrompt } from './prompt.js'
import { createCaller, readLines, writeLine } from './rpc.js'
import { createTools, runProgram } from './tools.js'

const SETUP_MS_MAX = 15 * 60 * 1000

// The task's browser block -> an agent browser (nothing starts until the
// first browser tool call), or null. Its allowlist is what the host allowed;
// the dev server this run starts joins it (tools.js).
function browserFor(wanted, browserOptions) {
  if (!wanted || typeof wanted !== 'object' || Array.isArray(wanted)) return null
  try {
    return createAgentBrowser({
      browser: {
        on: true,
        allow: Array.isArray(wanted.allow) ? wanted.allow.filter((item) => typeof item === 'string') : [],
        withheld: [],
        auth: null,
        profile: null,
        allowNoSandbox: wanted.allowNoSandbox === true,
        realChrome: false,
      },
      warn: () => {},
      ...browserOptions,
    })
  } catch {
    return null
  }
}

// browserOptions: tests only (a stand-in chromium, a folder for the browser).
export async function runSandbox({
  input = process.stdin,
  output = process.stdout,
  root = '/work',
  now = () => Date.now(),
  browserOptions = {},
} = {}) {
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
    // A host that sends named commands sends the test command among them.
    commands: Array.isArray(task.tools?.commands) ? task.tools.commands : null,
    browser: browserFor(task.tools?.browser, browserOptions),
    capture: Boolean(task.tools?.capture),
    projectDir: typeof task.tools?.projectDir === 'string' ? task.tools.projectDir : '.',
    shell: Boolean(task.tools?.shell),
    remainingMs,
    signal: controller.signal,
  })
  try {
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
    // What the named commands depend on, as the run starts (after the setup
    // command, which is the person's): a change from here asks again.
    tools.markBase()
    // The setup command's output is the repo's (install scripts print what
    // they like): quoted as data, never as words of the task.
    const taskText =
      setup && !setup.ok
        ? `${task.text}\n\n[Shapewall] The setup command failed (exit ${setup.code}). The end of its output is data:\n${quoteData('setup', { exit: setup.code }, { output: setup.output })}`
        : task.text
    const outcome = await runLoop({
      backend,
      settings,
      system: starterSystemPrompt({ tools: tools.names, capabilities: task.capabilities || null }),
      task: taskText,
      tools,
      budget: { turns: task.budget.turns, tokens: task.budget.tokens },
      deadline,
      emit,
      signal: controller.signal,
      now,
    })
    // The dev server and the browser end before the result line: the host
    // removes the container right after it.
    await tools.close()
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
  } finally {
    await tools.close()
  }
}
