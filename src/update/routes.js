// Installation updates are an explicit operator capability. Shapewall never
// downloads or executes an updater unless its installer provides a helper.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import express from 'express'
import { sameOriginWrite, settingsRefusal, settingsTokenOk } from '../agent/settings-routes.js'
import { createRateLimiter } from '../shared/ratelimit.js'
import { tokenEquals } from '../tokens.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const MAX_OUTPUT = 65536
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,79}$/
const REVISION = /^[a-f0-9]{7,40}$/i
const MANUAL = 'Updates are managed by the person who installed Shapewall.'
const UPDATE_TOKEN_MIN = 32
const UPDATE_TOKEN_FAILS = { limit: 10, windowMs: 15 * 60_000 }

function revision(value) {
  return typeof value === 'string' && REVISION.test(value) ? value.toLowerCase() : null
}

export function runningVersion(env = process.env) {
  let metadata
  for (const file of ['dist/client/build-info.json', 'build-info.json']) {
    try {
      metadata = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
      if (revision(metadata?.revision)) break
    } catch {
      metadata = null
    }
  }
  return { version: PACKAGE.version, revision: revision(env.SHAPEWALL_BUILD_REVISION) || revision(metadata?.revision) }
}

function tokenOk(req, token) {
  return tokenEquals(req.headers['x-shapewall-update-token'], token)
}

function executable(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null
  try {
    if (!fs.statSync(value).isFile()) return null
    fs.accessSync(value, fs.constants.X_OK)
    return value
  } catch {
    return null
  }
}

function result(value) {
  const latest = value?.latest
  if (!latest || typeof latest.version !== 'string' || !VERSION.test(latest.version) || typeof value.updateAvailable !== 'boolean')
    throw new Error('Invalid updater response.')
  if (latest.revision !== undefined && latest.revision !== null && !revision(latest.revision)) throw new Error('Invalid updater response.')
  return {
    latest: { version: latest.version, revision: revision(latest.revision) },
    updateAvailable: value.updateAvailable,
    restartRequired: value.restartRequired === true,
  }
}

// One child per server. The installer must additionally serialize across
// processes and preserve rollback when replacing a running installation.
//
// The helper is tracked here, not with the server's capture children: an
// `apply` is replacing the installation, so nothing in Shapewall interrupts
// it. It runs in its own process group (a Ctrl-C at the terminal does not
// reach it), server shutdown waits for it (router.lifecycle), and its time
// limit reports it as stuck instead of killing it. A `check` is harmless to
// stop and is stopped on shutdown or when it runs too long.
export function appUpdateRouter({ env = process.env, settingsToken = null, shared = false, readOnly = false, appUpdate = {} } = {}) {
  // The proxy capability can replace app code: a guessable one is refused at startup.
  const updateToken = env.SHAPEWALL_UPDATE_TOKEN || null
  if (updateToken !== null && updateToken.length < UPDATE_TOKEN_MIN) {
    throw new Error(
      `SHAPEWALL_UPDATE_TOKEN must be at least ${UPDATE_TOKEN_MIN} characters (it has ${updateToken.length}). Generate one with "openssl rand -base64 32".`,
    )
  }
  const router = express.Router()
  // Wrong update tokens are counted per address; past the limit, requests
  // carrying a wrong one are refused before any check (GET status says too,
  // through canUpdate). The right token always passes: behind the update
  // proxy every caller shares one address, so wrong guesses must not lock
  // out the token's holder.
  const limiter = createRateLimiter()
  const failKey = (req) => req.socket?.remoteAddress || 'unknown'
  const presented = (req) => req.headers['x-shapewall-update-token'] !== undefined
  const tokenLimited = (req, res) => {
    if (!presented(req) || tokenOk(req, updateToken)) return false
    const { ok, retryAfter } = limiter.peek('updateTokenFail', failKey(req), UPDATE_TOKEN_FAILS)
    if (ok) return false
    res.setHeader('Retry-After', String(retryAfter))
    fail(res, 429, 'update_rate_limited', 'Too many wrong update tokens. Try again later.')
    return true
  }
  const countFailure = (req) => {
    if (presented(req) && !tokenOk(req, updateToken)) limiter.hit('updateTokenFail', failKey(req), UPDATE_TOKEN_FAILS)
  }
  const current = runningVersion(env)
  const helper = executable(appUpdate.helper ?? env.SHAPEWALL_UPDATE_HELPER)
  let latest = null
  let updateAvailable = false
  let checkedAt = null
  let job = null
  let restartPending = false
  // The running helper: { action, child, closed } (closed: a promise).
  let helperRun = null
  const authorized = (req) => tokenOk(req, updateToken) || (settingsTokenOk(req, settingsToken) && !settingsRefusal(req, { shared }))
  const status = (req) => ({
    current,
    latest,
    updateAvailable,
    supported: Boolean(helper),
    canUpdate: Boolean(helper) && !readOnly && authorized(req),
    reason: !helper
      ? MANUAL
      : readOnly
        ? 'This board is read-only.'
        : !authorized(req)
          ? 'Open the owner link on this machine to manage updates.'
          : null,
    checkedAt,
    job,
  })
  const fail = (res, code, name, message) => res.status(code).json({ error: { code: name, message } })

  function run(action) {
    if (action === 'check') {
      checkedAt = null
      updateAvailable = false
    }
    const active = { action, state: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null }
    job = active
    let child
    let timer
    let output = ''
    let bytes = 0
    let settled = false
    let aborted = null
    let markClosed
    const entry = { action, child: null, closed: new Promise((resolve) => (markClosed = resolve)) }
    helperRun = entry
    const closed = () => {
      if (helperRun === entry) helperRun = null
      markClosed()
    }
    // An apply is never killed: past its limit (or its output cap) it is
    // reported, and stays tracked until it really exits.
    const giveUp = (message) => {
      aborted = message
      if (action === 'apply') finish(message)
      else child.kill('SIGKILL')
    }
    const finish = (error = null, value = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      active.finishedAt = new Date().toISOString()
      active.state = error ? 'failed' : 'succeeded'
      active.error = error
      if (value) {
        latest = value.latest
        updateAvailable = value.updateAvailable
        if (action === 'check') checkedAt = active.finishedAt
        if (action === 'apply' && value.restartRequired && typeof appUpdate.onRestart === 'function') {
          restartPending = true
          const delay = appUpdate.restartDelayMs
          const restartTimer = setTimeout(
            () => {
              try {
                appUpdate.onRestart()
              } catch {
                restartPending = false
                active.state = 'failed'
                active.error = 'Shapewall could not restart. Contact the installer.'
              }
            },
            Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 1500) : 1500,
          )
          restartTimer.unref?.()
        }
      }
    }
    try {
      // No shell or request-derived arguments/environment. The helper needs
      // the actual running artifact, since a previous attempt may already
      // have switched its pointer without completing the process restart.
      child = spawn(helper, [action], {
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...env, SHAPEWALL_RUNNING_REVISION: current.revision || '' },
        // Its own process group: a terminal's Ctrl-C (sent to the whole
        // foreground group) must not interrupt an installation mid-replace.
        detached: action === 'apply' && process.platform !== 'win32',
      })
      entry.child = child
      const timeout = action === 'check' ? 30000 : 900000
      const configured = appUpdate[`${action}TimeoutMs`]
      timer = setTimeout(
        () =>
          giveUp(
            action === 'apply'
              ? 'The update helper is taking too long. It was not stopped: check the installation before trying again.'
              : 'The update helper timed out. Check the installation before trying again.',
          ),
        Number.isFinite(configured) && configured > 0 ? Math.min(configured, timeout) : timeout,
      )
      timer.unref?.()
      child.stdout.on('data', (chunk) => {
        if (aborted) return
        bytes += chunk.length
        if (bytes > MAX_OUTPUT) giveUp('The update helper returned too much output.')
        else output += chunk.toString('utf8')
      })
      child.once('error', () => {
        closed()
        finish('The update helper could not start. Contact the installer.')
      })
      child.once('close', (code) => {
        closed()
        if (settled) return
        if (aborted) return finish(aborted)
        if (code !== 0) return finish('The update helper failed. Check the installation before trying again.')
        try {
          finish(null, result(JSON.parse(output)))
        } catch {
          finish('The update helper returned an invalid response.')
        }
      })
    } catch {
      closed()
      finish('The update helper could not start. Contact the installer.')
    }
  }

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  router.get('/', (req, res) => {
    if (tokenLimited(req, res)) return
    countFailure(req)
    res.json(status(req))
  })
  for (const action of ['check', 'apply']) {
    router.post(`/${action}`, (req, res) => {
      if (tokenLimited(req, res)) return
      if (!authorized(req)) {
        countFailure(req)
        return fail(res, 403, 'update_forbidden', 'Only the installation owner can manage updates.')
      }
      if (!sameOriginWrite(req)) return fail(res, 403, 'update_origin', 'Manage updates from this board.')
      if (readOnly) return fail(res, 403, 'read_only', 'This board is read-only.')
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)
        return fail(res, 400, 'invalid_update_request', 'Send an empty JSON object.')
      if (!helper) return fail(res, 503, 'update_unsupported', MANUAL)
      // A helper that is still alive (an apply past its limit) keeps it busy too.
      if (job?.state === 'running' || restartPending || helperRun)
        return fail(res, 409, 'update_busy', 'An update operation is already running.')
      if (action === 'apply' && (!checkedAt || !updateAvailable))
        return fail(res, 409, 'update_not_available', 'Check for an available update first.')
      if (stopping) return fail(res, 503, 'update_stopping', 'Shapewall is stopping.')
      run(action)
      res.status(202).json(status(req))
    })
  }
  let stopping = false
  // Server shutdown (src/server/app.js shutdownApp): stops a running check,
  // and reports an apply, which shutdown waits for.
  router.lifecycle = {
    applying: () => helperRun?.action === 'apply',
    stop() {
      stopping = true
      if (helperRun?.action === 'check') {
        try {
          helperRun.child?.kill('SIGTERM')
        } catch {
          /* gone */
        }
      }
    },
    // Resolves when no helper is running.
    settled: () => (helperRun ? helperRun.closed : Promise.resolve()),
  }
  return router
}
