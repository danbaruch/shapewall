// Manual capture sign-in. Always a fresh browser profile, never a login script.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { getBoard, getEnvironment, ID_RE } from '../config.js'
import { cliCommand } from '../invocation.js'
import { absoluteProgram } from '../which.js'
import { SAFE_GIT_FLAGS } from '../agent/starter/worktree.js'

export const AUTH_FLAGS = ['board', 'env', 'url', 'timeout', 'overwrite']
export const AUTH_BOOLEAN_FLAGS = ['overwrite']
export const AUTH_HELP = `  auth record               open a fresh browser for manual capture sign-in
      --board ID            board to sign in to (default: the first)
      --env ID              environment to sign in to (default: the first)
      --url URL             optional sign-in page (never printed)
      --timeout SECONDS     time to finish (default 600, maximum 1800)
      --overwrite           explicitly replace this board/environment's saved state
                            press Enter to save; Ctrl-C, browser close or timeout discards
                            saves a private .shapewall-auth/*.auth.json; config stays unchanged`
const DIRECTORY = '.shapewall-auth'
const STATE_BYTES_MAX = 10 * 1024 * 1024
const fail = (code, message) => Object.assign(new Error(message), { code })
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
const privateOwned = (stat) => typeof process.getuid !== 'function' || (stat.uid === process.getuid() && !(stat.mode & 0o077))

function lstat(file) {
  try {
    return fs.lstatSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function gitCheck(root) {
  let current = root
  let repository = false
  while (true) {
    if (lstat(path.join(current, '.git'))) {
      repository = true
      break
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  if (!repository) return
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  const git = absoluteProgram('git', env)
  if (!git) throw fail('auth_git_check', 'Git must be available in an absolute PATH directory to verify private sign-in storage.')
  const checked = spawnSync(git, [...SAFE_GIT_FLAGS, '-C', root, 'ls-files', '-z', '--', DIRECTORY], {
    env,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  })
  if (checked.status !== 0) throw fail('auth_git_check', 'Could not verify the private recording directory with Git. Nothing was saved.')
  if (
    checked.stdout
      .split('\0')
      .filter(Boolean)
      .some((file) => file !== `${DIRECTORY}/.gitignore`)
  )
    throw fail('auth_tracked', 'The recording directory contains Git-tracked files. Remove those files from Git before recording sign-in.')
}

function protectedAncestors(root) {
  for (let current = root; ; current = path.dirname(current)) {
    const stat = lstat(current)
    if (
      !stat?.isDirectory() ||
      stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && (stat.mode & 0o022 || ![0, process.getuid()].includes(stat.uid)))
    )
      throw fail(
        'auth_private_directory',
        'The recording project and its parent directories must not be writable by other users or replaced by symlinks.',
      )
    if (path.dirname(current) === current) break
  }
}

function resolvedLocation(file) {
  const missing = []
  let existing = path.resolve(file)
  while (!lstat(existing)) {
    missing.unshift(path.basename(existing))
    existing = path.dirname(existing)
  }
  return path.join(fs.realpathSync(existing), ...missing)
}

const contains = (parent, child) => {
  const relative = path.relative(parent, child)
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

// A fixed destination, outside capture/export data. Repo config cannot redirect writes.
function destination(config, board, environment, overwrite) {
  if (!ID_RE.test(board.id) || !ID_RE.test(environment.id)) throw fail('auth_config', 'Choose a configured board and environment.')
  const root = fs.realpathSync(config.dir)
  protectedAncestors(root)
  const rootStat = fs.statSync(root)
  if (typeof process.getuid === 'function' && (rootStat.uid !== process.getuid() || rootStat.mode & 0o022))
    throw fail('auth_private_directory', 'Record sign-in from a project directory owned by you and not writable by other users.')
  gitCheck(root)
  const directory = path.join(root, DIRECTORY)
  if (
    config.outputDir &&
    (contains(resolvedLocation(config.outputDir), directory) || contains(directory, resolvedLocation(config.outputDir)))
  )
    throw fail('auth_output_overlap', 'The private recording directory must stay outside the configured capture output directory.')
  if (!lstat(directory)) fs.mkdirSync(directory, { mode: 0o700 })
  const dirStat = lstat(directory)
  if (!dirStat?.isDirectory() || dirStat.isSymbolicLink() || !privateOwned(dirStat))
    throw fail('auth_private_directory', 'The recording directory must be a private directory owned by you, with mode 0700 and no symlink.')
  const ignore = path.join(directory, '.gitignore')
  if (!lstat(ignore)) fs.writeFileSync(ignore, '*\n', { mode: 0o600, flag: 'wx' })
  const ignoreStat = lstat(ignore)
  if (
    !ignoreStat?.isFile() ||
    ignoreStat.isSymbolicLink() ||
    ignoreStat.nlink !== 1 ||
    !privateOwned(ignoreStat) ||
    fs.readFileSync(ignore, 'utf8') !== '*\n'
  )
    throw fail('auth_git_ignore', 'The private recording directory must contain an unchanged ignore-all .gitignore file.')
  const name = `${board.id}${environment.id === 'default' ? '' : `.${environment.id}`}.auth.json`
  const file = path.join(directory, name)
  const before = lstat(file)
  if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !privateOwned(before)))
    throw fail('auth_unsafe_file', 'The saved sign-in file must be a private regular file owned by you, without symlinks or hard links.')
  if (before && !overwrite)
    throw fail('auth_exists', 'Saved sign-in already exists for this board/environment. Use --overwrite to replace it explicitly.')
  const lock = path.join(directory, '.record.lock')
  let lockFd
  try {
    lockFd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600)
  } catch (error) {
    if (error.code === 'EEXIST')
      throw fail(
        'auth_locked',
        'Another sign-in recording may be open. Close it first; remove .shapewall-auth/.record.lock only after confirming it is stale.',
      )
    throw error
  }
  const lockStat = fs.fstatSync(lockFd)
  return {
    file,
    relativeFile: `./${DIRECTORY}/${name}`,
    save(state) {
      protectedAncestors(root)
      const directoryNow = lstat(directory)
      const projectNow = lstat(root)
      if (
        !directoryNow?.isDirectory() ||
        directoryNow.isSymbolicLink() ||
        directoryNow.dev !== dirStat.dev ||
        directoryNow.ino !== dirStat.ino ||
        !privateOwned(directoryNow) ||
        !projectNow?.isDirectory() ||
        projectNow.isSymbolicLink() ||
        projectNow.dev !== rootStat.dev ||
        projectNow.ino !== rootStat.ino ||
        (typeof process.getuid === 'function' && (projectNow.uid !== process.getuid() || projectNow.mode & 0o022))
      )
        throw fail('auth_destination_changed', 'The private recording directory changed. Nothing was saved.')
      const ignored = lstat(ignore)
      if (!ignored || !sameFile(ignored, ignoreStat))
        throw fail('auth_destination_changed', 'The private ignore file changed. Nothing was saved.')
      gitCheck(root)
      const now = lstat(file)
      if (before ? !now || !sameFile(now, before) : now)
        throw fail('auth_destination_changed', 'The saved sign-in file changed during recording. Nothing was saved.')
      const json = `${JSON.stringify(state)}\n`
      if (Buffer.byteLength(json) > STATE_BYTES_MAX) throw fail('auth_state_large', 'Sign-in storage is too large to save (maximum 10 MB).')
      const temporary = path.join(directory, `.state-${randomBytes(12).toString('hex')}.tmp`)
      let fd
      try {
        fd = fs.openSync(
          temporary,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
          0o600,
        )
        fs.writeFileSync(fd, json)
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        fd = null
        if (before) fs.renameSync(temporary, file)
        else {
          fs.linkSync(temporary, file)
          fs.unlinkSync(temporary)
        }
      } finally {
        if (fd !== undefined && fd !== null) fs.closeSync(fd)
        if (lstat(temporary)) fs.unlinkSync(temporary)
      }
    },
    close() {
      fs.closeSync(lockFd)
      const now = lstat(lock)
      if (now?.dev === lockStat.dev && now.ino === lockStat.ino) fs.unlinkSync(lock)
    },
  }
}

function terminalFinish(input, signal, out) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const reader = createInterface({ input, terminal: false })
    let settled = false
    const settle = (error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', stop)
      reader.close()
      if (error) reject(error)
      else resolve()
    }
    const stop = () => settle(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    reader.on('line', (line) => {
      if (!line.trim()) settle()
      else if (/^(cancel|q)$/i.test(line.trim())) settle(fail('auth_cancelled', 'Sign-in recording cancelled. Nothing was saved.'))
      else out('Press Enter to save, or type cancel to discard. Your input is not used as a password.')
    })
    reader.on('close', () => settle(fail('auth_cancelled', 'Sign-in recording cancelled. Nothing was saved.')))
    reader.on('error', () => settle(fail('auth_terminal', 'The input terminal failed. Nothing was saved.')))
  })
}

export async function recordCaptureAuth({
  config,
  boardId,
  envId,
  url,
  timeoutMs = 600000,
  overwrite = false,
  input = process.stdin,
  out = () => {},
  signal,
  finish,
  launch,
  headless = false,
  env = process.env,
} = {}) {
  if (!finish && !input?.isTTY)
    throw fail('auth_terminal', 'Run auth record in an interactive terminal on the desktop where you will sign in.')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000)
    throw fail('auth_timeout', 'Recording timeout must be between 1 and 1800000 milliseconds.')
  const board = getBoard(config, boardId)
  const environment = getEnvironment(board, envId)
  let target
  try {
    target = new URL(url || environment.baseUrl || board.baseUrl)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error()
  } catch {
    throw fail('auth_url', 'Choose an HTTP(S) sign-in page without credentials in its URL.')
  }
  let saved
  try {
    saved = destination(config, board, environment, overwrite)
  } catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith('auth_')) throw error
    throw fail('auth_destination', 'Could not prepare the private recording directory. Check project permissions. Nothing was saved.')
  }
  const controller = new AbortController()
  const cancel = () => controller.abort(fail('auth_cancelled', 'Sign-in recording cancelled. Nothing was saved.'))
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(fail('auth_timeout', 'Sign-in recording timed out. Nothing was saved.')), timeoutMs)
  let browser
  let context
  let disconnected
  try {
    const chromium = launch ? null : (await import('playwright')).chromium
    const engine = launch || chromium.launch.bind(chromium)
    const options = { headless, timeout: Math.min(timeoutMs, 30000), args: ['--disable-dev-shm-usage'] }
    const executablePath = env.SHAPEWALL_BROWSER_PATH || config.browser?.executablePath
    const channel = env.SHAPEWALL_BROWSER_CHANNEL || config.browser?.channel
    if (executablePath) options.executablePath = executablePath
    else if (channel) options.channel = channel
    const aborted = new Promise((resolve, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason)
      else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    })
    const work = async () => {
      if (controller.signal.aborted) throw controller.signal.reason
      browser = await engine(options)
      if (controller.signal.aborted) {
        await browser.close()
        throw controller.signal.reason
      }
      disconnected = () => controller.abort(fail('auth_cancelled', 'The sign-in browser closed. Nothing was saved.'))
      browser.once('disconnected', disconnected)
      context = await browser.newContext()
      const page = await context.newPage()
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, config.timeouts?.page || 45000) })
      out('Sign in manually in the fresh browser. Return here and press Enter to save, or type cancel to discard.')
      await (finish ? finish({ page, context, signal: controller.signal }) : terminalFinish(input, controller.signal, out))
      if (controller.signal.aborted) throw controller.signal.reason
      const state = await context.storageState({ indexedDB: true })
      if (controller.signal.aborted) throw controller.signal.reason
      saved.save(state)
      return {
        file: saved.file,
        relativeFile: saved.relativeFile,
        boardId: board.id,
        envId: environment.id,
        loginScriptOverrides: Boolean(config.auth?.loginScript),
      }
    }
    return await Promise.race([work(), aborted])
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    if (typeof error.code === 'string' && error.code.startsWith('auth_')) throw error
    // Browser errors often contain full URLs, queries, headers or request bodies.
    throw fail(
      'auth_record_failed',
      'Could not complete sign-in recording. Check that the desktop browser and site are available. Nothing was saved.',
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    if (disconnected) browser?.removeListener('disconnected', disconnected)
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    try {
      saved.close()
    } catch {
      out('Recording ended, but its private lock could not be removed. Check .shapewall-auth/.record.lock before recording again.')
    }
  }
}

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
export async function authCommand(config, positional, flags, out, options = {}) {
  if ((positional[0] || 'record') !== 'record' || positional.length > 1)
    throw fail('auth_command', 'Use auth record to save a manual capture sign-in.')
  const timeout = flags.timeout === undefined ? 600 : Number(flags.timeout)
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1800)
    throw fail('auth_timeout', '--timeout is a whole number of seconds between 1 and 1800.')
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    const result = await recordCaptureAuth({
      ...options,
      config,
      boardId: flags.board,
      envId: flags.env,
      url: flags.url,
      timeoutMs: timeout * 1000,
      overwrite: Boolean(flags.overwrite),
      out,
      signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
    })
    out(`Saved private browser state: ${result.relativeFile}`)
    out('Add this to your config (the config was not changed):')
    out(JSON.stringify({ auth: { storageState: result.relativeFile } }, null, 2))
    if (result.loginScriptOverrides) out('Your auth.loginScript still takes priority. Remove it to use the recorded storage state.')
    const configFlag = config.file ? ` --config ${quote(config.file)}` : ''
    out(`Next capture: ${cliCommand(`capture${configFlag} --board ${result.boardId} --env ${result.envId}`)}`)
    return 0
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
}
