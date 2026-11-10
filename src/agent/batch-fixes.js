// Batch fixes: several open comments fixed one after another, each as an
// ordinary Fix with agent (its own run record, approvals and Undo, and in
// branch mode its own branch). Opt-in per project, capped.
//
// The setting `agent.batchFixes` ({ enabled, max }) lives in
// shapewall.config.json or the saved agent settings (agents.json, which win);
// `max` is at most BATCH_MAX_CEILING.
//
// The queue (createBatchQueue) knows nothing about HTTP or agents: routes.js
// hands it `runItem`, which starts one fix through the single-fix route
// itself. One batch per board at a time; items run in order, one at a time.
// It stops when the person cancels (the running item is stopped the normal
// way, the rest are skipped) or after two failures in a row; an approval
// left unanswered makes it wait, shown as `waiting` with the card.

import { userAgentEntry } from './user-settings.js'
import { BATCH_DEFAULTS, BATCH_MAX_CEILING, cleanBatchFixes } from './batch-queue.js'

export { BATCH_DEFAULTS, BATCH_FAILURES_STOP, BATCH_MAX_CEILING, BatchError, cleanBatchFixes, createBatchQueue } from './batch-queue.js'

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// `agent.batchFixes` in shapewall.config.json, only when given.
export function validateBatchConfig(raw, problems) {
  if (!isObject(raw) || raw.batchFixes === undefined) return {}
  const { value, problems: found } = cleanBatchFixes(raw.batchFixes, 'agent.batchFixes')
  problems.push(...found)
  return value ? { batchFixes: value } : {}
}

// What is in effect: { enabled, max, sources: { enabled, max } } (settings | config | null).
export function batchFixSettings(config, env = process.env) {
  const repo = isObject(config.agent?.batchFixes) ? config.agent.batchFixes : {}
  const saved = (config.dir ? userAgentEntry(config.dir, env).entry?.batchFixes : null) || {}
  const pick = (key) =>
    saved[key] !== undefined ? [saved[key], 'settings'] : repo[key] !== undefined ? [repo[key], 'config'] : [BATCH_DEFAULTS[key], null]
  const [enabled, enabledSource] = pick('enabled')
  const [max, maxSource] = pick('max')
  return {
    enabled: enabled === true,
    max: Math.min(BATCH_MAX_CEILING, Math.max(1, Number.isInteger(max) ? max : BATCH_DEFAULTS.max)),
    ceiling: BATCH_MAX_CEILING,
    sources: { enabled: enabledSource, max: maxSource },
  }
}
