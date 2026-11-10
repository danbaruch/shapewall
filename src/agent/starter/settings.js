// What the starter agent runs with: the `starterAgent` config key, the
// flags and the environment.
//
// The config is usually committed, so it may choose only what stays inside
// the sandbox: who may dispatch work (per board), the test and setup
// commands (they run in the container), budgets, container limits, the
// branch prefix and the pull request base. What decides what leaves the
// sandbox comes only from the person running Shapewall: the image (the
// proxy runs from it), the runtime, the package registry and any extra
// egress host (flags or environment). The model endpoint and key follow the
// chat's rules (src/agent/config.js): a config cannot send your key to a
// host you did not confirm.

import { agentSettings } from '../config.js'
import { ACP_COMMAND_VAR } from '../acp/command.js'
import { splitCommand } from '../../watch.js'
import { ID_RE } from '../../config.js'
import { parseAllowEntry } from './egress-proxy.js'
import { DEFAULT_LIMITS, checkLimits } from './runtime.js'
import { sizeBytes } from './disk.js'

export const PROFILES = ['openai-compatible', 'claude-code', 'codex']
export const DEFAULT_BUDGET = { turns: 20, tokens: 200000, minutes: 15 }
export const BUDGET_MAX = { turns: 100, tokens: 2000000, minutes: 120 }
export const DEFAULT_REGISTRY = 'registry.npmjs.org:443'
export const REGISTRY_VAR = 'SHAPEWALL_AGENT_REGISTRY'
export const EGRESS_VAR = 'SHAPEWALL_AGENT_EGRESS'
export const DEFAULT_BRANCH_PREFIX = 'shapewall-agent/'
const TRUSTED_MAX = 200
const NAME_MAX = 80
const BRANCH_PREFIX_RE = /^[a-z0-9][a-z0-9._/-]{0,40}\/$/
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/
// Keys refused in the config: each decides what leaves the sandbox or what runs on the host.
const REFUSED_KEYS = ['image', 'runtime', 'registry', 'egress', 'allowHosts', 'allowHost', 'network', 'apiKey', 'key', 'env', 'mounts']

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// How long a model call may take to start answering (headers), in seconds.
// Unset: 180 s until the model first answers in a run (a local model may
// still be loading), 60 s after that.
export const MODEL_TIMEOUT_MAX_S = 900
const modelTimeoutValid = (value) => Number.isInteger(value) && value >= 1 && value <= MODEL_TIMEOUT_MAX_S

// --model-timeout SECONDS, else the config's, else null (the defaults).
function modelTimeoutMs(base, flags) {
  if (flags['model-timeout'] === undefined) return base.modelTimeoutSeconds ? base.modelTimeoutSeconds * 1000 : null
  const raw = flags['model-timeout']
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN
  if (!modelTimeoutValid(value)) throw new Error(`--model-timeout: 1 to ${MODEL_TIMEOUT_MAX_S} seconds`)
  return value * 1000
}

// A trusted name as compared: hosted handles and local author names, case-folded.
export const trustName = (value) =>
  String(value || '')
    .replace(/^@/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

function cleanTrusted(raw, where, problems) {
  if (raw === undefined) return null
  if (
    !Array.isArray(raw) ||
    raw.length > TRUSTED_MAX ||
    raw.some((item) => typeof item !== 'string' || !trustName(item) || item.length > NAME_MAX)
  ) {
    problems.push(`${where}: a list of up to ${TRUSTED_MAX} member handles or names`)
    return null
  }
  return [...new Set(raw.map(trustName))]
}

function cleanCommand(raw, where, problems) {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string' || !raw.trim()) {
    problems.push(`${where}: a command such as "npm test"`)
    return null
  }
  try {
    return splitCommand(raw, where)
  } catch (error) {
    problems.push(error.message)
    return null
  }
}

// Validates `starterAgent` in shapewall.config.json. Pushes one message per problem.
export function validateStarterAgent(raw, problems, { boardIds = [] } = {}) {
  if (raw === undefined || raw === null) return null
  if (!isObject(raw)) {
    problems.push('starterAgent: an object such as { "trusted": ["robin"], "testCommand": "npm test" }')
    return null
  }
  // Where the agent's branch is pushed is the person's choice, per run.
  for (const [key, flag] of [
    ['remote', '--git-remote'],
    ['forkRemote', '--fork-remote'],
  ]) {
    if (raw[key] !== undefined) {
      problems.push(
        `starterAgent.${key}: not taken from the config (a repo must not decide where the agent's branch is pushed); pass ${flag} NAME to shapewall agent run instead (docs/starter-agent.md)`,
      )
    }
  }
  for (const key of REFUSED_KEYS) {
    if (raw[key] !== undefined) {
      problems.push(
        `starterAgent.${key}: not taken from the config (a repo must not decide what leaves the sandbox); use the shapewall agent flags or environment (docs/starter-agent.md)`,
      )
    }
  }
  const trusted = cleanTrusted(raw.trusted, 'starterAgent.trusted', problems) || []
  const boards = {}
  if (raw.boards !== undefined) {
    if (!isObject(raw.boards)) problems.push('starterAgent.boards: { "<board id>": { "trusted": [...] } }')
    else {
      for (const [id, value] of Object.entries(raw.boards)) {
        if (!ID_RE.test(id) || (boardIds.length && !boardIds.includes(id))) {
          problems.push(`starterAgent.boards: no board "${id}"`)
          continue
        }
        if (!isObject(value)) {
          problems.push(`starterAgent.boards.${id}: { "trusted": [...] }`)
          continue
        }
        const list = cleanTrusted(value.trusted, `starterAgent.boards.${id}.trusted`, problems)
        if (list) boards[id] = { trusted: list }
      }
    }
  }
  const budget = { ...DEFAULT_BUDGET }
  if (raw.budget !== undefined) {
    if (!isObject(raw.budget)) problems.push('starterAgent.budget: { "turns", "tokens", "minutes" }')
    else {
      for (const key of Object.keys(DEFAULT_BUDGET)) {
        if (raw.budget[key] === undefined) continue
        const value = raw.budget[key]
        if (!Number.isInteger(value) || value < 1 || value > BUDGET_MAX[key])
          problems.push(`starterAgent.budget.${key}: 1 to ${BUDGET_MAX[key]}`)
        else budget[key] = value
      }
    }
  }
  let limits = { ...DEFAULT_LIMITS }
  if (raw.limits !== undefined) {
    if (!isObject(raw.limits)) problems.push('starterAgent.limits: { "memory": "4g", "cpus": 2, "pids": 512 }')
    else {
      try {
        // Within what one review job should take on this machine.
        // Compared in bytes: "999999m" is a size too, and must not get past the cap.
        const asked = checkLimits({ ...DEFAULT_LIMITS, ...raw.limits })
        if (sizeBytes(asked.memory) > sizeBytes('16g')) throw new Error('memory: at most 16g')
        if (sizeBytes(asked.tmp) > sizeBytes('16g')) throw new Error('tmp: at most 16g')
        if (Number(asked.cpus) > 8) throw new Error('cpus: at most 8')
        if (sizeBytes(asked.disk) > sizeBytes('64g')) throw new Error('disk: at most 64g')
        limits = asked
      } catch (error) {
        problems.push(`starterAgent.limits.${error.message}`)
      }
    }
  }
  const branchPrefix = raw.branchPrefix ?? DEFAULT_BRANCH_PREFIX
  if (typeof branchPrefix !== 'string' || !BRANCH_PREFIX_RE.test(branchPrefix)) {
    problems.push('starterAgent.branchPrefix: lowercase, ending in "/", such as "shapewall-agent/"')
  }
  if (raw.prBase !== undefined && (typeof raw.prBase !== 'string' || !REF_RE.test(raw.prBase)))
    problems.push('starterAgent.prBase: a branch name')
  const modelTimeout = raw.modelTimeoutSeconds
  const timeoutOk = modelTimeout === undefined || modelTimeoutValid(modelTimeout)
  if (!timeoutOk)
    problems.push(`starterAgent.modelTimeoutSeconds: 1 to ${MODEL_TIMEOUT_MAX_S} (seconds to the first answer of a model call)`)
  return {
    modelTimeoutSeconds: timeoutOk && modelTimeout !== undefined ? modelTimeout : null,
    trusted,
    boards,
    testCommand: cleanCommand(raw.testCommand, 'starterAgent.testCommand', problems),
    setupCommand: cleanCommand(raw.setupCommand, 'starterAgent.setupCommand', problems),
    budget,
    limits,
    branchPrefix: typeof branchPrefix === 'string' && BRANCH_PREFIX_RE.test(branchPrefix) ? branchPrefix : DEFAULT_BRANCH_PREFIX,
    prBase: typeof raw.prBase === 'string' && REF_RE.test(raw.prBase) ? raw.prBase : null,
  }
}

// --max-disk SIZE: the disk cap on the mounted folder for this run.
function diskFlag(limits, value) {
  if (value === undefined) return limits
  if (typeof value !== 'string' || !/^[1-9]\d{0,5}[mg]$/.test(value) || sizeBytes(value) > sizeBytes('64g')) {
    throw new Error('--max-disk: a size such as 2g or 500m, at most 64g')
  }
  return { ...limits, disk: value }
}

// A git remote name from a flag (never from the config), or the default.
function remoteFlag(flags, name, fallback) {
  const value = flags[name]
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !REMOTE_RE.test(value)) throw new Error(`--${name}: a git remote name`)
  return value
}

// "host" or "host:port" from a flag or the environment -> an allow entry the person chose.
export function personHost(value, where) {
  const raw = String(value || '').trim()
  const withPort = /:\d{1,5}$/.test(raw) && !/^\[[^\]]*$/.test(raw) ? raw : `${raw}:443`
  try {
    return { ...parseAllowEntry(withPort), private: true }
  } catch {
    throw new Error(`${where}: "${raw.slice(0, 80)}" is not a host or host:port`)
  }
}

const list = (value) => (Array.isArray(value) ? value : String(value || '').split(',')).map((item) => String(item).trim()).filter(Boolean)

// Budget flags: --max-turns, --max-tokens, --max-minutes.
function budgetFrom(base, flags) {
  const budget = { ...base }
  for (const [flag, key] of [
    ['max-turns', 'turns'],
    ['max-tokens', 'tokens'],
    ['max-minutes', 'minutes'],
  ]) {
    if (flags[flag] === undefined) continue
    const value = Number(flags[flag])
    if (!Number.isInteger(value) || value < 1 || value > BUDGET_MAX[key]) throw new Error(`--${flag}: 1 to ${BUDGET_MAX[key]}`)
    budget[key] = value
  }
  return budget
}

// Everything a run needs to know, without secrets. Throws for bad flags.
export function starterSettings(config, { env = process.env, flags = {} } = {}) {
  const base = config.starterAgent || validateStarterAgent({}, [])
  const profile = flags.profile || 'openai-compatible'
  if (!PROFILES.includes(profile)) throw new Error(`--profile: one of ${PROFILES.join(', ')}`)
  // The chat's endpoint settings, never its ACP agent: the starter agent
  // drives the model itself (from the sandbox, through the host relay).
  const model = agentSettings(config, { ...env, [ACP_COMMAND_VAR]: '' })
  let modelProblem = null
  if (profile !== 'openai-compatible') {
    modelProblem = `the ${profile} profile is not available yet; use --profile openai-compatible (docs/starter-agent.md)`
  } else if (model.backend !== 'openai-compatible') {
    modelProblem =
      'the starter agent needs an OpenAI-compatible endpoint (agent.baseUrl and agent.model, or SHAPEWALL_AGENT_BASE_URL and SHAPEWALL_AGENT_MODEL); an ACP agent cannot run in the sandbox'
  } else if (!model.configured) {
    modelProblem = model.problem || 'no model endpoint: set agent.baseUrl and agent.model (docs/agents.md)'
  }
  const registryRaw = flags.registry ?? env[REGISTRY_VAR] ?? null
  const registry =
    registryRaw === 'none'
      ? null
      : registryRaw
        ? personHost(registryRaw, `--registry / ${REGISTRY_VAR}`)
        : { ...parseAllowEntry(DEFAULT_REGISTRY), private: false }
  const extra = [...list(flags['allow-host']), ...list(env[EGRESS_VAR])].map((item) => personHost(item, `--allow-host / ${EGRESS_VAR}`))
  const extraTrusted = list(flags.trusted).map(trustName).filter(Boolean)
  return {
    profile,
    model: {
      baseUrl: model.baseUrl,
      model: model.model,
      keyVar: model.keyVar,
      hasKey: Boolean(model.hasKey),
      host: model.host,
      maxTokens: model.maxTokens,
      temperature: model.temperature,
      label: model.label,
    },
    problem: modelProblem,
    // null: the defaults (model-relay.js).
    modelTimeoutMs: modelTimeoutMs(base, flags),
    budget: budgetFrom(base.budget, flags),
    limits: diskFlag(base.limits, flags['max-disk']),
    testCommand: base.testCommand,
    setupCommand: base.setupCommand,
    branchPrefix: base.branchPrefix,
    remote: remoteFlag(flags, 'git-remote', 'origin'),
    prBase: base.prBase,
    forkRemote: remoteFlag(flags, 'fork-remote', null),
    registry,
    extraHosts: extra,
    // Who may dispatch work on a board: its own list, or the default list, plus --trusted.
    trustedFor(boardId) {
      const own = base.boards?.[boardId]?.trusted
      return new Set([...(own || base.trusted || []), ...extraTrusted])
    },
  }
}
