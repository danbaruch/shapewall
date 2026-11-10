import fs from 'node:fs'
import path from 'node:path'
import { ID_RE } from '../config.js'

export const FLOW_MAX_BYTES = 32 * 1024
export const FLOW_MAX_STEPS = 20
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const selector = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 500
const fail = () => {
  throw new Error('Invalid flow definition. Use one configured page and viewport, with at most 20 bounded explicit steps.')
}

export function normalizeFlow(value) {
  if (
    !object(value) ||
    Buffer.byteLength(JSON.stringify(value)) > FLOW_MAX_BYTES ||
    value.schemaVersion !== 1 ||
    typeof value.pageId !== 'string' ||
    !ID_RE.test(value.pageId) ||
    typeof value.viewport !== 'string' ||
    !/^[a-z][a-z0-9-]{0,31}$/.test(value.viewport) ||
    Object.keys(value).some((key) => !['schemaVersion', 'pageId', 'viewport', 'accessibility', 'steps'].includes(key)) ||
    (value.accessibility !== undefined && typeof value.accessibility !== 'boolean') ||
    !Array.isArray(value.steps) ||
    !value.steps.length ||
    value.steps.length > FLOW_MAX_STEPS
  )
    fail()
  const steps = value.steps.map((step) => {
    if (
      !object(step) ||
      Object.keys(step).some((key) => !['action', 'ready', 'maxDurationMs'].includes(key)) ||
      (step.ready !== undefined && !selector(step.ready)) ||
      (step.maxDurationMs !== undefined &&
        (!Number.isFinite(step.maxDurationMs) || step.maxDurationMs < 1 || step.maxDurationMs > 20000)) ||
      !object(step.action) ||
      Object.keys(step.action).length !== 1
    )
      fail()
    const [type, input] = Object.entries(step.action)[0]
    let action
    if (['click', 'hover', 'waitFor'].includes(type) && selector(input)) action = { type, selector: input }
    else if (
      type === 'fill' &&
      Array.isArray(input) &&
      input.length === 2 &&
      selector(input[0]) &&
      typeof input[1] === 'string' &&
      input[1].length <= 2000
    )
      action = { type, selector: input[0], value: input[1] }
    else if (type === 'press' && typeof input === 'string' && input.length > 0 && input.length <= 80) action = { type, key: input }
    else if (type === 'wait' && Number.isInteger(input) && input >= 0 && input <= 5000) action = { type, ms: input }
    else if (type === 'scrollTo' && Number.isFinite(input) && input >= 0 && input <= 100000) action = { type, y: input }
    else fail()
    return { action, ready: step.ready ?? null, maxDurationMs: step.maxDurationMs ?? null }
  })
  return { schemaVersion: 1, pageId: value.pageId, viewport: value.viewport, accessibility: value.accessibility ?? false, steps }
}

export function readFlow(file, dir) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('Flow checks require an explicit flow file.')
  let descriptor
  try {
    descriptor = fs.openSync(path.resolve(dir, file), 'r')
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.size > FLOW_MAX_BYTES) fail()
    const bytes = Buffer.alloc(FLOW_MAX_BYTES + 1)
    let size = 0
    while (size < bytes.length) {
      const read = fs.readSync(descriptor, bytes, size, bytes.length - size, null)
      if (!read) break
      size += read
    }
    if (size > FLOW_MAX_BYTES) fail()
    return normalizeFlow(JSON.parse(bytes.subarray(0, size).toString('utf8')))
  } catch {
    throw new Error('Could not read a valid bounded flow file. No flow actions were executed.')
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}
