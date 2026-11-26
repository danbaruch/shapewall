// The starter agent's tools, run inside the container. A fixed set: read,
// search and edit files in the worktree, run the configured test command and
// the project's other named commands (`commands` in the checkout's
// shapewall.config.json: build, dev, lint, ...; never read from the
// worktree), the throwaway browser (src/agent/agent-browser.js, limited to
// what the host allowed plus the dev server this run started), `shapewall
// capture`, reply on the comment, set its status, and (only with the person's
// approval of each command, on the board) run a shell command.
//
// A named command runs code from the project, so it asks a person first
// when the agent changed a file it depends on (testInput, its `inputs`), when
// a shell command ran, when a file it depends on changed since the run
// started, or on every run when someone outside the trusted people wrote in
// the comment (needsCard, from the resolved capabilities).
//
// Every path goes through the ACP bridge's sandbox (src/agent/acp/sandbox.js):
// resolved after symlinks, refused outside the worktree, and writes refused
// in .git. Reads of .git are refused too (in a worktree it only points at
// the host's repository). The container is the outer wall; this is the
// inner one, so a tool call that names a file outside is refused, not tried.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as z from 'zod'
import { createSandbox, inside } from '../acp/sandbox.js'
import { inputsDigest } from '../command-approvals.js'
import { ownsPort } from '../dev-server.js'
import { browserTools } from '../agent-browser.js'

export const TOOL_OUTPUT_MAX = 16000
const READ_CHARS_MAX = 100000
const LIST_MAX = 400
const SEARCH_MATCHES_MAX = 100
const SEARCH_FILE_BYTES_MAX = 1024 * 1024
const SEARCH_FILES_MAX = 20000
const COMMAND_OUTPUT_MAX = 64 * 1024
const COMMAND_MS_MAX = 10 * 60 * 1000
const SKIP_DIRS = new Set(['.git', 'node_modules', '.shapewall', 'shapewall-export'])
// Files that decide what a test command runs: manifests, lockfiles, test and
// build configs, and the files the command names.
const TEST_INPUT_RE =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.yarnrc(\.yml)?|\.nvmrc|\.mocharc(\.[a-z]+)?|\.babelrc(\.[a-z]+)?|babel\.config\.[a-z]+|(jest|vitest|vite|playwright|karma|ava|cypress|webpack|rollup|esbuild|nyc|c8)\.config\.[a-z.]+|\.c8rc(\.json)?|\.nycrc(\.[a-z]+)?|tsconfig(\.[a-z.]+)?\.json|\.taprc|pytest\.ini|conftest\.py|setup\.cfg|setup\.py|tox\.ini|noxfile\.py|pyproject\.toml|makefile|justfile|\.env(\..*)?)$/i
export function testInput(file, testCommand = []) {
  if (TEST_INPUT_RE.test(file)) return true
  return testCommand.some((part) => {
    if (!/[/\\]|\.(c|m)?[jt]s$|\.(py|sh|rb|pl)$/.test(part) || path.isAbsolute(part)) return false
    return path.posix.normalize(part.replace(/\\/g, '/')).replace(/^\.\//, '') === file
  })
}

// A project-relative glob from a command's `inputs` ("test/**", "src/*.js")
// as a RegExp; the same reading as src/agent/command-approvals.js.
function globRe(glob) {
  let out = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        out += '(?:.*/)?'
        index += 2
      } else {
        out += '.*'
        index += 1
      }
    } else if (char === '*') out += '[^/]*'
    else if (char === '?') out += '[^/]'
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

// Whether `file` (project-relative) decides what a named command runs: a
// manifest, lockfile or config (testInput), a file its argv names, or one
// its `inputs` list.
export function commandInput(file, command) {
  if (testInput(file, command.argv)) return true
  return Array.isArray(command.inputs) && command.inputs.some((glob) => typeof glob === 'string' && globRe(glob).test(file))
}

export const PORT_TOKEN = '$PORT'
const NAMED_ARGS_MAX = 20
const NAMED_ARG_BYTES = 200
const DEV_READY_MS = 60_000

// The named commands a run gets, as the host sends them (from the checkout's
// config, kept to what the resolved capabilities allow), checked again here:
// [{ name, argv, inputs, mutating, args, ready, needsCard }].
export function cleanTaskCommands(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== 'object' || !/^[a-z][a-z0-9-]{0,31}$/.test(item.name)) continue
    if (!Array.isArray(item.argv) || !item.argv.length || item.argv.some((part) => typeof part !== 'string')) continue
    if (out.some((known) => known.name === item.name)) continue
    out.push({
      name: item.name,
      argv: [...item.argv],
      inputs: Array.isArray(item.inputs) ? item.inputs.filter((glob) => typeof glob === 'string') : null,
      mutating: item.mutating !== false,
      args: item.args === true,
      ready: typeof item.ready === 'string' ? item.ready : null,
      // Anything but an explicit false asks every time.
      needsCard: item.needsCard !== false,
    })
  }
  return out
}

// A command that serves (the app's dev server): `dev`, or one with a ready URL.
const serves = (command) => command.name === 'dev' || Boolean(command.ready)

// A free port on 127.0.0.1 inside the container, for a dev server.
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

// One plain HTTP request to 127.0.0.1:port, without any proxy (the
// container's proxy variables would send fetch to the egress proxy).
// -> the status code, or null when nothing answers yet.
function probeHttp(port, pathname = '/') {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let data = ''
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(2000, () => done(null))
    socket.once('error', () => done(null))
    socket.on('connect', () => socket.write(`GET ${pathname} HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`))
    socket.on('data', (chunk) => {
      data += chunk
      const match = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(data)
      if (match) done(Number(match[1]))
      else if (data.length > 1024) done(null)
    })
    socket.on('end', () => done(null))
  })
}

// The path of a command's ready URL ($PORT filled in), else "/".
function readyPath(ready, port) {
  if (!ready) return '/'
  try {
    const url = new URL(ready.split(PORT_TOKEN).join(String(port)))
    return `${url.pathname}${url.search}`
  } catch {
    return '/'
  }
}

// Turns an MCP-style zod input shape (agent-browser.js) into the JSON schema
// a model's tool spec takes.
function jsonSchema(shape) {
  const schema = z.toJSONSchema(z.object(shape).strict())
  delete schema.$schema
  return schema
}

export const REPLY_MAX = 2000
export const REPLIES_MAX = 3
export const SHELL_COMMAND_MAX = 2000
const SHAPEWALL_BIN = fileURLToPath(new URL('../../../bin/shapewall.js', import.meta.url))

export class ToolError extends Error {}

// What every capture call answers when the site is not reachable from the
// sandbox (the host decided so before the run, or the capture could not connect).
export const CAPTURE_UNAVAILABLE = 'capture is unavailable in the sandbox; skip it'
// Capture output that means the browser could not reach the site at all.
const UNREACHABLE_RE =
  /net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_FAILED|CONNECTION_TIMED_OUT|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|NETWORK_ACCESS_DENIED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|TIMED_OUT)|\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/
export const captureUnreachable = (output) => UNREACHABLE_RE.test(String(output || ''))
// The worktree is mounted here in the container; models often write it into paths.
const MOUNT = '/work'

const truncate = (text, max = TOOL_OUTPUT_MAX) =>
  text.length > max ? `${text.slice(0, max)}\n[... ${text.length - max} more characters cut]` : text

const tail = (text, max = 8000) => (text.length > max ? `[... ${text.length - max} characters cut]\n${text.slice(-max)}` : text)

// The environment of commands the agent runs: the container's own fixed
// variables (home, caches, proxy), never anything from the host.
export function commandEnv(env = process.env) {
  const keep = [
    'PATH',
    'HOME',
    'TMPDIR',
    'CI',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'https_proxy',
    'http_proxy',
    'NO_PROXY',
    'no_proxy',
    'NODE_USE_ENV_PROXY',
    'npm_config_cache',
    'npm_config_update_notifier',
    'PLAYWRIGHT_BROWSERS_PATH',
    'SHAPEWALL_SANDBOX',
  ]
  const out = { LANG: 'C.UTF-8', FORCE_COLOR: '0', NO_COLOR: '1' }
  for (const name of keep) if (typeof env[name] === 'string') out[name] = env[name]
  return out
}

// Runs argv without a shell; resolves { code, signal, output, timedOut }.
export function runProgram(argv, { cwd, timeoutMs, env = commandEnv(), signal = null }) {
  return new Promise((resolve) => {
    let output = ''
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true })
    } catch (error) {
      resolve({ code: null, signal: null, output: `could not start: ${error.message}`, timedOut: false })
      return
    }
    const collect = (chunk) => {
      output += chunk
      if (output.length > COMMAND_OUTPUT_MAX * 2) output = output.slice(-COMMAND_OUTPUT_MAX)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    let timedOut = false
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    const onAbort = () => kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code: null, signal: null, output: `could not start: ${error.code || error.message}`, timedOut })
    })
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, signal: exitSignal, output: output.slice(-COMMAND_OUTPUT_MAX), timedOut })
    })
  })
}

function commandResult(label, result) {
  const how = result.timedOut
    ? 'was stopped (time limit)'
    : result.code === 0
      ? 'passed (exit 0)'
      : `failed (${result.code === null ? `signal ${result.signal || 'unknown'}` : `exit ${result.code}`})`
  return { text: `${label} ${how}.\n${tail(result.output)}`, detail: `${label} ${how}`, ok: result.code === 0 }
}

const stringArg = (args, name, { optional = false, max = 4096 } = {}) => {
  const value = args?.[name]
  if (value === undefined || value === null) {
    if (optional) return null
    throw new ToolError(`${name} is required`)
  }
  if (typeof value !== 'string') throw new ToolError(`${name} must be a string`)
  if (value.length > max) throw new ToolError(`${name} is longer than ${max} characters`)
  return value
}

// createTools({ root, rpc, testCommand, commands, browser, capture, shell, remainingMs, signal })
// -> { specs, run(call) -> { ok, text, label, detail }, state, markBase(), close() }
//   commands  the named commands (cleanTaskCommands); `test` is run_tests,
//             the others run_named_command. Without it, `testCommand` (argv)
//             is the one command, run without a card while its inputs hold.
//   browser   an agent browser (createAgentBrowser) or null: the browser_* tools.
export function createTools({
  root,
  rpc,
  testCommand = null,
  commands = null,
  browser = null,
  capture = false,
  projectDir = '.',
  shell = false,
  remainingMs = () => COMMAND_MS_MAX,
  signal = null,
}) {
  const sandbox = createSandbox({ root })
  const state = { replies: 0, status: null, statusNote: null, changed: new Set(), shellRan: false, captureUnavailable: false }
  const named = commands
    ? cleanTaskCommands(commands)
    : testCommand
      ? cleanTaskCommands([{ name: 'test', argv: testCommand, inputs: null, mutating: true, needsCard: false }])
      : []
  const testEntry = named.find((command) => command.name === 'test') || null
  const others = named.filter((command) => command.name !== 'test')
  // What each command's inputs were when the run started (after the setup
  // command): a change since, by anything that ran, asks again.
  const base = new Map()
  const markBase = () => {
    base.clear()
    for (const command of named) {
      try {
        base.set(command.name, inputsDigest(sandbox.root, command))
      } catch {
        /* no base: it asks */
      }
    }
  }
  markBase()
  let devServer = null

  // Whether `command` (with `argv`, the line it will run) may run now; asks
  // the person through the approve call when it must. -> null, or the refusal.
  const mayRun = async (command, argv) => {
    const inputs = [...state.changed].filter((file) => commandInput(file, { ...command, argv }))
    let digestChanged = false
    try {
      digestChanged = !base.has(command.name) || base.get(command.name) !== inputsDigest(sandbox.root, { ...command, argv })
    } catch {
      digestChanged = true
    }
    const reasons = []
    if (command.needsCard)
      reasons.push('Someone outside the people trusted on this board wrote in this comment, so each command run is asked.')
    if (inputs.length)
      reasons.push(
        `The agent changed ${inputs.slice(0, 4).join(', ')}${inputs.length > 4 ? ', ...' : ''}, which decide${inputs.length === 1 ? 's' : ''} what the ${command.name === 'test' ? 'test command' : `"${command.name}" command`} runs.`,
      )
    else if (state.shellRan)
      reasons.push(
        `An approved command ran earlier in this run and may have changed what the ${command.name === 'test' ? 'test command' : `"${command.name}" command`} runs.`,
      )
    else if (digestChanged) reasons.push(`A file the "${command.name}" command depends on changed since the run started.`)
    if (!reasons.length) return null
    const why = reasons.join(' ')
    if (!shell) return { text: `Not run: ${why} That needs a person's approval, which this run does not have.`, detail: 'needs approval' }
    const answer = await rpc.call('approve', { command: argv.join(' '), reason: why })
    if (!answer?.approved) return { text: `Not run: ${answer?.error || 'the person did not approve it'}.`, detail: 'not approved' }
    return null
  }

  // The argv of a named command with the agent's args and the dev port, or a ToolError.
  const namedArgv = (command, args, port) => {
    let extra = []
    if (args !== undefined && args !== null) {
      if (!command.args) throw new ToolError(`"${command.name}" takes no arguments (its config line is run as it is)`)
      if (
        !Array.isArray(args) ||
        args.length > NAMED_ARGS_MAX ||
        args.some((item) => typeof item !== 'string' || !item || item.length > NAMED_ARG_BYTES || item.includes('\0'))
      )
        throw new ToolError(`args: up to ${NAMED_ARGS_MAX} strings of up to ${NAMED_ARG_BYTES} characters`)
      extra = args
    }
    let argv = [...command.argv, ...extra]
    if (argv.some((part) => part.includes(PORT_TOKEN))) {
      if (!port) throw new ToolError(`"${command.name}" needs the dev server's port: start the dev server first`)
      argv = argv.map((part) => part.split(PORT_TOKEN).join(String(port)))
    }
    return argv
  }

  // Starts a serving command in the background on a free port in the
  // container, waits until it answers, and gives the agent browser that one
  // port (only when the listener there is the server's own process group).
  const startServer = async (command, args) => {
    if (devServer && !devServer.exited)
      return {
        text: `"${devServer.name}" is already running on http://127.0.0.1:${devServer.port}. Stop it with stop_dev_server first.`,
        detail: 'already running',
      }
    const port = await freePort()
    const argv = namedArgv(command, args, port)
    const refused = await mayRun(command, argv)
    if (refused) return { ...refused, ok: false }
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: sandbox.root,
        env: { ...commandEnv(), PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: true,
      })
    } catch (error) {
      return { text: `"${command.name}" could not start: ${error.message}`, detail: 'could not start', ok: false }
    }
    const server = { name: command.name, port, child, output: '', exited: false, code: null, token: null }
    const collect = (chunk) => {
      server.output += chunk
      if (server.output.length > COMMAND_OUTPUT_MAX * 2) server.output = server.output.slice(-COMMAND_OUTPUT_MAX)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const exited = new Promise((resolve) => {
      child.once('error', (error) => {
        server.output += `could not start: ${error.code || error.message}`
        resolve()
      })
      child.once('close', (code) => resolve(code))
    }).then((code) => {
      server.exited = true
      server.code = code ?? null
    })
    server.stop = async () => {
      if (server.token) browser?.revokeSpawned(server.token)
      server.token = null
      if (!server.exited) {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          /* gone */
        }
        const killer = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            /* gone */
          }
        }, 3000)
        await exited
        clearTimeout(killer)
      }
    }
    devServer = server
    const until = Date.now() + Math.min(DEV_READY_MS, remainingMs())
    let ready = false
    while (!ready && !server.exited && Date.now() < until && !signal?.aborted) {
      const status = await probeHttp(port, readyPath(command.ready, port))
      if (status !== null && status < 500) ready = true
      else await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!ready) {
      const why = server.exited ? `exited (${server.code === null ? 'no exit code' : `exit ${server.code}`})` : 'did not answer in time'
      await server.stop()
      devServer = null
      return { text: `"${command.name}" ${why}.\n${tail(server.output)}`, detail: why, ok: false }
    }
    let browserText = ''
    if (browser && !browser.disposed) {
      if (!ownsPort(port, child.pid))
        browserText =
          ' Your browser tools do not get it: Shapewall could not check that the server is what listens on 127.0.0.1 there (bind 127.0.0.1:$PORT).'
      else {
        try {
          server.token = browser.registerSpawned(port)
          await browser.allowSessionOrigin(server.token)
          browserText = ` Your browser tools can open http://127.0.0.1:${port}.`
        } catch (error) {
          server.token = null
          browserText = ` Your browser tools do not get it: ${error.message}`
        }
      }
    }
    return {
      text: `"${command.name}" is running on http://127.0.0.1:${port} in the sandbox.${browserText}\n${tail(server.output, 2000)}`,
      detail: `running on port ${port}`,
    }
  }
  const stopServer = async () => {
    const server = devServer
    devServer = null
    if (server) await server.stop()
    return server
  }

  // A path from the model, relative to the worktree. Small models often
  // write the mount point into it: "/work/src/x", and (when the repo has no
  // top-level "work") "work/src/x", both mean "src/x". Mapped onto the tool
  // root, not onto /work itself, so it means the same wherever the root is.
  const hasWorkEntry = () => {
    try {
      fs.lstatSync(path.join(sandbox.root, 'work'))
      return true
    } catch {
      return false
    }
  }
  const mapPath = (raw) => {
    const posix = raw.replace(/\\/g, '/')
    if (path.isAbsolute(raw)) {
      const absolute = path.resolve(raw)
      if (inside(sandbox.root, absolute)) return absolute
      if (posix === MOUNT || posix.startsWith(`${MOUNT}/`)) return path.resolve(sandbox.root, `.${posix.slice(MOUNT.length)}`)
      return absolute
    }
    if ((posix === 'work' || posix.startsWith('work/')) && !hasWorkEntry()) return path.resolve(sandbox.root, `.${posix.slice(4)}`)
    return path.resolve(sandbox.root, raw)
  }
  const shown = (absolute) => (path.relative(sandbox.root, absolute) || '.').split(path.sep).join('/')
  // mustExist: a plain "not found" that says how paths work, not an error code.
  const resolvePath = (value, { write = false, mustExist = false } = {}) => {
    const raw = stringArg({ value }, 'value', { max: 1000 })
    if (raw.includes('\0')) throw new ToolError('bad path')
    const absolute = mapPath(raw)
    let real
    try {
      real = sandbox.resolve(absolute, { write })
    } catch (error) {
      throw new ToolError(`refused: ${error.message.replace(sandbox.root, 'the worktree')}`)
    }
    if (!write && inside(path.join(sandbox.root, '.git'), real)) throw new ToolError('refused: .git is not readable here')
    if (mustExist && !fs.existsSync(real)) throw new ToolError(`path not found: ${shown(absolute)}; paths are relative to the repo root`)
    return real
  }
  const rel = (real) => path.relative(sandbox.root, real) || '.'

  const walk = function* (dir, depth) {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        yield { file, dir: true }
        if (depth > 0) yield* walk(file, depth - 1)
      } else if (entry.isFile()) yield { file, dir: false }
      // Symlinks are listed, never followed.
      else if (entry.isSymbolicLink()) yield { file, dir: false, link: true }
    }
  }

  const TOOLS = [
    {
      name: 'list_files',
      label: 'List files',
      description: 'List files and folders under a folder of the project (default the root), two levels deep. Skips .git and node_modules.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Folder, relative to the project root.' } },
        additionalProperties: false,
      },
      run(args) {
        const dir = resolvePath(args?.path ?? '.', { mustExist: true })
        if (!fs.statSync(dir).isDirectory()) throw new ToolError(`${rel(dir)} is not a folder`)
        const lines = []
        for (const item of walk(dir, 1)) {
          lines.push(`${rel(item.file)}${item.dir ? '/' : item.link ? ' (link)' : ''}`)
          if (lines.length >= LIST_MAX) {
            lines.push(`[... more than ${LIST_MAX} entries]`)
            break
          }
        }
        return { text: lines.join('\n') || '(empty)', detail: `${rel(dir)}: ${lines.length} entries` }
      },
    },
    {
      name: 'read_file',
      label: 'Read a file',
      description: 'Read a text file of the project. Optional startLine (1-based) and lineCount for a part of a long file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, startLine: { type: 'integer' }, lineCount: { type: 'integer' } },
        required: ['path'],
        additionalProperties: false,
      },
      run(args) {
        const file = resolvePath(stringArg(args, 'path', { max: 1000 }), { mustExist: true })
        let content
        try {
          content = sandbox.read({ path: file, line: args.startLine ?? null, limit: args.lineCount ?? null })
        } catch (error) {
          throw new ToolError(error.message.replace(sandbox.root, 'the worktree'))
        }
        return { text: truncate(content, READ_CHARS_MAX), detail: rel(file) }
      },
    },
    {
      name: 'search',
      label: 'Search the code',
      description: 'Find lines containing a text (or a regular expression with regex: true) in the project files. At most 100 matches.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string', description: 'Folder to search (default the root).' },
          regex: { type: 'boolean' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      run(args) {
        const query = stringArg(args, 'query', { max: 500 })
        if (!query) throw new ToolError('query is empty')
        let test
        if (args.regex) {
          let re
          try {
            re = new RegExp(query)
          } catch (error) {
            throw new ToolError(`bad regular expression: ${error.message}`)
          }
          test = (line) => re.test(line)
        } else test = (line) => line.includes(query)
        const dir = resolvePath(args.path ?? '.', { mustExist: true })
        const matches = []
        let files = 0
        for (const item of walk(dir, 30)) {
          if (item.dir || item.link) continue
          if (++files > SEARCH_FILES_MAX) break
          let buffer
          try {
            if (fs.statSync(item.file).size > SEARCH_FILE_BYTES_MAX) continue
            buffer = fs.readFileSync(item.file)
          } catch {
            continue
          }
          if (buffer.includes(0)) continue
          const lines = buffer.toString('utf8').split('\n')
          for (let index = 0; index < lines.length && matches.length < SEARCH_MATCHES_MAX; index += 1) {
            if (test(lines[index])) matches.push(`${rel(item.file)}:${index + 1}: ${lines[index].slice(0, 300)}`)
          }
          if (matches.length >= SEARCH_MATCHES_MAX) break
        }
        return { text: matches.join('\n') || 'No matches.', detail: `${matches.length} match${matches.length === 1 ? '' : 'es'}` }
      },
    },
    {
      name: 'write_file',
      label: 'Write a file',
      description: 'Create or replace a text file of the project with the given content.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      run(args) {
        const target = resolvePath(stringArg(args, 'path', { max: 1000 }), { write: true })
        const content = stringArg(args, 'content', { max: 4 * 1024 * 1024 })
        try {
          sandbox.write({ path: target, content })
        } catch (error) {
          throw new ToolError(`refused: ${error.message.replace(sandbox.root, 'the worktree')}`)
        }
        state.changed.add(rel(target))
        return { text: `Wrote ${rel(target)} (${Buffer.byteLength(content)} bytes).`, detail: rel(target) }
      },
    },
    {
      name: 'edit_file',
      label: 'Edit a file',
      description: 'Replace one exact piece of text in a file. oldText must appear exactly once; include enough context to make it unique.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } },
        required: ['path', 'oldText', 'newText'],
        additionalProperties: false,
      },
      run(args) {
        const target = resolvePath(stringArg(args, 'path', { max: 1000 }), { write: true, mustExist: true })
        const oldText = stringArg(args, 'oldText', { max: 200000 })
        const newText = stringArg(args, 'newText', { max: 1024 * 1024 })
        if (!oldText) throw new ToolError('oldText is empty')
        let content
        try {
          content = sandbox.read({ path: target })
        } catch (error) {
          throw new ToolError(error.message.replace(sandbox.root, 'the worktree'))
        }
        const first = content.indexOf(oldText)
        if (first < 0) throw new ToolError('oldText was not found in the file')
        if (content.indexOf(oldText, first + 1) >= 0) throw new ToolError('oldText appears more than once; include more context')
        try {
          sandbox.write({ path: target, content: content.slice(0, first) + newText + content.slice(first + oldText.length) })
        } catch (error) {
          throw new ToolError(`refused: ${error.message.replace(sandbox.root, 'the worktree')}`)
        }
        state.changed.add(rel(target))
        return { text: `Edited ${rel(target)}.`, detail: rel(target) }
      },
    },
    testEntry && {
      name: 'run_tests',
      label: 'Run the tests',
      description: `Run the project's test command (${testEntry.argv.join(' ')}) and get the result with the end of its output.`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        // The test command runs code from the project, so changing what it
        // runs is changing what runs: then a person approves it first.
        const argv = namedArgv(testEntry, null, devServer && !devServer.exited ? devServer.port : null)
        const refused = await mayRun(testEntry, argv)
        if (refused) return { ...refused, ok: false }
        const result = await runProgram(argv, { cwd: sandbox.root, timeoutMs: Math.min(COMMAND_MS_MAX, remainingMs()), signal })
        return commandResult('The tests', result)
      },
    },
    others.length > 0 && {
      name: 'run_named_command',
      label: 'Run a named command',
      description: `Run one of the project's named commands (${others.map((command) => command.name).join(', ')}), from its shapewall.config.json, without a shell. ${others.some(serves) ? `${others.filter(serves).map((command) => `"${command.name}"`)[0]} starts the app's dev server in the background on a port in the sandbox and gives your browser tools that address; stop it with stop_dev_server. ` : ''}Changing a file a command depends on asks a person on the board first.`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: others.map((command) => command.name) },
          args: {
            type: 'array',
            items: { type: 'string', maxLength: NAMED_ARG_BYTES },
            maxItems: NAMED_ARGS_MAX,
            description: 'Extra arguments, only for a command whose config says "args": true',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async run(args) {
        const name = stringArg(args, 'name', { max: 64 })
        // Only the names the host sent (the checkout's config, as the
        // capabilities allow): never a name or a line from the worktree.
        const command = others.find((item) => item.name === name)
        if (!command)
          throw new ToolError(
            `"${name.slice(0, 64)}" is not a command you can run here. You can run: ${[...(testEntry ? ['test (run_tests)'] : []), ...others.map((item) => item.name)].join(', ')}`,
          )
        if (serves(command)) return startServer(command, args.args)
        const argv = namedArgv(command, args.args, devServer && !devServer.exited ? devServer.port : null)
        const refused = await mayRun(command, argv)
        if (refused) return { ...refused, ok: false }
        const result = await runProgram(argv, { cwd: sandbox.root, timeoutMs: Math.min(COMMAND_MS_MAX, remainingMs()), signal })
        return commandResult(`"${command.name}"`, result)
      },
    },
    others.some(serves) && {
      name: 'stop_dev_server',
      label: 'Stop the dev server',
      description: 'Stop the dev server this run started (its address leaves your browser tools).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const server = await stopServer()
        return server
          ? { text: `Stopped "${server.name}" (port ${server.port}).\n${tail(server.output, 2000)}`, detail: `stopped ${server.name}` }
          : { text: 'No dev server is running.', detail: 'none running' }
      },
    },
    // The browser tools, as agent-browser.js defines them, minus the
    // screenshot (this model reads text only). Page text comes back quoted
    // as untrusted data.
    ...(browser
      ? browserTools(browser)
          .filter((tool) => tool.name !== 'browser_screenshot')
          .map((tool) => {
            const schema = z.object(tool.inputSchema).strict()
            return {
              name: tool.name,
              label: tool.title.slice(0, 60),
              description: tool.description,
              parameters: jsonSchema(tool.inputSchema),
              async run(args) {
                const parsed = schema.safeParse(args)
                if (!parsed.success) throw new ToolError(`bad arguments: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`)
                const result = await tool.handler(parsed.data)
                const text = (result?.content || [])
                  .map((item) => (item.type === 'text' ? item.text : `[${item.type} not shown]`))
                  .join('\n')
                return { text: text || '(no output)', detail: tool.name, ok: !result?.isError }
              },
            }
          })
      : []),
    capture && {
      name: 'capture',
      label: 'Capture a page',
      description:
        'Run "shapewall capture" for one page of the board in the worktree, to see the change rendered. Works only when the site it captures is reachable from the sandbox.',
      parameters: { type: 'object', properties: { pageId: { type: 'string' } }, required: ['pageId'], additionalProperties: false },
      async run(args) {
        if (state.captureUnavailable) return { text: CAPTURE_UNAVAILABLE, detail: CAPTURE_UNAVAILABLE, ok: false }
        const pageId = stringArg(args, 'pageId', { max: 64 })
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(pageId)) throw new ToolError('pageId is a page id such as "home"')
        const cwd = path.resolve(sandbox.root, projectDir)
        if (!inside(sandbox.root, cwd) || !fs.existsSync(path.join(cwd, 'shapewall.config.json'))) {
          throw new ToolError('the project has no shapewall.config.json')
        }
        const result = await runProgram([process.execPath, SHAPEWALL_BIN, 'capture', '--only', pageId], {
          cwd,
          timeoutMs: Math.min(5 * 60 * 1000, remainingMs()),
          signal,
        })
        // The site did not answer from in here: say so plainly, once for the
        // run, so the model stops trying instead of reading browser errors.
        if (result.code !== 0 && captureUnreachable(result.output)) {
          state.captureUnavailable = true
          return { text: CAPTURE_UNAVAILABLE, detail: CAPTURE_UNAVAILABLE, ok: false }
        }
        return commandResult(`Capturing ${pageId}`, result)
      },
    },
    {
      name: 'reply',
      label: 'Reply on the comment',
      description: `Post a reply on the comment (up to ${REPLY_MAX} characters, at most ${REPLIES_MAX} per run), for a question or progress. Your final answer is posted anyway.`,
      parameters: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'], additionalProperties: false },
      async run(args) {
        const body = stringArg(args, 'body', { max: REPLY_MAX }).trim()
        if (!body) throw new ToolError('body is empty')
        if (state.replies >= REPLIES_MAX) throw new ToolError(`at most ${REPLIES_MAX} replies per run`)
        const answer = await rpc.call('reply', { body })
        if (!answer?.ok) throw new ToolError(answer?.error || 'the reply was not posted')
        state.replies += 1
        return { text: 'Reply posted.', detail: body.slice(0, 80) }
      },
    },
    {
      name: 'set_status',
      label: 'Set the status',
      description:
        'Say how the work ended: done (the change is made), or needs-human (a person must decide or help). Applied when the run ends.',
      parameters: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['done', 'needs-human'] }, note: { type: 'string' } },
        required: ['status'],
        additionalProperties: false,
      },
      run(args) {
        if (!['done', 'needs-human'].includes(args?.status)) throw new ToolError('status is done or needs-human')
        state.status = args.status
        state.statusNote = stringArg(args, 'note', { optional: true, max: 1000 })
        return { text: `Status will be ${args.status}.`, detail: args.status }
      },
    },
    shell && {
      name: 'run_shell',
      label: 'Run a command',
      description:
        'Run one shell command in the project folder, inside the sandbox. A person must approve each command on the board first, so use it only when no other tool does the job, and say why.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, reason: { type: 'string' } },
        required: ['command', 'reason'],
        additionalProperties: false,
      },
      async run(args) {
        const command = stringArg(args, 'command', { max: SHELL_COMMAND_MAX })
        const reason = stringArg(args, 'reason', { max: 500 })
        if (!command.trim()) throw new ToolError('command is empty')
        const answer = await rpc.call('approve', { command, reason })
        if (!answer?.approved)
          return { text: `Not run: ${answer?.error || 'the person did not approve it'}.`, detail: 'not approved', ok: false }
        state.shellRan = true
        const result = await runProgram(['/bin/sh', '-c', command], {
          cwd: sandbox.root,
          timeoutMs: Math.min(COMMAND_MS_MAX, remainingMs()),
          signal,
        })
        return commandResult('The command', result)
      },
    },
  ].filter(Boolean)

  return {
    state,
    markBase,
    // The end of the task: the dev server stops, the browser ends for good.
    async close() {
      await stopServer().catch(() => {})
      await browser?.dispose().catch(() => {})
    },
    names: TOOLS.map((tool) => tool.name),
    specs: TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters })),
    async run(call) {
      const tool = TOOLS.find((item) => item.name === call.name)
      // Not offered (the site is not reachable from the sandbox), and called anyway.
      if (!tool && call.name === 'capture')
        return { ok: false, label: 'Capture a page', text: CAPTURE_UNAVAILABLE, detail: CAPTURE_UNAVAILABLE }
      if (!tool)
        return {
          ok: false,
          label: String(call.name || 'tool').slice(0, 60),
          text: `There is no tool "${String(call.name).slice(0, 60)}".`,
          detail: 'unknown tool',
        }
      if (call.args?._invalid !== undefined)
        return { ok: false, label: tool.label, text: 'The arguments were not valid JSON.', detail: 'bad arguments' }
      try {
        const result = await tool.run(call.args || {})
        return {
          ok: result.ok !== false,
          label: tool.label,
          text: truncate(result.text),
          detail: result.detail ? String(result.detail).slice(0, 200) : null,
        }
      } catch (error) {
        const message = error instanceof ToolError ? error.message : `the tool failed (${error.code || error.message})`
        return { ok: false, label: tool.label, text: message, detail: message.slice(0, 200) }
      }
    },
  }
}
