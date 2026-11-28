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
import { assertMigrationAllows, projectRoot } from './engine-folder.js'

export const BOARD_JOB_KINDS = ['capture', 'checks', 'apply', 'backup', 'push']

export function boardJobFile(config, boardId) {
  if (!ID_RE.test(boardId)) throw new Error(`invalid board id ${boardId}`)
  return path.join(config.outputDir, boardId, 'capture.lock')
}

const kindOf = (lock) => (BOARD_JOB_KINDS.includes(lock?.kind) ? lock.kind : 'capture')

// The lock a push commit holds beside the board folder while it swaps that
// folder (B-17): the board's own capture.lock moves away with the old folder,
// so the swap is held from outside it. <outputDir>/<board>.swap.lock.
export function boardSwapFile(config, boardId) {
  if (!ID_RE.test(boardId)) throw new Error(`invalid board id ${boardId}`)
  return path.join(config.outputDir, `${boardId}.swap.lock`)
}

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
  if (kind === 'push') return `A push${boardId ? ` of "${boardId}"` : ' of this board'} is being saved. Try again in a moment.`
  if (kind === 'backup') return `A backup is reading${boardId ? ` "${boardId}"` : ' this board'}. Try again in a moment.`
  if (kind === 'apply') return `An agent Apply on${boardId ? ` "${boardId}"` : ' this board'} is running. Try again when it is done.`
  return `A capture${board} is already running.`
}

// Takes the board for `kind`. Returns { ok: true, release } or
// { ok: false, holder } (the kind that holds it).
export function acquireBoardJob(config, boardId, kind) {
  if (!BOARD_JOB_KINDS.includes(kind)) throw new Error(`unknown board job ${kind}`)
  const file = boardJobFile(config, boardId)
  // Re-check 2: a swap running now is refused before anything is made, so no
  // folder or lock of ours appears between the swap's two renames.
  const swapping = () => isLockLive(readLock(boardSwapFile(config, boardId)))
  if (swapping()) return { ok: false, holder: 'push' }
  const made = !fs.existsSync(path.dirname(file))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (acquireLock(file, { kind })) {
    // B-17: a push swapping the folder holds the lock beside it. Checked with
    // our lock held: a swap that started first wins, and the folder this
    // call made (in the moment between the swap's two renames) goes again.
    if (swapping()) {
      releaseLock(file)
      if (made)
        try {
          fs.rmdirSync(path.dirname(file))
        } catch {
          /* not empty: someone else's */
        }
      return { ok: false, holder: 'push' }
    }
    // B-1: on the engine's board folders, checked again with the lock held.
    // A migration that started before the lock was taken is refused here; one
    // that starts after sees the lock (migrate's holders() scans the engine).
    if (projectRoot(config.outputDir).engine)
      try {
        assertMigrationAllows(config)
      } catch (error) {
        releaseLock(file)
        throw error
      }
    return { ok: true, release: () => releaseLock(file) }
  }
  return { ok: false, holder: readBoardJob(config, boardId)?.kind || 'capture' }
}

export class BoardBusyError extends Error {
  constructor(holder, boardId) {
    super(boardJobBusyMessage(holder, boardId))
    this.code = 'board_busy'
    this.holder = holder
  }
}
