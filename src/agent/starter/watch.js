// `shapewall agent watch`: runs the starter agent on each comment the
// trigger gate lets through, one at a time, until Ctrl+C (or, with `once`,
// until the comments open now are done).
//
// A comment is looked at while it is open with no agent status. One the gate
// holds back (an untrusted author nobody tagged yet) is looked at again on
// every scan, so a trusted member's "@agent" reply starts it later; a
// guest's comment is skipped for good.

import fs from 'node:fs'
import path from 'node:path'
import { acquireLock, readLock, releaseLock } from '../../lock.js'
import { boardDir } from '../../store.js'
import { gateComment } from './gate.js'
import { pause } from './pause.js'
import { runStarter } from './supervisor.js'

export async function watchStarter({
  source,
  settings,
  once = false,
  pollMs = 3000,
  signal = null,
  log = () => {},
  run = runStarter,
  ...runOptions
}) {
  let lockFile = null
  if (source.config) {
    lockFile = path.join(boardDir(source.config, source.board.id), 'starter-watch.lock')
    fs.mkdirSync(path.dirname(lockFile), { recursive: true })
    if (!acquireLock(lockFile)) {
      const holder = readLock(lockFile)
      throw new Error(
        `Another "shapewall agent watch" is running for board "${source.board.id}"${holder?.pid ? ` (pid ${holder.pid})` : ''}.`,
      )
    }
  }
  const said = new Map()
  const results = []
  const trusted = settings.trustedFor(source.board.id)
  if (!trusted.size)
    log(`No member may dispatch work on board "${source.board.id}": set starterAgent.trusted in the config or pass --trusted.`)
  try {
    if (!once) log(`Starter agent watching board "${source.board.id}" (every ${Math.round(pollMs / 1000)}s). Ctrl+C stops.`)
    for (;;) {
      if (signal?.aborted) break
      let ran = false
      let comments = []
      try {
        comments = (await source.list()).filter((item) => item.agentStatus === null).sort((a, b) => a.id - b.id)
      } catch (error) {
        log(`agent watch: ${error.message}`)
      }
      for (const comment of comments) {
        if (signal?.aborted) break
        const gate = gateComment(comment, { trusted, hosted: source.hosted })
        if (!gate.dispatch) {
          if (said.get(comment.id) !== gate.reason) {
            said.set(comment.id, gate.reason)
            log(`#${comment.id} skipped: ${gate.reason}`)
          }
          continue
        }
        said.delete(comment.id)
        try {
          results.push(await run({ source, settings, commentId: comment.id, signal, log, ...runOptions }))
          ran = true
        } catch (error) {
          // Taken by someone else meanwhile, or the gate said no on a fresh read.
          log(`#${comment.id}: ${error.message}`)
        }
      }
      if (once) {
        if (!ran) break
        continue
      }
      await pause(pollMs, signal)
    }
  } finally {
    if (lockFile) releaseLock(lockFile)
  }
  return results
}
