// Journeys: named, ordered page sequences ("sign up", "upgrade to Plus").
// They come from the config (read-only on the board) and from the board
// itself, stored in <board>/journeys.json with the same atomic writes and
// file lock as comments.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { ID_RE, JOURNEY_STEPS_MAX, checkJourney } from './config.js'
import { checkSteps, isBranching, isFork, journeyPages, journeyPaths, pruneSteps, resolvePath } from './journey-paths.js'
import { CommentError, boardDir, writeJsonAtomic } from './store.js'
import { withFileLock } from './lock.js'

const JOURNEYS_MAX = 200

export function journeysFile(config, boardId) {
  return path.join(boardDir(config, boardId), 'journeys.json')
}

function readStore(config, boardId) {
  const file = journeysFile(config, boardId)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new CommentError(
      500,
      'corrupt_file',
      `journeys.json is not valid JSON (${error.message}); fix or move it, nothing was written.`,
      {
        cause: error,
      },
    )
  }
  return Array.isArray(raw?.journeys) ? raw.journeys.filter((item) => item && typeof item === 'object' && ID_RE.test(item.id)) : []
}

// Every journey on the board: config ones first, then board ones, each with
// `source` ('config' | 'board') and, read from its steps, `branching`,
// `pages` (every page it visits, on any branch) and `paths` (each way
// through the forks; one for a linear journey). Steps whose page left the
// config are dropped; a journey left with fewer than two steps is not shown.
export function listJourneys(config, board) {
  const pageIds = new Set(board.pages.map((page) => page.id))
  const fromConfig = board.journeys.map((journey) => ({ ...journey, source: 'config' }))
  const taken = new Set(fromConfig.map((journey) => journey.id))
  const fromBoard = readStore(config, board.id)
    .filter((journey) => !taken.has(journey.id))
    .map((journey) => ({
      id: journey.id,
      name: typeof journey.name === 'string' ? journey.name : journey.id,
      description: typeof journey.description === 'string' ? journey.description : '',
      steps: storedSteps(journey.steps, pageIds),
      source: 'board',
      createdAt: typeof journey.createdAt === 'string' ? journey.createdAt : null,
      updatedAt: typeof journey.updatedAt === 'string' ? journey.updatedAt : null,
    }))
  return [...fromConfig, ...fromBoard].filter((journey) => countSteps(journey.steps) >= 2).map(withPaths)
}

function countSteps(steps) {
  return resolvePath(steps).steps.length
}

function withPaths(journey) {
  return { ...journey, branching: isBranching(journey.steps), pages: journeyPages(journey.steps), paths: journeyPaths(journey.steps) }
}

// Steps of a stored journey, without pages that left the config. If pruning
// leaves an invalid fork (say, one at the start), the journey falls back to
// its first path, as a linear journey.
function storedSteps(raw, pageIds) {
  const pruned = pruneSteps(raw, pageIds)
  if (!isBranching(pruned)) return pruned
  if (checkSteps(pruned, pageIds, 'steps', [], { stepsMax: JOURNEY_STEPS_MAX })) return pruned
  return resolvePath(pruned).steps.map((step) => step.pageId)
}

function validate(board, input, id) {
  const problems = []
  const clean = checkJourney({ ...input, id }, new Set(board.pages.map((page) => page.id)), 'journey', problems)
  if (!clean) throw new CommentError(400, 'invalid_journey', problems.map((problem) => problem.replace(/^journey\.?/, '')).join('; '))
  return clean
}

function slug(name) {
  return (
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'journey'
  )
}

export async function createJourney(config, board, input, { now = new Date() } = {}) {
  if (!input || typeof input !== 'object') throw new CommentError(400, 'invalid_journey', 'Send { name, steps }.')
  const file = journeysFile(config, board.id)
  return withFileLock(file, () => {
    const list = readStore(config, board.id)
    if (list.length >= JOURNEYS_MAX) throw new CommentError(409, 'too_many_journeys', `A board holds at most ${JOURNEYS_MAX} journeys.`)
    const taken = new Set([...board.journeys.map((item) => item.id), ...list.map((item) => item.id)])
    let id = `${slug(input.name)}`
    while (taken.has(id)) id = `${slug(input.name)}-${randomBytes(2).toString('hex')}`
    const clean = validate(board, input, id)
    const journey = { ...clean, createdAt: now.toISOString(), updatedAt: now.toISOString() }
    list.push(journey)
    writeJsonAtomic(file, { journeys: list })
    return withPaths({ ...journey, source: 'board' })
  })
}

function boardOnly(board, journeyId) {
  if (board.journeys.some((item) => item.id === journeyId)) {
    throw new CommentError(409, 'config_journey', 'This journey is defined in shapewall.config.json; change it there.')
  }
}

export async function updateJourney(config, board, journeyId, changes, { now = new Date() } = {}) {
  boardOnly(board, journeyId)
  if (!changes || typeof changes !== 'object') throw new CommentError(400, 'invalid_journey', 'Nothing to change.')
  const file = journeysFile(config, board.id)
  return withFileLock(file, () => {
    const list = readStore(config, board.id)
    const index = list.findIndex((item) => item.id === journeyId)
    if (index < 0) throw new CommentError(404, 'unknown_journey', 'That journey does not exist.')
    const current = list[index]
    const merged = {
      name: changes.name !== undefined ? changes.name : current.name,
      description: changes.description !== undefined ? changes.description : current.description,
      steps: changes.steps !== undefined ? changes.steps : current.steps,
    }
    const clean = validate(board, merged, journeyId)
    list[index] = { ...clean, createdAt: current.createdAt || now.toISOString(), updatedAt: now.toISOString() }
    writeJsonAtomic(file, { journeys: list })
    return withPaths({ ...list[index], source: 'board' })
  })
}

export async function deleteJourney(config, board, journeyId) {
  boardOnly(board, journeyId)
  const file = journeysFile(config, board.id)
  return withFileLock(file, () => {
    const list = readStore(config, board.id)
    const kept = list.filter((item) => item.id !== journeyId)
    if (kept.length === list.length) throw new CommentError(404, 'unknown_journey', 'That journey does not exist.')
    writeJsonAtomic(file, { journeys: kept })
    return true
  })
}

// Plain-text journeys for `shapewall journeys`: each step on its own line,
// forks as indented branches.
export function formatJourneys(board, journeys) {
  const titles = new Map(board.pages.map((page) => [page.id, page.title]))
  const lines = []
  const list = (items, indent) => {
    for (const item of items) {
      if (typeof item === 'string') {
        lines.push(`${indent}- ${titles.get(item) || item} (${item})`)
        continue
      }
      if (!isFork(item)) continue
      lines.push(`${indent}  fork:`)
      for (const branch of item.branches) {
        const note = branch.end ? ', ends here' : branch.steps.length ? '' : ', skips to the next step'
        lines.push(`${indent}    > ${branch.label} [${branch.id}${note}]`)
        list(branch.steps, `${indent}      `)
      }
    }
  }
  if (!journeys.length) return `No journeys on board "${board.id}".`
  for (const journey of journeys) {
    if (lines.length) lines.push('')
    const paths = journey.paths.length
    const shape = journey.branching ? `, ${paths} path${paths === 1 ? '' : 's'}` : ''
    lines.push(`${journey.name} (${journey.id}, ${journey.source}${shape})`)
    if (journey.description) lines.push(`  ${journey.description}`)
    list(journey.steps, '  ')
  }
  return lines.join('\n')
}
