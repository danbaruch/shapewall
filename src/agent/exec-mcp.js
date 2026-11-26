// `exec-mcp`: the tools through which an agent runs things on a board
// (plan section 3.4): named commands from the project's config, a shell
// (solo, in the OS sandbox) or exact commands (a card each), the session's
// dev server, and what it may do here. Internal (docs/stability.md): not in
// help, and nothing but Shapewall starts it.
//
// Two halves:
//   the tool host   (createToolHost) runs inside the Shapewall process that
//                   runs the turn. Every check is here: the resolved
//                   capabilities (src/agent/capabilities.js, never widened),
//                   the approval records (command-approvals.js), the cards,
//                   the sandbox (sandbox-exec.js), the output and time caps.
//   the relay       (this file run as a program, `node exec-mcp.js FILE`)
//                   is the stdio MCP server the agent's adapter starts from
//                   session/new's mcpServers. It knows nothing: it lists the
//                   tools the policy FILE names and passes each call to the
//                   host over a private socket, with the one-time token from
//                   that FILE. The FILE is 0600 in a 0700 folder, and both go
//                   when the session ends.
//
// The agent's own shell stays off (acp.js remoteEditSession). A command runs
// here, in Shapewall, or not at all.
//
// Tools beyond these (Q3's browser_*) plug in through registerTools(): one
// factory per family, (host) => [tool], each tool { name, description,
// inputSchema, call(args, { signal }) }. Only tools whose factory returns
// them for this host's capabilities are listed or callable.

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { splitCommand } from '../watch.js'
import { agentRunEnvEntries } from '../agent-run.js'
import { inputsDigest } from './command-approvals.js'
import { SANDBOX_LIMITS, SandboxRefusal, createCommandSession } from './sandbox-exec.js'
import { toPrompt } from './capability-render.js'
import { showCommand } from './starter/approvals.js'

export const EXEC_MCP_NAME = 'shapewall_exec'
export const EXEC_TOOL_PREFIX = `mcp__${EXEC_MCP_NAME}__`
export const EXEC_LIMITS = {
  args: 20,
  argBytes: 200,
  reasonBytes: 500,
  commandBytes: 2000,
  devServers: 2,
  readyMs: 60_000,
  callBytes: 256 * 1024,
  snapshotFiles: 20000,
}
const PORT_TOKEN = '$PORT'
const SKIP_DIRS = new Set(['.git', 'node_modules', '.shapewall', 'shapewall-export'])
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

const text = (value) => ({ content: [{ type: 'text', text: value }] })
const failure = (value) => ({ content: [{ type: 'text', text: value }], isError: true })

// ---- Tool families (registerTools) ----

const FACTORIES = []
// Adds a family of tools to every tool host made after this: (host) => [tool].
export function registerTools(factory) {
  if (typeof factory !== 'function') throw new Error('registerTools takes a factory: (host) => [tool].')
  if (!FACTORIES.includes(factory)) FACTORIES.push(factory)
}
// Q3: the browser tools (src/agent/agent-browser.js) register here, one line:
//   registerTools(browserTools)

// ---- Files a command changed ----

// path -> signature (size, mtime, inode, mode) of the files of a folder.
function snapshot(root) {
  const out = new Map()
  const stack = ['']
  while (stack.length && out.size < EXEC_LIMITS.snapshotFiles) {
    const rel = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(child)
        continue
      }
      try {
        const stat = fs.lstatSync(path.join(root, child))
        out.set(child, `${stat.size}:${stat.mtimeMs}:${stat.ino}:${stat.mode}`)
      } catch {
        /* gone meanwhile */
      }
    }
  }
  return out
}
function changes(before, after) {
  const changed = []
  const deleted = []
  for (const [rel, sig] of after) if (before.get(rel) !== sig) changed.push(rel)
  for (const rel of before.keys()) if (!after.has(rel)) deleted.push(rel)
  return { changed, deleted }
}

// ---- What a card shows ----

export function showCommandLine(argv) {
  return showCommand(argv.map((part) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)).join(' '))
}
// Where a command runs, in words, for its card.
function whereText(session) {
  if (!session) return 'Nowhere: no session.'
  if (session.mode === 'host-shell')
    return "On the agent's machine, in the fix copy, WITHOUT an OS sandbox (its owner chose --shell-unsandboxed): it can read and write what that person can."
  if (session.mode === 'sandboxed')
    return `In the fix copy, in the OS sandbox: it writes only there${session.readOnly ? ' (here not even there: read only)' : ''}, cannot read the home folder, and reaches ${
      session.network === 'open' ? 'any public host' : session.network === 'registries' ? 'the package registries only' : 'no network'
    }${session.ports().length ? ` and this session's dev server` : ''}.`
  return "On the agent's machine, in the fix copy, without an OS sandbox (none on this machine): it can read and write what the person who connected the agent can."
}
// Runners that run whatever they are given: arguments to them are code.
const RUNNERS_RE = /^(npx|pnpx|bunx|jest|vitest|mocha|ava|tap|node|deno|bun|python3?|ruby|perl|sh|bash|make|npm|pnpm|yarn)$/i
export function argsWarning(command) {
  if (!command.args) return null
  const program = path.basename(String(command.argv?.[0] || '')).replace(/\.(exe|cmd|bat)$/i, '')
  const which = RUNNERS_RE.test(program) && !/^(npx|jest)$/i.test(program) ? program + ', as for npx, jest' : 'npx, jest'
  return (
    'This command takes extra arguments from the agent ("args": true). For ' +
    which +
    " and similar runners an argument can name any script or package: allowing it is allowing arbitrary code in this command's place."
  )
}

function resultText({ label, run }) {
  const head = run.stopped
    ? `${label}: stopped.`
    : run.timedOut
      ? `${label}: stopped after ${Math.round(run.ms / 1000)} s (the time limit).`
      : `${label}: exit code ${run.code === null ? `none (${run.signal || 'did not start'})` : run.code}, ${run.ms} ms.`
  const cut = run.cut ? `\n[... ${run.cut} more bytes of output not kept: the limit is ${SANDBOX_LIMITS.outputBytes / 1024} KB]` : ''
  return `${head}\n${run.output}${cut}`
}

// ---- The tool host ----

// createToolHost({ ... }) -> { tools(), call(name, args, { signal }), devPorts(), close() }
//   capabilities  the resolved object of this turn (resolveCapabilities)
//   recheck       () => the capabilities resolved again now (for card answers and before each run)
//   commands      the named commands of the CHECKOUT's config (capabilities.js namedCommands)
//   readCommands  () => the same, read again from the checkout now
//   session       the command session (sandbox-exec.js createCommandSession), or null
//   approvals     the approval store (command-approvals.js createApprovalStore)
//   scope         what approval keys are bound to (the project and connection)
//   ask           async (card) => 'approved' | 'denied' | 'expired' | 'cancelled'; null: no cards
//   onChanged     ({ changed, deleted }) => void: files a command changed in the fix copy
export function createToolHost({
  capabilities,
  recheck = () => capabilities,
  commands = [],
  readCommands = () => commands,
  session = null,
  approvals = null,
  scope = '',
  ask = null,
  // The machine asks before every command (commandApproval "always"): the full shell too.
  shellCard = false,
  onChanged = () => {},
  log = () => {},
}) {
  const caps = capabilities
  // A card's text within what a card may hold (card-hash.js CARD_LIMITS.detail).
  const askCard = (card) => ask({ ...card, detail: card.detail.length > 4000 ? card.detail.slice(0, 3990) + '\n[...]' : card.detail })
  const devServers = new Map()
  let closed = false
  // The inputs as the fix copy started (the base commit, the person's own):
  // on solo and team turns a command whose inputs are still those runs
  // without a card. Worked out once, before the agent can change anything.
  const base = new Map()
  if (session)
    for (const command of commands)
      if (caps.commands.some((item) => item.name === command.name)) {
        try {
          base.set(command.name, inputsDigest(session.root, command))
        } catch {
          /* no base: it asks */
        }
      }

  const allowedNow = (name) => {
    const fresh = recheck()
    return Boolean(fresh && fresh.commands.some((item) => item.name === name))
  }
  const sameLine = (command) => readCommands().some((item) => item.name === command.name && item.run === command.run)

  // One named command, with the agent's args when it takes them, decided: the
  // argv to run, or a refusal in words.
  function namedArgv(name, args, { port = null } = {}) {
    const resolved = caps.commands.find((item) => item.name === name)
    const command = commands.find((item) => item.name === name)
    if (!resolved || !command)
      return {
        error: `"${name}" is not a command you can run here. You can run: ${caps.commands.map((item) => item.name).join(', ') || 'none'}.`,
      }
    let extra = []
    if (args !== undefined && args !== null) {
      if (!command.args) return { error: `"${name}" takes no arguments (its config line is run as it is).` }
      if (
        !Array.isArray(args) ||
        args.length > EXEC_LIMITS.args ||
        args.some((item) => typeof item !== 'string' || !item || item.length > EXEC_LIMITS.argBytes || item.includes('\0'))
      )
        return { error: `args: up to ${EXEC_LIMITS.args} strings of up to ${EXEC_LIMITS.argBytes} characters.` }
      extra = args
    }
    let argv = [...command.argv, ...extra]
    if (argv.some((part) => part.includes(PORT_TOKEN))) {
      if (!port) return { error: `"${name}" needs a port: start it with start_dev_server.` }
      argv = argv.map((part) => part.split(PORT_TOKEN).join(String(port)))
    }
    return { command, resolved, argv }
  }

  // Whether a named command may run as it is now, asking on the board when it must.
  async function mayRun({ command, resolved, argv, label }) {
    if (!session) return 'No fix copy to run it in.'
    const digest = inputsDigest(session.root, { ...command, argv })
    const entry = { scope, name: command.name, run: showCommandLine(argv), inputs: digest }
    // Outside the OS sandbox (mode "host": Windows, no bubblewrap) nothing contains a
    // command, so it always asks, whatever the resolver said (plan 3.5).
    const fromBase =
      session.mode !== 'host' && !resolved.needsCard && base.get(command.name) === digest && argv.length === command.argv.length
    if (fromBase || approvals?.has(entry)) return null
    if (!ask) return `"${command.name}" needs someone to allow it on the board, and this agent's machine takes no answers from the board.`
    const changedInputs = base.has(command.name) && base.get(command.name) !== digest
    const lines = [
      showCommandLine(argv),
      '',
      whereText(session),
      ...(changedInputs
        ? ['', 'Asked again: the agent changed a file this command depends on (a manifest, lockfile, config or script it names).']
        : []),
      ...(resolved.needsCard && caps.tier === 'open'
        ? ['', 'Asked because someone outside the people this machine trusts wrote in this thread.']
        : []),
      ...(argsWarning(command) ? ['', argsWarning(command)] : []),
    ]
    const recheckCard = () => allowedNow(command.name) && sameLine(command) && inputsDigest(session.root, { ...command, argv }) === digest
    const state = await askCard({ name: 'command', label, detail: lines.join('\n'), recheck: recheckCard })
    if (state !== 'approved')
      return `Not run: ${state === 'denied' ? 'it was denied on the board' : state === 'expired' ? 'nobody answered in time' : 'stopped'}.`
    // Once more, now: the answer was for this line with these inputs, still allowed.
    if (!recheckCard()) return 'Not run: it changed, or is no longer allowed, since it was asked.'
    approvals?.remember(entry)
    return null
  }

  async function runTracked(what, options) {
    const mutating = options.mutating !== false && !session.readOnly
    const before = mutating ? snapshot(session.root) : null
    let run
    try {
      run = await session.run(what, options)
    } finally {
      if (before) {
        const diff = changes(before, snapshot(session.root))
        if (diff.changed.length || diff.deleted.length) onChanged(diff)
      }
    }
    return run
  }

  const builtin = [
    {
      name: 'shapewall_capabilities',
      description:
        'What you can do on this board on this turn: who you work for, your tools, the commands you can run, the shell, the browser, approvals and where fixes land. Call it when someone asks what you can do here.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => text(`${toPrompt(caps)}\n\n${JSON.stringify(caps, null, 2)}`),
    },
    {
      name: 'run_named_command',
      description:
        "Runs one of the project's named commands (from its shapewall.config.json `commands`, such as test, build, lint) in your working folder, through Shapewall. Some ask a person on the board first; changing a file a command depends on asks again. Output is capped at 64 KB.",
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: caps.commands.map((item) => item.name), description: 'The command name' },
          args: {
            type: 'array',
            items: { type: 'string', maxLength: EXEC_LIMITS.argBytes },
            maxItems: EXEC_LIMITS.args,
            description: 'Extra arguments, only for a command whose config says "args": true',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      available: () => caps.commands.length > 0,
      async call({ name, args } = {}, { signal } = {}) {
        if (!allowedNow(name)) return failure(`"${name}" is not allowed on this turn.`)
        const picked = namedArgv(String(name || ''), args, { port: [...devServers.values()][0]?.port || null })
        if (picked.error) return failure(picked.error)
        const refused = await mayRun({ ...picked, label: `Run ${picked.command.name}` })
        if (refused) return failure(refused)
        if (!allowedNow(picked.command.name)) return failure('Not run: it is no longer allowed on this turn.')
        const run = await runTracked(picked.argv, { mutating: picked.command.mutating, signal })
        return { ...text(resultText({ label: picked.command.name, run })), isError: run.code !== 0 }
      },
    },
    {
      name: 'run_command',
      description:
        caps.shell.mode === 'sandboxed' || caps.shell.mode === 'unsandboxed'
          ? 'Runs a shell command line in your working folder (the fix copy), in the OS sandbox: it can write only there and cannot read the home folder; the network is limited. Output is capped at 64 KB.'
          : `Runs one of exactly these commands, each only after a person allows it on the board, without a shell: ${caps.shell.exact.join(' | ')}`,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', maxLength: EXEC_LIMITS.commandBytes, description: 'The command line' },
          reason: { type: 'string', maxLength: EXEC_LIMITS.reasonBytes, description: 'Why, in one sentence (shown on a card)' },
        },
        required: ['command', 'reason'],
        additionalProperties: false,
      },
      available: () => ['sandboxed', 'unsandboxed', 'exact'].includes(caps.shell.mode),
      async call({ command, reason } = {}, { signal } = {}) {
        const line = typeof command === 'string' ? command.trim() : ''
        const why = typeof reason === 'string' ? reason.trim().slice(0, EXEC_LIMITS.reasonBytes) : ''
        if (!line || line.length > EXEC_LIMITS.commandBytes || line.includes('\0')) return failure('command: one command line.')
        if (!session) return failure('No fix copy to run it in.')
        const fresh = recheck()
        if (!fresh || fresh.shell.mode !== caps.shell.mode) return failure('Not run: the shell is no longer allowed on this turn.')
        if (caps.shell.mode === 'exact') {
          if (!caps.shell.exact.includes(line))
            return failure(`Not one of the commands this machine allows (character for character): ${caps.shell.exact.join(' | ')}`)
          let argv
          try {
            argv = splitCommand(line, 'command')
          } catch (error) {
            return failure(error.message)
          }
          if (!ask) return failure('This command needs someone to allow it on the board, and this machine takes no answers from the board.')
          const state = await askCard({
            name: 'command',
            label: 'Run a command',
            detail: `${showCommandLine(argv)}\n\nWhy: ${why || '(no reason given)'}\n\n${whereText(session)}`,
            recheck: () => {
              const now = recheck()
              return Boolean(now && now.shell.mode === 'exact' && now.shell.exact.includes(line))
            },
          })
          if (state !== 'approved') return failure(`Not run: ${state === 'denied' ? 'it was denied on the board' : 'nobody allowed it'}.`)
          const run = await runTracked(argv, { signal })
          return { ...text(resultText({ label: line, run })), isError: run.code !== 0 }
        }
        // The full shell: solo (or the team with --trust-team-shell), in the sandbox
        // (or, where the owner insisted with --shell-unsandboxed, without one).
        if (caps.shell.mode === 'unsandboxed' && session.mode !== 'host-shell')
          return failure('Not run: no OS sandbox here, and the machine did not allow commands without one.')
        if (caps.shell.mode === 'sandboxed' && session.mode !== 'sandboxed') return failure('Not run: the OS sandbox did not start.')
        if (shellCard) {
          if (!ask) return failure('This machine asks before every command, and takes no answers from the board.')
          const state = await askCard({
            name: 'command',
            label: 'Run a shell command',
            detail: `${line}\n\nWhy: ${why || '(no reason given)'}\n\n${whereText(session)}`,
            recheck: () => recheck()?.shell?.mode === caps.shell.mode,
          })
          if (state !== 'approved') return failure('Not run: nobody allowed it.')
        }
        let run
        try {
          run = await runTracked({ shell: line }, { signal })
        } catch (error) {
          if (error instanceof SandboxRefusal) return failure(error.message)
          throw error
        }
        return { ...text(resultText({ label: 'command', run })), isError: run.code !== 0 }
      },
    },
    {
      name: 'start_dev_server',
      description:
        "Starts the project's named dev server (its `dev` command) on a free port in your working folder and waits until it answers. Your commands (and browser, when you have one) may reach it on that port for this session.",
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The command name (default "dev")' } },
        additionalProperties: false,
      },
      available: () => caps.commands.some((item) => item.name === 'dev' || commands.find((c) => c.name === item.name)?.ready),
      async call({ name = 'dev' } = {}) {
        const id = String(name || 'dev')
        if (devServers.has(id)) return text(`${id} is already running on port ${devServers.get(id).port}.`)
        if (devServers.size >= EXEC_LIMITS.devServers)
          return failure(`At most ${EXEC_LIMITS.devServers} dev servers at a time: stop one first.`)
        if (!allowedNow(id)) return failure(`"${id}" is not allowed on this turn.`)
        const port = await freePort()
        const picked = namedArgv(id, null, { port })
        if (picked.error) return failure(picked.error)
        const refused = await mayRun({ ...picked, label: `Start ${id}` })
        if (refused) return failure(refused)
        if (closed) return failure('The session has ended.')
        const server = { port, kill: () => {}, done: null, output: '' }
        session.allowPort(port)
        server.done = session
          .run(picked.argv, {
            timeoutMs: SANDBOX_LIMITS.timeoutMaxMs,
            extraEnv: { PORT: String(port) },
            onStart: ({ kill }) => (server.kill = kill),
          })
          .then((run) => {
            server.output = run.output
            server.exited = true
            session.dropPort(port)
            devServers.delete(id)
            return run
          })
        devServers.set(id, server)
        const ready = picked.command.ready ? picked.command.ready.split(PORT_TOKEN).join(String(port)) : `http://127.0.0.1:${port}`
        const up = await waitReady(ready, server)
        if (!up) {
          server.kill()
          await server.done
          return failure(`${id} did not answer on ${ready} within ${EXEC_LIMITS.readyMs / 1000} s.\n${server.output.slice(-4000)}`)
        }
        return text(`${id} is up on ${ready} (port ${port}). Stop it with stop_dev_server when you are done.`)
      },
    },
    {
      name: 'stop_dev_server',
      description: 'Stops a dev server this session started.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
      available: () => caps.commands.some((item) => item.name === 'dev' || commands.find((c) => c.name === item.name)?.ready),
      async call({ name = 'dev' } = {}) {
        const server = devServers.get(String(name || 'dev'))
        if (!server) return text('No such dev server is running.')
        server.kill()
        await server.done
        return text(`${name} stopped.`)
      },
    },
  ]

  const host = {
    capabilities: caps,
    session,
    devPorts: () => [...devServers.values()].map((server) => server.port),
    log,
  }
  const all = [...builtin, ...FACTORIES.flatMap((factory) => factory(host) || [])]
  const listed = all.filter((tool) => (tool.available ? tool.available() : true))
  const byName = new Map(listed.map((tool) => [tool.name, tool]))
  return {
    ...host,
    tools: () => listed.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    async call(name, args, { signal } = {}) {
      if (closed) return failure('This session has ended.')
      const tool = byName.get(String(name))
      if (!tool) return failure(`No tool "${name}" here.`)
      try {
        return await tool.call(args && typeof args === 'object' && !Array.isArray(args) ? args : {}, { signal })
      } catch (error) {
        log(`exec-mcp: ${name}: ${error.message}`)
        return failure(error instanceof SandboxRefusal ? error.message : `${name} failed on the agent's machine.`)
      }
    },
    async close() {
      closed = true
      for (const server of devServers.values()) server.kill()
      await Promise.allSettled([...devServers.values()].map((server) => server.done))
    },
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}
async function waitReady(url, server) {
  const until = Date.now() + EXEC_LIMITS.readyMs
  while (Date.now() < until && !server.exited) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
      await response.body?.cancel()
      if (response.status < 500) return true
    } catch {
      /* not yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

// One turn's exec tools, whole: the command session in the fix copy, the tool
// host over it, and the relay entry for session/new. -> { host, session,
// servers, close() }, or null when nothing would be offered (no commands, no
// shell) or the sandbox the capabilities count on did not start: then the
// turn runs without exec tools (fail closed), and says why in the log.
//
//   capabilities  the turn's resolved object; platform: hostPlatform(), the same one it was resolved with
//   root          the fix copy; expect: the same folder, as Shapewall made it; within: the fix-copy parent
//   checkout      the person's own checkout (never writable, never the root)
export async function startExecSession({
  capabilities,
  platform,
  recheck,
  commands = [],
  readCommands,
  root,
  expect = root,
  within = null,
  checkout = null,
  readOnly = false,
  readPaths = [],
  network = 'none',
  approvals = null,
  scope = '',
  ask = null,
  shellCard = false,
  onChanged,
  env = process.env,
  log = () => {},
}) {
  const caps = capabilities
  if (!caps || (!caps.commands.length && caps.shell.mode === 'off')) return null
  const mode = platform?.sandbox ? 'sandboxed' : caps.shell.mode === 'unsandboxed' ? 'host-shell' : 'host'
  // The resolver counted on the sandbox for the full shell: no sandbox, no shell.
  if (caps.shell.mode === 'sandboxed' && mode !== 'sandboxed') return null
  let session
  try {
    session = await createCommandSession({ root, expect, within, checkout, network, readOnly, mode, readPaths, env, log })
  } catch (error) {
    log(`exec-mcp: no command session: ${error.message}`)
    return null
  }
  const host = createToolHost({
    capabilities: caps,
    recheck,
    commands,
    readCommands,
    session,
    approvals,
    scope,
    ask,
    shellCard,
    onChanged,
    log,
  })
  let served
  try {
    served = await serveToolHost(host, { env, log })
  } catch (error) {
    log(`exec-mcp: the tool host did not start: ${error.message}`)
    await host.close()
    session.close()
    return null
  }
  let closed = false
  return {
    host,
    session,
    servers: served.servers,
    async close() {
      if (closed) return
      closed = true
      await host.close()
      await served.close().catch(() => {})
      session.close()
    },
  }
}

// ---- The private channel between the relay and the host ----

// Serves one tool host to its relay: a socket only this process and the
// relay know (a fresh 0700 folder; a named pipe on Windows), a one-time
// token, and the policy file the relay reads them from.
// -> { servers: the mcpServers entry for session/new, close() }
export async function serveToolHost(host, { env = process.env, log = () => {} } = {}) {
  const token = randomBytes(32)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-exec-'))
  fs.chmodSync(dir, 0o700)
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\shapewall-exec-${randomBytes(12).toString('hex')}` : path.join(dir, 's')
  const connections = new Set()
  const server = net.createServer((conn) => {
    connections.add(conn)
    const controller = new AbortController()
    let buffer = ''
    conn.setEncoding('utf8')
    conn.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > EXEC_LIMITS.callBytes) return conn.destroy()
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        let message
        try {
          message = JSON.parse(line)
        } catch {
          return conn.destroy()
        }
        const given = Buffer.from(String(message?.token || ''), 'hex')
        if (given.length !== token.length || !timingSafeEqual(given, token)) {
          log('exec-mcp: a call without the session token was refused')
          return conn.destroy()
        }
        Promise.resolve(host.call(message.name, message.args, { signal: controller.signal })).then(
          (result) => conn.writable && conn.write(`${JSON.stringify({ id: message.id, result })}\n`),
          () => conn.writable && conn.write(`${JSON.stringify({ id: message.id, result: failure('The call failed.') })}\n`),
        )
      }
    })
    conn.on('close', () => {
      connections.delete(conn)
      controller.abort()
    })
    conn.on('error', () => {})
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  if (process.platform !== 'win32') fs.chmodSync(socket, 0o600)
  const policy = path.join(dir, 'policy.json')
  fs.writeFileSync(policy, `${JSON.stringify({ v: 1, socket, token: token.toString('hex'), tools: host.tools() })}\n`, {
    mode: 0o600,
    flag: 'wx',
  })
  return {
    dir,
    servers: [
      {
        name: EXEC_MCP_NAME,
        command: process.execPath,
        args: [fileURLToPath(import.meta.url), policy],
        env: [...agentRunEnvEntries(), ...(env.PATH ? [{ name: 'PATH', value: env.PATH }] : [])],
      },
    ],
    async close() {
      for (const conn of connections) conn.destroy()
      await new Promise((resolve) => server.close(() => resolve()))
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

// ---- The relay (run as a program) ----

async function relay(file) {
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'))
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js')
  const conn = net.connect(policy.socket)
  conn.setEncoding('utf8')
  const waiting = new Map()
  let next = 1
  let buffer = ''
  conn.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      try {
        const message = JSON.parse(line)
        waiting.get(message.id)?.(message.result)
        waiting.delete(message.id)
      } catch {
        /* not ours */
      }
    }
  })
  const gone = () => {
    for (const resolve of waiting.values()) resolve(failure('Shapewall ended this session.'))
    waiting.clear()
    process.exit(0)
  }
  conn.on('close', gone)
  conn.on('error', gone)
  const server = new Server({ name: EXEC_MCP_NAME, version: '1' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: policy.tools }))
  server.setRequestHandler(
    CallToolRequestSchema,
    (request) =>
      new Promise((resolve) => {
        const id = next++
        waiting.set(id, resolve)
        conn.write(`${JSON.stringify({ id, token: policy.token, name: request.params.name, args: request.params.arguments || {} })}\n`)
      }),
  )
  await server.connect(new StdioServerTransport())
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  relay(process.argv[2]).catch((error) => {
    process.stderr.write(`shapewall exec-mcp: ${error.message}\n`)
    process.exit(1)
  })
}

export const _test = { snapshot, changes, sha256 }
