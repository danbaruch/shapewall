// Runs `ci.start` (src/ci/settings.js) for `shapewall ci capture --allow-start`:
// install and build to completion, then the serve command in the background
// until the site answers. Each command is an argv array run without a shell;
// the program is looked up on absolute PATH entries only (which.js), so
// neither a string nor a program inside the repository can be named.
//
// It runs only inside a CI job (GITHUB_ACTIONS or CI is "true") and only when
// the command line says --allow-start: a config in a cloned repository never
// starts anything on someone's own machine because they ran a Shapewall command.

import { spawn } from 'node:child_process'
import { absoluteProgram } from '../which.js'

// Tokens the job has that the project's own commands never need.
const WITHHELD = [
  'GITHUB_TOKEN',
  'SHAPEWALL_GITHUB_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'SHAPEWALL_TOKEN',
]

export const inCi = (env = process.env) => env.GITHUB_ACTIONS === 'true' || env.CI === 'true'

// Why ci.start may not run here, or null when it may.
export function startRefusal({ allowStart, env = process.env, start }) {
  if (!start) return 'the config has no "ci.start" (the install, build and serve commands); add it, or capture a URL with --url'
  if (!allowStart)
    return 'ci.start runs only with --allow-start, which the workflow passes; Shapewall never runs commands from a config on its own'
  if (!inCi(env))
    return 'ci.start runs only inside a CI job (GITHUB_ACTIONS or CI set to "true"); on your own machine, start the site yourself and pass --url'
  return null
}

export function commandEnv(env = process.env) {
  const out = { ...env }
  for (const name of WITHHELD) delete out[name]
  return out
}

const describe = (argv) => argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(' ')

function launch(argv, { cwd, env, log, detached }) {
  const program = absoluteProgram(argv[0], env)
  if (!program) throw new Error(`"${argv[0]}" is not on PATH (ci.start names programs, looked up on absolute PATH entries only)`)
  const child = spawn(program, argv.slice(1), { cwd, env, shell: false, detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const relay = (stream) => {
    let rest = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n')
      rest = lines.pop()
      for (const line of lines) log(`  | ${line.slice(0, 500)}`)
    })
    stream.on('end', () => rest && log(`  | ${rest.slice(0, 500)}`))
  }
  relay(child.stdout)
  relay(child.stderr)
  return child
}

// A whole process group, so `npm start` does not leave its server behind.
function kill(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    /* already gone */
  }
}

function runToEnd(argv, { cwd, env, log, timeout }) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = launch(argv, { cwd, env, log, detached: process.platform !== 'win32' })
    } catch (error) {
      reject(error)
      return
    }
    const timer = setTimeout(() => {
      kill(child, 'SIGKILL')
      reject(new Error(`${describe(argv)} did not finish within ${Math.round(timeout / 1000)} s`))
    }, timeout)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`${describe(argv)} did not start: ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${describe(argv)} failed (${signal ? `signal ${signal}` : `exit code ${code}`})`))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Waits until `url` answers with any status below 500. `isDead()` stops the
// wait early (the serve command exited). Throws on timeout.
export async function waitForUrl(url, { timeout = 180000, interval = 1000, fetchImpl = globalThis.fetch, isDead = () => null } = {}) {
  const until = Date.now() + timeout
  let last = 'no answer yet'
  for (;;) {
    const dead = isDead()
    if (dead) throw new Error(`the serve command exited before ${url} answered (${dead})`)
    try {
      const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.min(10000, timeout)) })
      await response.body?.cancel().catch(() => {})
      if (response.status < 500) return response.status
      last = `HTTP ${response.status}`
    } catch (error) {
      last = error.cause?.code || error.name || 'no answer'
    }
    if (Date.now() >= until) throw new Error(`${url} did not answer within ${Math.round(timeout / 1000)} s (${last})`)
    await sleep(interval)
  }
}

// True when `url` answers at all right now (any status).
async function answers(url, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
    await response.body?.cancel().catch(() => {})
    return true
  } catch {
    return false
  }
}

// Runs install and build, starts serve and waits for `url`. Returns { stop }.
export async function startSite(start, { cwd, url, env = process.env, log = () => {}, fetchImpl } = {}) {
  const childEnv = commandEnv(env)
  for (const step of ['install', 'build']) {
    if (!start[step]) continue
    log(`ci.start.${step}: ${describe(start[step])} (in ${cwd})`)
    await runToEnd(start[step], { cwd, env: childEnv, log, timeout: start.timeout })
  }
  // Something already answering there would be captured in place of this
  // checkout (and serve would fail on the taken port a moment too late): the
  // base and the head would then show the same site, and "no visual changes".
  if (await answers(url, fetchImpl))
    throw new Error(`${url} already answers before ci.start.serve ran: stop what is serving it, so the capture is of this checkout`)
  log(`ci.start.serve: ${describe(start.serve)} (in ${cwd})`)
  const server = launch(start.serve, { cwd, env: childEnv, log, detached: process.platform !== 'win32' })
  let exited = null
  server.on('exit', (code, signal) => (exited = signal ? `signal ${signal}` : `exit code ${code}`))
  server.on('error', (error) => (exited = error.message))
  const stop = async () => {
    if (exited) return
    kill(server, 'SIGTERM')
    for (let waited = 0; waited < 5000 && !exited; waited += 100) await sleep(100)
    if (!exited) kill(server, 'SIGKILL')
  }
  try {
    await waitForUrl(url, { timeout: start.timeout, fetchImpl, isDead: () => exited })
  } catch (error) {
    await stop()
    throw error
  }
  log(`${url} is up`)
  return { stop }
}
