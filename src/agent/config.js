// The `agent` config key and what the chat panel is connected to.
//
// Shapewall never holds a model: the chat panel talks to an agent the user
// connects. That is either any OpenAI-compatible chat completions endpoint
// (OpenAI, DeepSeek, xAI, OpenRouter, Ollama, LM Studio, ...), or an agent CLI
// on this machine that speaks the Agent Client Protocol (Claude Code, Codex,
// goose, Gemini CLI), started from the command the person gives
// (src/agent/acp/command.js). The API key is read from the environment for
// the request that needs it, and never written to a file, a log line, a
// thread or an API response.

import { ACP_COMMAND_VAR, ACP_FLAG, SETTINGS_SOURCE, acpCommand, extraVarNames } from './acp/command.js'
import { userAgentEntry } from './user-settings.js'

export const AGENT_BACKENDS = ['openai-compatible', 'acp']
// A config is usually committed. A command in it would run on the machine of
// anyone who chats on a board from that repo, so these keys are refused.
export const COMMAND_KEYS = ['command', 'cmd', 'exec', 'acp', 'acpCommand', 'program', 'args', 'argv', 'env']
export const DEFAULT_KEY_VAR = 'SHAPEWALL_AGENT_API_KEY'
export const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]{0,63}$/
// A config is often committed, so it may only name a variable that is plainly
// a model key: SHAPEWALL_AGENT_* or *_API_KEY. Never another tool's secret.
export const KEY_VAR_RE = /^(SHAPEWALL_AGENT_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_API_KEY)$/
export const DENIED_KEY_VARS = new Set([
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'SHAPEWALL_GITHUB_TOKEN',
  'SHAPEWALL_GITHUB_WEBHOOK_SECRET',
  'SHAPEWALL_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'SHAPEWALL_AGENT_BASE_URL',
  'SHAPEWALL_AGENT_MODEL',
  'SHAPEWALL_AGENT_KEY_HOSTS',
])
// Hosts a key may go to without a confirmation: the big hosted APIs. Any
// other host named only by the config must be confirmed from the environment
// (SHAPEWALL_AGENT_KEY_HOSTS, or the URL itself in SHAPEWALL_AGENT_BASE_URL),
// so a committed config cannot send your key somewhere else.
export const KNOWN_KEY_HOSTS = new Set([
  'api.openai.com',
  'api.deepseek.com',
  'api.x.ai',
  'openrouter.ai',
  'api.groq.com',
  'api.mistral.ai',
  'api.together.xyz',
  'api.fireworks.ai',
])
export const KEY_HOSTS_VAR = 'SHAPEWALL_AGENT_KEY_HOSTS'
export const DOCS_URL = 'https://shapewall.com/docs/chat'
const LABEL_MAX = 60
const MODEL_MAX = 200
const MAX_TOKENS_MAX = 200000
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

// Validates `agent` in shapewall.config.json. Pushes one message per problem.
export function validateAgent(raw, problems) {
  if (raw === undefined || raw === null) return null
  if (!isObject(raw)) {
    problems.push('agent: an object such as { "baseUrl": "http://127.0.0.1:11434/v1", "model": "llama3.2" }')
    return null
  }
  for (const key of ['apiKey', 'key', 'token', 'secret', 'password']) {
    if (raw[key] !== undefined) {
      problems.push(`agent.${key}: never put secrets in the config; set ${DEFAULT_KEY_VAR} (or the variable named in agent.apiKeyEnv)`)
    }
  }
  for (const key of COMMAND_KEYS) {
    if (raw[key] !== undefined) {
      problems.push(
        `agent.${key}: Shapewall never takes an agent command from the config (a repo could run code on your machine); start shapewall serve ${ACP_FLAG} "<command>" or set ${ACP_COMMAND_VAR}`,
      )
    }
  }
  const backend = raw.backend ?? 'openai-compatible'
  if (!AGENT_BACKENDS.includes(backend)) {
    problems.push(`agent.backend: one of ${AGENT_BACKENDS.join(', ')} (got ${JSON.stringify(raw.backend)})`)
  }
  let baseUrl = null
  if (raw.baseUrl !== undefined) {
    if (typeof raw.baseUrl !== 'string' || !isHttpUrl(raw.baseUrl))
      problems.push('agent.baseUrl: an http(s) URL such as https://api.openai.com/v1')
    else baseUrl = raw.baseUrl
  }
  let model = null
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || !raw.model.trim() || raw.model.length > MODEL_MAX) problems.push('agent.model: a model name')
    else model = raw.model.trim()
  }
  let apiKeyEnv = null
  if (raw.apiKeyEnv !== undefined) {
    if (typeof raw.apiKeyEnv !== 'string' || !ENV_VAR_RE.test(raw.apiKeyEnv)) {
      problems.push('agent.apiKeyEnv: the name of an environment variable, such as DEEPSEEK_API_KEY')
    } else if (!KEY_VAR_RE.test(raw.apiKeyEnv) || DENIED_KEY_VARS.has(raw.apiKeyEnv)) {
      problems.push(
        `agent.apiKeyEnv: "${raw.apiKeyEnv}" is not a model key variable; use SHAPEWALL_AGENT_API_KEY or a name ending in _API_KEY (never another tool's token)`,
      )
    } else apiKeyEnv = raw.apiKeyEnv
  }
  const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, LABEL_MAX) : null
  if (raw.label !== undefined && typeof raw.label !== 'string') problems.push('agent.label: a short name shown in the chat panel')
  for (const key of ['vision', 'tools']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') problems.push(`agent.${key}: true or false`)
  }
  let maxTokens = null
  if (raw.maxTokens !== undefined) {
    if (!Number.isInteger(raw.maxTokens) || raw.maxTokens < 1 || raw.maxTokens > MAX_TOKENS_MAX) {
      problems.push(`agent.maxTokens: a whole number from 1 to ${MAX_TOKENS_MAX}`)
    } else maxTokens = raw.maxTokens
  }
  let temperature = null
  if (raw.temperature !== undefined) {
    if (typeof raw.temperature !== 'number' || raw.temperature < 0 || raw.temperature > 2) problems.push('agent.temperature: 0 to 2')
    else temperature = raw.temperature
  }
  return {
    backend: AGENT_BACKENDS.includes(backend) ? backend : 'openai-compatible',
    baseUrl,
    model,
    apiKeyEnv,
    label: label || null,
    vision: raw.vision !== false,
    tools: raw.tools !== false,
    maxTokens,
    temperature,
  }
}

// An API key goes to https, or to plain http only on this machine (a local
// model server or a test stub), so it never crosses a network in the clear.
// Without a key, http anywhere is fine (Ollama on another box in the LAN).
export function checkBaseUrl(value, { withKey }) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:') return null
    if (url.protocol === 'http:' && (!withKey || LOOPBACK.has(url.hostname))) return null
    if (url.protocol === 'http:') return 'with an API key the endpoint must be https (plain http only on 127.0.0.1 or localhost)'
    return 'the endpoint must be an http(s) URL'
  } catch {
    return 'the endpoint is not a URL'
  }
}

// The key, for the request that needs it. Never stored or returned.
export function agentKey(settings, env = process.env) {
  const value = typeof env[settings.keyVar] === 'string' ? env[settings.keyVar].trim() : ''
  return value || null
}

// What the chat is connected to, without secrets. The environment wins over
// the settings saved from the board (src/agent/user-settings.js), which win
// over the config: SHAPEWALL_AGENT_BASE_URL and SHAPEWALL_AGENT_MODEL try a
// key and an endpoint without editing anything.
//
// An ACP command (`acp`, from --agent-acp, or SHAPEWALL_AGENT_ACP) wins over
// any endpoint: it is the person's own choice on this machine. A command saved
// in Settings > Agent counts when the backend is "acp".
export function agentSettings(config, env = process.env, { acp = null, profileId = null } = {}) {
  const repo = config.agent || {}
  const saved = config.dir ? userAgentEntry(config.dir, env) : { file: null, entry: null, problem: null }
  const user = saved.entry || {}
  if (profileId && profileId !== 'default') {
    // An operator override remains authoritative, including for old threads.
    if (acp || env.SHAPEWALL_AGENT_ACP)
      return { profileId, configured: false, backend: 'acp', problem: 'Native profiles are disabled by the operator agent command.' }
    const profile = user.profiles?.find((item) => item.id === profileId)
    if (!profile) return { profileId, configured: false, backend: 'acp', problem: 'This native agent profile is no longer saved.' }
    const command = acpCommand({ env, saved: profile.acpCommand })
    return withProblem(
      {
        ...acpSettings(command, env),
        label: profile.label,
        profileId,
        settingsFile: saved.file,
        sources: { backend: 'settings', acpCommand: 'settings' },
      },
      saved.problem,
    )
  }
  const base = { ...repo }
  for (const key of SAVED_KEYS) if (user[key] !== undefined) base[key] = user[key]
  const from = (key, envVar) =>
    envVar && env[envVar] ? 'env' : user[key] !== undefined ? 'settings' : repo[key] !== undefined ? 'config' : null
  const extra = { settingsFile: saved.file, settingsProblem: saved.problem, keyHosts: user.keyHosts || [] }
  const command = acpCommand({ flag: acp, env, saved: base.backend === 'acp' ? user.acpCommand : null })
  if (command || base.backend === 'acp') {
    const backendSource = command && command.source !== SETTINGS_SOURCE ? (command.source === ACP_FLAG ? 'flag' : 'env') : from('backend')
    const sources = {
      backend: backendSource,
      acpCommand: command ? (command.source === SETTINGS_SOURCE ? 'settings' : backendSource) : null,
    }
    return withProblem({ ...acpSettings(command, env), vision: base.vision !== false, ...extra, sources }, saved.problem)
  }
  const baseUrl = String(env.SHAPEWALL_AGENT_BASE_URL || base.baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
  const model = String(env.SHAPEWALL_AGENT_MODEL || base.model || '').trim()
  const keyVar = base.apiKeyEnv || DEFAULT_KEY_VAR
  const hasKey = Boolean(typeof env[keyVar] === 'string' && env[keyVar].trim())
  const urlError = baseUrl ? checkBaseUrl(baseUrl, { withKey: hasKey }) : null
  const host = baseUrl && !urlError ? new URL(baseUrl).host.toLowerCase() : null
  const keyHostError =
    hasKey &&
    host &&
    !keyHostConfirmed(host, {
      fromEnv: Boolean(env.SHAPEWALL_AGENT_BASE_URL),
      env,
      // Allowed in Settings > Agent for this key variable only.
      hosts: extra.keyHosts.filter((pair) => pair.apiKeyEnv === keyVar).map((pair) => pair.host),
    })
      ? keyHostProblem(host)
      : null
  const missing = [!baseUrl && 'agent.baseUrl', !model && 'agent.model'].filter(Boolean)
  const settings = {
    backend: base.backend || 'openai-compatible',
    baseUrl: baseUrl || null,
    model: model || null,
    label: base.label || model || null,
    keyVar,
    hasKey,
    // A key variable named on purpose (settings or config), not the default:
    // without one and without a key, a local server needs no key nudge.
    keyVarNamed: Boolean(base.apiKeyEnv),
    // Where the requests (and the key, when there is one) go: host[:port] only.
    host,
    vision: base.vision !== false,
    tools: base.tools !== false,
    maxTokens: base.maxTokens ?? null,
    temperature: base.temperature ?? null,
    problem: urlError || keyHostError || (missing.length && (baseUrl || model) ? `set ${missing.join(' and ')}` : null),
    configured: Boolean(baseUrl && model && !urlError && !keyHostError),
    ...extra,
    // Where each value comes from: env | settings | config | null.
    sources: {
      backend: from('backend'),
      baseUrl: from('baseUrl', 'SHAPEWALL_AGENT_BASE_URL'),
      model: from('model', 'SHAPEWALL_AGENT_MODEL'),
      apiKeyEnv: from('apiKeyEnv'),
      label: from('label'),
      vision: from('vision'),
    },
  }
  return withProblem(settings, saved.problem)
}

// What Settings > Agent saves, besides key hosts and the ACP command.
export const SAVED_KEYS = ['backend', 'baseUrl', 'model', 'apiKeyEnv', 'label', 'vision']

// A broken settings file is said, not skipped: falling back to the config
// without a word could send the chat somewhere the person did not choose.
function withProblem(settings, problem) {
  return problem ? { ...settings, problem, configured: false } : settings
}

// Settings for an ACP agent. The command line stays on the server: the board
// sees the agent's name only.
function acpSettings(command, env) {
  const problem = command
    ? command.problem
    : `an ACP agent needs its command: save it in Settings > Agent, start shapewall serve ${ACP_FLAG} "<command>", or set ${ACP_COMMAND_VAR} (the command never comes from the config)`
  return {
    backend: 'acp',
    baseUrl: null,
    model: null,
    label: command?.label || 'ACP agent',
    keyVar: null,
    hasKey: false,
    host: null,
    local: true,
    vision: true,
    tools: false,
    maxTokens: null,
    temperature: null,
    acp: command ? { argv: command.argv, source: command.source, refusedEnv: extraVarNames(env).refused } : null,
    problem: problem || null,
    configured: Boolean(command && !command.problem),
  }
}

const LOOPBACK_HOST_RE = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?$/

// May a key from the environment go to this host? Yes when the environment
// chose the URL, for this machine, for the known hosted APIs, and for hosts
// listed in SHAPEWALL_AGENT_KEY_HOSTS or confirmed in Settings > Agent
// (`hosts`). Not for a host only the config names.
export function keyHostConfirmed(host, { fromEnv = false, env = process.env, hosts = [] } = {}) {
  if (fromEnv || LOOPBACK_HOST_RE.test(host) || KNOWN_KEY_HOSTS.has(host.replace(/:443$/, ''))) return true
  const listed = [...envKeyHosts(env), ...hosts.map((item) => item.toLowerCase())]
  return listed.includes(host) || listed.includes(host.replace(/:\d+$/, ''))
}

export function envKeyHosts(env = process.env) {
  return String(env[KEY_HOSTS_VAR] || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function keyHostProblem(host) {
  const name = host.replace(/:\d+$/, '')
  return `the API key would go to ${host}, which only the config names; confirm that host in Settings > Agent or with ${KEY_HOSTS_VAR}=${name}, or set the URL in SHAPEWALL_AGENT_BASE_URL`
}

// What the board may know: whether chat works, what it is called and which
// host it talks to. Never the key, its variable or the full endpoint URL.
export function publicAgentInfo(settings) {
  return {
    configured: settings.configured,
    backend: settings.backend,
    label: settings.configured ? settings.label : null,
    model: settings.configured ? settings.model : null,
    host: settings.host,
    // An ACP agent: a process on the server's machine, not an endpoint.
    local: Boolean(settings.local),
    sendsKey: settings.hasKey,
    vision: settings.vision,
    problem: settings.problem,
    docsUrl: DOCS_URL,
  }
}
