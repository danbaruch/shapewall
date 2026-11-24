// The starter agent's tools, run inside the container. A fixed set: read,
// search and edit files in the worktree, run the configured test command,
// `shapewall capture`, reply on the comment, set its status, and (only with
// the person's approval of each command, on the board) run a shell command.
//
// Every path goes through the ACP bridge's sandbox (src/agent/acp/sandbox.js):
// resolved after symlinks, refused outside the worktree, and writes refused
// in .git. Reads of .git are refused too (in a worktree it only points at
// the host's repository). The container is the outer wall; this is the
// inner one, so a tool call that names a file outside is refused, not tried.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createSandbox, inside } from '../acp/sandbox.js'

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

// createTools({ root, rpc, testCommand, capture, shell, remainingMs, signal })
// -> { specs, run(call) -> { ok, text, label, detail }, state }
export function createTools({
  root,
  rpc,
  testCommand = null,
  capture = false,
  projectDir = '.',
  shell = false,
  remainingMs = () => COMMAND_MS_MAX,
  signal = null,
}) {
  const sandbox = createSandbox({ root })
  const state = { replies: 0, status: null, statusNote: null, changed: new Set(), shellRan: false, captureUnavailable: false }

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
    testCommand && {
      name: 'run_tests',
      label: 'Run the tests',
      description: `Run the project's test command (${testCommand.join(' ')}) and get the result with the end of its output.`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        // The test command runs code from the project, so changing what it
        // runs is changing what runs: then a person approves it first.
        const inputs = [...state.changed].filter((file) => testInput(file, testCommand))
        if (inputs.length || state.shellRan) {
          const why = inputs.length
            ? `The agent changed ${inputs.slice(0, 4).join(', ')}${inputs.length > 4 ? ', ...' : ''}, which decide${inputs.length === 1 ? 's' : ''} what the test command runs.`
            : 'An approved command ran earlier in this run and may have changed what the test command runs.'
          if (!shell)
            return {
              text: `Not run: ${why} That needs a person's approval, which this run does not have.`,
              detail: 'needs approval',
              ok: false,
            }
          const answer = await rpc.call('approve', { command: testCommand.join(' '), reason: why })
          if (!answer?.approved)
            return { text: `Not run: ${answer?.error || 'the person did not approve it'}.`, detail: 'not approved', ok: false }
        }
        const result = await runProgram(testCommand, { cwd: sandbox.root, timeoutMs: Math.min(COMMAND_MS_MAX, remainingMs()), signal })
        return commandResult('The tests', result)
      },
    },
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
