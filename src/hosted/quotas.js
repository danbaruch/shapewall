// Quotas per workspace, set by the server operator. Defaults below; the
// operator overrides them for every workspace or for one in a JSON file
// (`--quotas FILE`, or <data>/quotas.json when it exists):
//
//   {
//     "default": { "storageGB": 5, "projects": 20, "boardsPerProject": 10, "members": 100,
//                  "shareLinksPerProject": 20, "pushesPerHour": 20 },
//     "workspaces": { "ws_...": { "storageGB": 20 } }
//   }
//
// The file is read again when it changes (checked at most every few
// seconds), so a change needs no restart. A broken file at start stops the
// server; a broken edit later keeps the last good one and logs why.
//
// The kill switch is not a quota: `shapewall hosted admin suspend` sets
// workspaces.suspended_at (src/hosted/operator.js).

import fs from 'node:fs'
import { ID_PATTERNS } from './crypto.js'

const GB = 1024 ** 3

export const QUOTA_DEFAULTS = Object.freeze({
  storageGB: 5,
  projects: 20,
  boardsPerProject: 10,
  members: 100,
  shareLinksPerProject: 20,
  pushesPerHour: 20,
})

// Upper bounds keep a typo ("50000" GB) from meaning "unlimited" by accident.
const BOUNDS = {
  storageGB: [0.001, 10_000],
  projects: [1, 10_000],
  boardsPerProject: [1, 1000],
  members: [1, 100_000],
  shareLinksPerProject: [0, 1000],
  pushesPerHour: [1, 10_000],
}

function cleanSet(raw, where) {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where}: an object of quota values`)
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(BOUNDS, key)) throw new Error(`${where}: unknown quota "${key}" (known: ${Object.keys(BOUNDS).join(', ')})`)
    const [min, max] = BOUNDS[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
      throw new Error(`${where}.${key}: a number from ${min} to ${max}`)
    if (key !== 'storageGB' && !Number.isInteger(value)) throw new Error(`${where}.${key}: a whole number`)
    out[key] = value
  }
  return out
}

export function parseQuotas(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error('not valid JSON', { cause: error })
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the file holds one JSON object')
  for (const key of Object.keys(raw)) if (!['default', 'workspaces'].includes(key)) throw new Error(`unknown key "${key}"`)
  const workspaces = {}
  if (raw.workspaces !== undefined) {
    if (!raw.workspaces || typeof raw.workspaces !== 'object' || Array.isArray(raw.workspaces))
      throw new Error('workspaces: an object keyed by workspace id')
    for (const [id, set] of Object.entries(raw.workspaces)) {
      if (!ID_PATTERNS.workspace.test(id)) throw new Error(`workspaces: "${id}" is not a workspace id`)
      workspaces[id] = cleanSet(set, `workspaces.${id}`)
    }
  }
  return { default: cleanSet(raw.default, 'default'), workspaces }
}

// createQuotas({ file }) -> { of(workspaceId), file }. Without a file every
// workspace gets QUOTA_DEFAULTS.
export function createQuotas({ file = null, log = () => {}, checkEveryMs = 5000, now = () => Date.now() } = {}) {
  let parsed = { default: {}, workspaces: {} }
  let mtime = null
  let checkedAt = 0

  function load(initial) {
    let stat
    try {
      stat = fs.statSync(file)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (initial) throw new Error(`quotas: ${file} does not exist`, { cause: error })
      return
    }
    if (mtime !== null && stat.mtimeMs === mtime) return
    try {
      parsed = parseQuotas(fs.readFileSync(file, 'utf8'))
      if (!initial) log(`quotas: reloaded ${file}`)
    } catch (error) {
      if (initial) throw new Error(`quotas: ${file}: ${error.message}`, { cause: error })
      log(`quotas: ${file}: ${error.message}; keeping the previous quotas`)
    }
    mtime = stat.mtimeMs
  }
  if (file) load(true)

  function of(workspaceId) {
    if (file && now() - checkedAt > checkEveryMs) {
      checkedAt = now()
      load(false)
    }
    const merged = { ...QUOTA_DEFAULTS, ...parsed.default, ...(parsed.workspaces[workspaceId] || {}) }
    return { ...merged, storageBytes: Math.round(merged.storageGB * GB) }
  }
  return { of, file }
}
