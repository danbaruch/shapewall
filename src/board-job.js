// The board-job lock: <out>/<board>/capture.lock. One job at a time per board,
// whichever process starts it: a capture (the CLI or the server's child), a
// checks run (`shapewall checks run`, from the terminal or the board) or an
// agent Apply (which changes the checkout captures and checks read). The lock
// body names its kind, so the board says what is really running. A lock
// without a kind (an older Shapewall) is a capture.

import fs from 'node:fs'
import path from 'node:path'
import { ID_RE } from './config.js'
import { acquireLock, isLockLive, readLock, releaseLock } from './lock.js'

export const BOARD_JOB_KINDS = ['capture', 'checks', 'apply']

export function boardJobFile(config, boardId) {
  if (!ID_RE.test(boardId)) throw new Error(`invalid board id ${boardId}`)
  return path.join(config.outputDir, boardId, 'capture.lock')
}

const kindOf = (lock) => (BOARD_JOB_KINDS.includes(lock?.kind) ? lock.kind : 'capture')

// The live job on the board, { kind, pid, startedAt }, or null.
export function readBoardJob(config, boardId) {
  const lock = readLock(boardJobFile(config, boardId))
  if (!isLockLive(lock)) return null
  return { kind: kindOf(lock), pid: Number(lock.pid), startedAt: typeof lock.startedAt === 'string' ? lock.startedAt : null }
}

// What a refused job is told, by the kind that holds the board.
export function boardJobBusyMessage(kind, boardId = null) {
  const board = boardId ? ` of "${boardId}"` : ' of this board'
  if (kind === 'checks') return `Checks${boardId ? ` of "${boardId}"` : ' on this board'} are running. Try again when they finish.`
  if (kind === 'apply') return `An agent Apply on${boardId ? ` "${boardId}"` : ' this board'} is running. Try again when it is done.`
  return `A capture${board} is already running.`
}

// Takes the board for `kind`. Returns { ok: true, release } or
// { ok: false, holder } (the kind that holds it).
export function acquireBoardJob(config, boardId, kind) {
  if (!BOARD_JOB_KINDS.includes(kind)) throw new Error(`unknown board job ${kind}`)
  const file = boardJobFile(config, boardId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (acquireLock(file, { kind })) return { ok: true, release: () => releaseLock(file) }
  return { ok: false, holder: readBoardJob(config, boardId)?.kind || 'capture' }
}

export class BoardBusyError extends Error {
  constructor(holder, boardId) {
    super(boardJobBusyMessage(holder, boardId))
    this.code = 'board_busy'
    this.holder = holder
  }
}
