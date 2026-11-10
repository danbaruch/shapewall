// /api/agent/settings: the board's Settings > Agent screen.
//
//   GET  /api/agent/settings        what is saved, what is in effect and where each value comes from
//   POST /api/agent/settings        save { settings, confirm }; the chat switches over at once. A new
//                                   command or key host without the matching confirm hash saves
//                                   nothing and answers { confirm: [{ kind, ... }], confirmHash }
//                                   (and `detected`: the agent CLIs found on PATH)
//   POST /api/agent/settings/connect { agentId, confirm }  one-click Connect: save that agent's
//                                   restricted command (same confirm step), test it, undo on failure
//   POST /api/agent/settings/test   { profileId? } try the settings in effect (or that agent's): a models
//                                   list or a one-token answer (OpenAI-compatible), the initialize handshake (ACP)
//   POST /api/agent/settings/profiles/:id/default  make a connected agent (or "endpoint": the saved
//                                   OpenAI-compatible endpoint) the one new chats and fixes use
//   DELETE /api/agent/settings/profiles/:id  remove a connected agent
//
// These are the server owner's settings: which agent runs on their machine
// and where their API key goes. Looking local is not enough (a proxy or TCP
// forwarder on this machine that rewrites Host makes any visitor look like
// loopback), so the routes need a capability first: the per-process settings
// token `shapewall serve` prints in its startup link (#settings-token=...),
// sent back in the X-Shapewall-Settings-Token header. Without it they are a
// plain 404. Then, as more conditions: a loopback peer and Host, no proxy
// headers, a board not shared beyond this machine (else 403), and for a POST
// an Origin of this board (and Sec-Fetch-Site same-origin when sent).
// Saving a new ACP command or a new (key variable, host) pair also needs the
// hash of exactly those items, which the board sends after the person said
// yes to them in a dialog.
//
// Keys are never sent, saved or returned: only the name of the variable.

import crypto from 'node:crypto'
import express from 'express'
import { formatCommand, loginHint } from './acp/command.js'
import { KNOWN_AGENTS, detectAgents } from './acp/detect.js'
import { acpHandshake } from './backends/acp.js'
import { beginAgentOperation } from './control.js'
import { redact, upstreamError } from './backends/openai.js'
import {
  DEFAULT_KEY_VAR,
  DENIED_KEY_VARS,
  KEY_VAR_RE,
  KNOWN_KEY_HOSTS,
  SAVED_KEYS,
  agentKey,
  envKeyHosts,
  keyHostConfirmed,
  publicAgentInfo,
} from './config.js'
import { legacyProfile, profileForDefault, projectKey, saveUserAgentEntry, userAgentEntry, validateUserEntry } from './user-settings.js'
import { tokenEquals } from '../tokens.js'

const TEST_TIMEOUT_MS = 15000
const ACP_TEST_TIMEOUT_MS = 30000
const VISION_PROBE_MS = 3000
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
// Any of these means a proxy or tunnel stands between the person and us.
export const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-server',
  'forwarded',
  'via',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'x-client-ip',
  'client-ip',
  'tailscale-user-login',
  'tailscale-user-name',
  'tailscale-user-profile-pic',
  'tailscale-app-capabilities',
]
export const SETTINGS_TOKEN_HEADER = 'x-shapewall-settings-token'

// A new settings token: printed by `shapewall serve`, never stored.
export function newSettingsToken() {
  return crypto.randomBytes(24).toString('base64url')
}

// Does the request carry this process's settings token? Constant time.
export function settingsTokenOk(req, token) {
  return tokenEquals(req.headers[SETTINGS_TOKEN_HEADER], token)
}

// A write from this board's own page: Origin present and equal to the Host,
// and Sec-Fetch-Site (when the browser sends it) same-origin.
export function sameOriginWrite(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string') return false
  try {
    if (new URL(origin).host.toLowerCase() !== String(req.headers.host || '').toLowerCase()) return false
  } catch {
    return false
  }
  const site = req.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin'
}

function fail(res, status, code, message, details) {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } })
}

function loopbackAddress(address) {
  const value = String(address || '').toLowerCase()
  return value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.')
}

// From this machine, straight to this server: a loopback peer, a loopback
// Host, no proxy headers (a proxy on this machine would make every visitor
// look local), and no other site's Origin.
export function localRequest(req) {
  if (!loopbackAddress(req.socket?.remoteAddress)) return false
  if (PROXY_HEADERS.some((name) => req.headers[name] !== undefined)) return false
  const host = String(req.headers.host || '')
  if (!LOOPBACK_NAMES.has(host.replace(/:\d+$/, '').toLowerCase())) return false
  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      if (new URL(origin).host.toLowerCase() !== host.toLowerCase()) return false
    } catch {
      return false
    }
  }
  return true
}

// Why the screen is not available for this request, or null.
export function settingsRefusal(req, { shared }) {
  if (shared) {
    return {
      code: 'settings_shared',
      message:
        'This board is shared beyond this machine, so its agent settings cannot be changed from the board. Change them on a board served only to this machine, in the environment, or in shapewall.config.json.',
    }
  }
  if (!localRequest(req)) {
    return { code: 'settings_remote', message: 'Agent settings can be changed only from a browser on the machine that runs Shapewall.' }
  }
  return null
}

// The variables holding a model key that are set, by name only: so the screen
// can say whether the one typed in is there.
function keyVarsSet(env) {
  return Object.keys(env)
    .filter((name) => KEY_VAR_RE.test(name) && !DENIED_KEY_VARS.has(name) && typeof env[name] === 'string' && env[name].trim())
    .sort()
}

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}

// What saving `entry` would need the person to confirm: a new ACP command,
// and hosts the key would newly go to. Also returns the key hosts to save,
// with the host of the base URL in effect added when it is not otherwise
// confirmed.
//
// A host is allowed for one key variable: the pair (apiKeyEnv, host). Naming
// another variable for the same host asks again.
export function pendingConfirmations(entry, { saved, repo, env }) {
  const confirm = []
  // A command already saved for this project (the default connection or a
  // profile) was confirmed then: moving it between the two asks nothing.
  const approved = new Set([saved.acpCommand, ...(saved.profiles || []).map((item) => item.acpCommand)].filter(Boolean))
  if (entry.acpCommand && !approved.has(entry.acpCommand)) confirm.push({ kind: 'command', command: entry.acpCommand })
  for (const profile of entry.profiles || []) {
    if (!approved.has(profile.acpCommand)) {
      if (!confirm.some((item) => item.kind === 'command' && item.command === profile.acpCommand))
        confirm.push({ kind: 'command', command: profile.acpCommand })
    }
  }
  const keyHosts = [...(entry.keyHosts || [])]
  const backend = entry.backend ?? repo.backend ?? 'openai-compatible'
  const keyVar = entry.apiKeyEnv ?? repo.apiKeyEnv ?? DEFAULT_KEY_VAR
  const url = env.SHAPEWALL_AGENT_BASE_URL ? null : (entry.baseUrl ?? repo.baseUrl)
  const host = backend === 'openai-compatible' && url ? hostOf(url) : null
  const forVar = keyHosts.filter((pair) => pair.apiKeyEnv === keyVar).map((pair) => pair.host)
  if (host && !keyHostConfirmed(host, { env, hosts: forVar })) keyHosts.push({ host, apiKeyEnv: keyVar })
  const known = (pair) => (saved.keyHosts || []).some((item) => item.host === pair.host && item.apiKeyEnv === pair.apiKeyEnv)
  for (const pair of keyHosts) if (!known(pair)) confirm.push({ kind: 'host', host: pair.host, keyVar: pair.apiKeyEnv })
  return { confirm, keyHosts }
}

// Binds a confirmation to the exact items the dialog showed.
export function confirmHash(items) {
  return crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 32)
}

// Tries the settings in effect. { ok, backend, label, host, sendsKey, message, details }
export async function testConnection(settings, { env = process.env, fetchImpl = globalThis.fetch, root, timeoutMs, processPool } = {}) {
  const head = {
    backend: settings.backend,
    label: settings.label,
    host: settings.host,
    sendsKey: Boolean(settings.hasKey && settings.host),
  }
  if (!settings.configured)
    return { ...head, ok: false, message: `Not connected: ${settings.problem || 'set a base URL and a model'}.`, details: [] }
  if (settings.backend === 'acp') {
    const result = await acpHandshake(settings, { env, root, timeoutMs: timeoutMs || ACP_TEST_TIMEOUT_MS, processPool })
    if (!result.ok)
      return { ...head, ok: false, code: result.code, message: `${settings.label} did not start: ${result.message}`, details: [] }
    const info = result.agentInfo
    const name = info ? `${info.title || info.name}${info.version ? ` ${info.version}` : ''}` : settings.label
    // The handshake does not show whether the agent is logged in (that needs
    // a prompt, which would spend the subscription): say so, and how to fix it.
    return {
      ...head,
      ok: true,
      message: `Handshake ok, login not checked: ${name} started and answered.`,
      vision: Boolean(result.image),
      details: [
        result.image ? 'It takes images.' : 'It does not take images.',
        ...(result.choices || []),
        `If the first message says it is not logged in: ${loginHint(settings.acp.argv)}.`,
        'The agent was stopped again; chats start their own.',
      ],
    }
  }
  const key = agentKey(settings, env)
  const details = []
  const call = async (path, init) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs || TEST_TIMEOUT_MS)
    try {
      const headers = { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) }
      if (key) headers.Authorization = `Bearer ${key}`
      const response = await fetchImpl(`${settings.baseUrl}${path}`, { ...init, headers, redirect: 'error', signal: controller.signal })
      const text = (await response.text().catch(() => '')).slice(0, 200000)
      return { response, text }
    } catch (error) {
      const reason = controller.signal.aborted ? 'timed out' : redact(error.cause?.code || error.message, key)
      throw Object.assign(new Error(`Could not reach ${settings.host} (${reason}).`), { unreachable: true })
    } finally {
      clearTimeout(timer)
    }
  }
  // Does the model take images? Best effort, never a failure: a model list
  // that says (OpenRouter's architecture.input_modalities), then Ollama's
  // /api/show capabilities. null when nothing says.
  const probeVision = async (listedText) => {
    try {
      const entry = (JSON.parse(listedText || '{}')?.data || []).find((item) => item?.id === settings.model)
      const modalities = entry?.architecture?.input_modalities ?? entry?.input_modalities
      if (Array.isArray(modalities)) return modalities.includes('image')
    } catch {
      // not JSON: no answer here
    }
    // Only for a server used without a key (Ollama and the like), never a hosted API.
    if (key || !/\/v1$/.test(settings.baseUrl)) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), VISION_PROBE_MS)
    try {
      // Ollama's own API on the same server: no key needed, none sent.
      const response = await fetchImpl(`${settings.baseUrl.replace(/\/v1$/, '')}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model: settings.model }),
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) return null
      const capabilities = (await response.json().catch(() => null))?.capabilities
      return Array.isArray(capabilities) ? capabilities.includes('vision') : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
  const visionLine = (vision) =>
    vision === true ? ['The model takes images.'] : vision === false ? ['The model does not take images.'] : []
  try {
    const listed = await call('/models', { method: 'GET' })
    if (listed.response.ok) {
      let ids = []
      try {
        ids = (JSON.parse(listed.text)?.data || []).map((item) => String(item?.id ?? '')).filter(Boolean)
      } catch {
        ids = []
      }
      if (ids.includes(settings.model)) {
        const vision = await probeVision(listed.text)
        return {
          ...head,
          ok: true,
          message: `Connected: ${settings.host} lists ${settings.model}.`,
          vision,
          details: [`${ids.length} models listed.`, ...visionLine(vision)],
        }
      }
      details.push(
        ids.length
          ? `${settings.model} is not in the ${ids.length} models listed; asked it for a one-token answer.`
          : 'No model list; asked for a one-token answer.',
      )
    } else if (listed.response.status === 401 || listed.response.status === 403) {
      return { ...head, ok: false, message: upstreamError(listed.response.status, listed.text, key).message, details }
    } else {
      details.push(`GET /models answered ${listed.response.status}; asked for a one-token answer instead.`)
    }
    const body = { model: settings.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 5, stream: false }
    const answered = await call('/chat/completions', { method: 'POST', body: JSON.stringify(body) })
    if (!answered.response.ok)
      return { ...head, ok: false, message: upstreamError(answered.response.status, answered.text, key).message, details }
    const vision = await probeVision(listed.response.ok ? listed.text : null)
    return {
      ...head,
      ok: true,
      message: `Connected: ${settings.model} at ${settings.host} answered.`,
      vision,
      details: [...details, ...visionLine(vision)],
    }
  } catch (error) {
    if (error.unreachable) return { ...head, ok: false, message: error.message, details }
    throw error
  }
}

// `settings()` is the router's (src/agent/routes.js): what is in effect now.
// `repo` is the config's `agent`. `busy()` is true while an answer is being
// written, `reload()` switches the chat over to new settings.
// `token` is the per-process settings token (null: the routes are off).
export function settingsRoutes({ config, env, fetchImpl, settings, shared, token, busy, reload, processPool, health = null }) {
  const router = express.Router()
  const repo = () => config.agent || {}
  let testing = false
  let closing = false
  const pending = new Set()
  router.close = async () => {
    closing = true
    while (pending.size) await Promise.all([...pending])
  }
  // Shared admission lock: a handshake must not overlap live turns or profile changes.
  router.isTesting = () => testing

  const guard = (req, res, next) => {
    if (closing) return fail(res, 503, 'settings_stopping', 'Agent settings are stopping.')
    if (['device', 'identity'].includes(req.shapewallAccess?.kind))
      return fail(res, 403, 'settings_remote', 'Change this on the computer running Shapewall.')
    if (!settingsTokenOk(req, token)) return fail(res, 404, 'not_found', 'No such API route.')
    const refusal = settingsRefusal(req, { shared })
    if (refusal) return fail(res, 403, refusal.code, refusal.message)
    if (req.method !== 'GET' && !sameOriginWrite(req)) {
      return fail(res, 403, 'settings_origin', 'Agent settings are saved only from the board page itself.')
    }
    next()
  }

  router.use(async (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
    // Authorize before taking admission so an outsider cannot block turns.
    let allowed = false
    guard(req, res, () => {
      allowed = true
    })
    if (!allowed) return
    if (testing) return fail(res, 409, 'test_running', 'A connection test is already running.')
    let finishOperation
    const operation = new Promise((resolve) => {
      finishOperation = () => {
        pending.delete(operation)
        resolve()
      }
    })
    pending.add(operation)
    const admission = new AbortController()
    let release
    const finished = () => {
      if (!testing) release?.().catch(() => {})
    }
    res.once('finish', finished)
    res.once('close', () => {
      admission.abort()
      finished()
    })
    if (req.aborted || res.destroyed) admission.abort()
    try {
      const lease = await beginAgentOperation(config, env, 'settings', { signal: admission.signal })
      if (lease) release = () => lease().finally(finishOperation)
    } catch {
      finishOperation()
      if (admission.signal.aborted) return
      return fail(res, 503, 'agent_activity_unavailable', 'Agent activity could not be checked. Inspect this installation before retrying.')
    }
    if (admission.signal.aborted || closing) {
      if (release) await release()
      else finishOperation()
      return
    }
    if (!release) {
      finishOperation()
      return fail(
        res,
        409,
        'agent_running',
        'An agent turn or settings operation is active for this source project. Wait for it to finish.',
      )
    }
    res.locals.releaseSettingsOperation = release
    next()
  })

  // How an agent is doing (agent-health.js): { state, loginHint }.
  const statusOf = (profileId) => (health ? health.status(settings(profileId), processPool) : {})
  const profileList = (entry) => {
    const legacy = legacyProfile(entry, KNOWN_AGENTS)
    // Profiles saved without a default connection: the first one (config.js agentSettings).
    const fallback = settings().defaultProfile || null
    return [...(legacy ? [{ ...legacy, legacy: true }] : []), ...(entry?.profiles || [])].map(({ acpCommand, ...profile }) => ({
      ...profile,
      command: acpCommand,
      default: (entry?.backend === 'acp' && entry.acpCommand === acpCommand) || profile.id === fallback,
      // A legacy command runs as the default connection.
      ...statusOf(profile.legacy ? null : profile.id),
    }))
  }
  // The saved OpenAI-compatible endpoint (Settings "Other"), or null.
  const endpointOf = (entry) => {
    const baseUrl = entry.baseUrl ?? repo().baseUrl
    const model = entry.model ?? repo().model
    if (!baseUrl || !model) return null
    const backend = entry.backend ?? repo().backend ?? 'openai-compatible'
    const isDefault = backend === 'openai-compatible' && !settings().defaultProfile
    return {
      label: entry.label || repo().label || model,
      model,
      host: hostOf(baseUrl),
      default: isDefault,
      ...(isDefault ? statusOf(null) : {}),
    }
  }

  const view = () => {
    const current = settings()
    const saved = userAgentEntry(config.dir, env)
    return {
      editable: true,
      file: current.settingsFile,
      fileProblem: saved.problem,
      saved: saved.entry || {},
      // Every connected native agent, the one list Settings and the chat
      // show: the saved profiles, and a default command saved before
      // profiles (legacy) as one of them.
      profiles: profileList(saved.entry),
      endpoint: endpointOf(saved.entry || {}),
      project: { root: projectKey(config.dir), configFile: config.file || null },
      config: Object.fromEntries(SAVED_KEYS.filter((key) => repo()[key] !== undefined).map((key) => [key, repo()[key]])),
      effective: {
        backend: current.backend,
        configured: current.configured,
        problem: current.problem,
        label: current.label,
        baseUrl: current.baseUrl,
        model: current.model,
        host: current.host,
        keyVar: current.keyVar,
        hasKey: current.hasKey,
        keyVarNamed: Boolean(current.keyVarNamed),
        vision: current.vision !== false,
        keyHosts: current.keyHosts,
        acpCommand: current.acp?.argv ? formatCommand(current.acp.argv) : null,
        refusedEnv: current.acp?.refusedEnv || [],
        sources: current.sources || {},
      },
      env: {
        baseUrl: Boolean(env.SHAPEWALL_AGENT_BASE_URL),
        model: Boolean(env.SHAPEWALL_AGENT_MODEL),
        acp: current.sources?.acpCommand === 'flag' || current.sources?.acpCommand === 'env' ? current.sources.acpCommand : null,
        keyHosts: envKeyHosts(env),
      },
      // The agent CLIs found on PATH (looked up, never started), for the
      // one-click Connect in an unconnected chat panel.
      detected: detectAgents(env),
      knownKeyHosts: [...KNOWN_KEY_HOSTS],
      defaultKeyVar: DEFAULT_KEY_VAR,
      keyVarsSet: keyVarsSet(env),
    }
  }

  // Paired owner devices see the effective configuration, never host paths,
  // detected binaries, environment contents, or editable capabilities.
  router.get(
    '/',
    (req, res, next) => {
      if (!['device', 'identity'].includes(req.shapewallAccess?.kind)) return next()
      // The same public summary the board gets (/api/agent): no command line, endpoint path or key variable.
      res.json({ editable: false, effective: publicAgentInfo(settings()), message: 'Change this on the computer running Shapewall.' })
    },
    guard,
    (req, res) => res.json(view()),
  )

  // Saves `entry` after its confirmations (a new command, new key hosts):
  // answers { confirm, confirmHash } and saves nothing until the request
  // carries that hash. Returns true when saved; otherwise it answered.
  const saveEntry = (req, res, entry) => {
    if (entry.updatedAt) delete entry.updatedAt
    const saved = userAgentEntry(config.dir, env)
    if (saved.problem) {
      fail(res, 409, 'settings_file_invalid', saved.problem)
      return false
    }
    const { confirm, keyHosts } = pendingConfirmations(entry, { saved: saved.entry || {}, repo: repo(), env })
    for (const item of confirm) if (item.kind === 'command') item.projectRoot = projectKey(config.dir)
    const hash = confirmHash(confirm)
    if (confirm.length && req.body?.confirm !== hash) {
      // Not an error: the board shows these items and sends their hash back
      // (other items, or none, ask again). Nothing is saved.
      res.json({ confirm, confirmHash: hash })
      return false
    }
    if (busy()) {
      fail(res, 409, 'agent_running', 'An answer is still being written. Stop it, then save.')
      return false
    }
    const next = { ...entry }
    if (keyHosts.length) next.keyHosts = keyHosts
    else delete next.keyHosts
    try {
      saveUserAgentEntry(config.dir, next, env)
    } catch (error) {
      fail(
        res,
        500,
        error.code === 'no_settings_file' ? 'no_settings_file' : 'settings_not_saved',
        `The settings were not saved: ${error.message}`,
      )
      return false
    }
    reload()
    return true
  }

  router.post('/', guard, (req, res) => {
    const input = req.body?.settings
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return fail(res, 400, 'invalid_settings', 'The settings must be an object.')
    // Old clients save only the default connection. Keep their saved profiles.
    const preserved = input && !Object.hasOwn(input, 'profiles') ? userAgentEntry(config.dir, env).entry?.profiles : undefined
    const { entry, problems } = validateUserEntry({ ...input, ...(preserved ? { profiles: preserved } : {}) })
    if (!entry) return fail(res, 400, 'invalid_settings', problems.join('; '))
    // A Connect is testing what it saved and may put the old settings back:
    // a save now would be lost.
    if (testing) return fail(res, 409, 'test_running', 'A connection test is running. Wait for it, then save.')
    if (saveEntry(req, res, entry)) res.json(view())
  })

  // One-click Connect: { agentId, confirm }. The command is this server's own
  // restricted one for that agent (src/agent/acp/detect.js), never one the
  // board sends, and only for an agent found on PATH. Saving it asks the same
  // confirmation as any new command. Then the connection test runs; when the
  // agent does not start, what was saved before is put back.
  // { connected, result, ...view }
  router.post(['/connect', '/profiles/connect'], guard, async (req, res) => {
    const profileConnect = req.path === '/profiles/connect'
    const agent = KNOWN_AGENTS.find((item) => item.id === req.body?.agentId)
    if (!agent) return fail(res, 400, 'unknown_agent', `agentId: one of ${KNOWN_AGENTS.map((item) => item.id).join(', ')}`)
    const found = detectAgents(env).find((item) => item.id === agent.id)
    if (found?.state !== 'ready') {
      return fail(res, 409, 'agent_not_found', `${agent.label} is not installed on this machine (${agent.adapter} is not on PATH).`)
    }
    if (testing) return fail(res, 409, 'test_running', 'A connection test is already running.')
    // --agent-acp or SHAPEWALL_AGENT_ACP wins over anything saved: Connect would save one thing and run another.
    const source = settings().sources?.acpCommand
    if (source === 'flag' || source === 'env') {
      return fail(
        res,
        409,
        'acp_overridden',
        `The agent command comes from ${source === 'flag' ? '--agent-acp' : 'SHAPEWALL_AGENT_ACP'}, which wins over the board. Change it there, or restart shapewall serve without it.`,
      )
    }
    const before = userAgentEntry(config.dir, env)
    // The label and the image toggle belong to the agent connected before.
    const entry = { ...(before.entry || {}) }
    if (profileConnect) {
      // A default command saved before profiles becomes a profile too, so
      // the list stays the one place every connected agent is shown.
      const legacy = legacyProfile(entry, KNOWN_AGENTS)
      entry.profiles = [
        ...(legacy && legacy.id !== agent.id ? [legacy] : []),
        ...(entry.profiles || []).filter((item) => item.id !== agent.id),
        { id: agent.id, label: agent.label, acpCommand: agent.command },
      ]
    }
    if (!profileConnect || !settings().configured) {
      entry.backend = 'acp'
      entry.acpCommand = agent.command
      delete entry.label
      delete entry.vision
    }
    if (!saveEntry(req, res, entry)) return
    // Back to what was there: the panel must not claim an agent that does not start.
    const restore = () => {
      try {
        saveUserAgentEntry(config.dir, before.entry || {}, env)
      } finally {
        reload()
      }
    }
    testing = true
    try {
      const tested = settings(profileConnect ? agent.id : null)
      const result = await testConnection(tested, { env, fetchImpl, root: config.dir, processPool })
      health?.record(tested, result)
      if (!result.ok) restore()
      res.json({ connected: result.ok, result: { ...result, label: agent.label }, ...view() })
    } catch (error) {
      try {
        restore()
      } catch {
        // the message below says the test did not finish; the settings screen shows what is saved
      }
      fail(res, 500, 'test_failed', `The test did not finish: ${redact(error.message)}`)
    } finally {
      testing = false
      await res.locals.releaseSettingsOperation?.()
    }
  })

  // The agent new chats and fixes use: a connected agent (its command
  // becomes the default connection) or "endpoint" (the saved
  // OpenAI-compatible endpoint). Every command here was confirmed when it
  // was connected, so this asks nothing new. Chats that chose an agent keep it.
  router.post('/profiles/:id/default', guard, (req, res) => {
    if (testing) return fail(res, 409, 'test_running', 'A connection test is running.')
    const source = settings().sources?.acpCommand
    if (source === 'flag' || source === 'env')
      return fail(res, 409, 'acp_overridden', 'The agent command comes from the command line or the environment, which wins over Settings.')
    const saved = userAgentEntry(config.dir, env)
    if (saved.problem) return fail(res, 409, 'settings_file_invalid', saved.problem)
    const current = saved.entry || {}
    const legacy = legacyProfile(current, KNOWN_AGENTS)
    const entry = { ...current }
    // A default command saved before profiles stays in the list, as a profile.
    if (legacy) entry.profiles = [legacy, ...(current.profiles || [])]
    if (req.params.id === 'endpoint') {
      if (!endpointOf(current)) return fail(res, 400, 'no_endpoint', 'Set up an OpenAI-compatible endpoint first.')
      entry.backend = 'openai-compatible'
      delete entry.acpCommand
    } else {
      const profile = (entry.profiles || []).find((item) => item.id === req.params.id)
      if (!profile) return fail(res, 404, 'unknown_profile', 'That agent is not connected.')
      // The image toggle belonged to the agent that was the default (as on Connect).
      if (profileForDefault(current)?.acpCommand !== profile.acpCommand) delete entry.vision
      entry.backend = 'acp'
      entry.acpCommand = profile.acpCommand
    }
    if (saveEntry(req, res, entry)) res.json(view())
  })

  router.delete('/profiles/:id', guard, (req, res) => {
    if (testing) return fail(res, 409, 'test_running', 'A connection test is running.')
    const saved = userAgentEntry(config.dir, env)
    if (saved.problem) return fail(res, 409, 'settings_file_invalid', saved.problem)
    const current = saved.entry || {}
    const legacy = legacyProfile(current, KNOWN_AGENTS)
    const removed = (current.profiles || []).find((item) => item.id === req.params.id) || (legacy?.id === req.params.id ? legacy : null)
    const entry = { ...current, profiles: (current.profiles || []).filter((item) => item.id !== req.params.id) }
    // Removing the agent new chats use moves them to the next profile, or
    // leaves the chat unconnected when it was the last one.
    if (removed && current.backend === 'acp' && current.acpCommand === removed.acpCommand) {
      const next = entry.profiles.find((item) => item.acpCommand === removed.acpCommand) || entry.profiles[0]
      if (next) entry.acpCommand = next.acpCommand
      else {
        delete entry.acpCommand
        delete entry.backend
      }
    }
    if (saveEntry(req, res, entry)) res.json(view())
  })

  router.post('/test', guard, async (req, res) => {
    if (testing) return fail(res, 409, 'test_running', 'A connection test is already running.')
    if (busy()) return fail(res, 409, 'agent_running', 'Stop the answer or wait for the profile change before testing.')
    const profileId = req.body?.profileId ?? null
    if (profileId !== null && !(userAgentEntry(config.dir, env).entry?.profiles || []).some((item) => item.id === profileId))
      return fail(res, 400, 'unknown_profile', 'profileId: one of the connected agents.')
    testing = true
    try {
      const tested = settings(profileId)
      const result = await testConnection(tested, { env, fetchImpl, root: config.dir, processPool })
      health?.record(tested, result)
      res.json(result)
    } catch (error) {
      fail(res, 500, 'test_failed', `The test did not finish: ${redact(error.message)}`)
    } finally {
      testing = false
      await res.locals.releaseSettingsOperation?.()
    }
  })

  return router
}
