// Retention: older capture versions on pushed boards are pruned, so a board
// that is pushed every day does not grow forever.
//
// Per page and viewport, a board keeps:
//   - the current capture (captures/, never touched here);
//   - the newest `keep` older versions (versions/), 2 by default, or the
//     workspace's own setting (`shapewall hosted admin retention <ws> --keep N`);
//   - every older version a comment was made on (comments.capture_version),
//     open or resolved, so before and after keeps working for it.
// Everything else in versions/ goes, and the board's byte count (the storage
// quota) goes down with it.
//
// The server runs it at start and every 6 hours in-process (--retention-hours,
// 0 turns it off); `shapewall hosted admin retention --run` runs it by hand.
// Each board is pruned inside one database write transaction: a push commit
// swaps board folders inside its own transaction, so the two never interleave,
// also when the CLI runs it from another process.
//
// Usage records (agent_runs: one small row per agent turn) are pruned by age:
// 400 days by default, or the workspace's own setting (`shapewall hosted admin
// retention <ws> --usage-days N`). A turn still running is never removed.
//
// A later push brings back the versions the pushing machine still keeps; the
// next run trims them again.

import fs from 'node:fs'
import path from 'node:path'
import { ID_RE } from '../config.js'
import { listVersions } from '../store.js'
import { transaction } from './db.js'
import { boardConfig } from './projects.js'
import { allWorkspaces, tenant } from './tenancy.js'
import { USAGE_RETENTION_DAYS, createUsage } from './usage.js'

export const RETENTION_DEFAULT = 2
export const RETENTION_EVERY_HOURS = 6

// Which version files of one board to remove. `versions` is listVersions()
// output; `referenced` a Set of "page\0viewport\0version".
export function planBoardRetention(versions, referenced, keep) {
  const remove = []
  for (const [pageId, viewports] of Object.entries(versions)) {
    for (const [viewport, byVersion] of Object.entries(viewports)) {
      const newestFirst = [...byVersion].sort((a, b) => b.version.localeCompare(a.version))
      newestFirst.forEach((item, index) => {
        if (index < keep) return
        if (referenced.has(`${pageId}\u0000${viewport}\u0000${item.version}`)) return
        for (const name of [item.file, item.thumb, item.live]) if (name) remove.push(name)
      })
    }
  }
  return remove
}

export function runRetention({
  db,
  dataDir,
  keepDefault = RETENTION_DEFAULT,
  usageDaysDefault = USAGE_RETENTION_DAYS,
  dryRun = false,
  workspaceId = null,
  now = () => new Date(),
}) {
  const result = { workspaces: 0, boards: 0, files: 0, bytes: 0, usageRows: 0, dryRun }
  for (const workspace of allWorkspaces(db)) {
    if (workspaceId && workspace.id !== workspaceId) continue
    result.workspaces += 1
    const keep = workspace.retention_versions ?? keepDefault
    const t = tenant(db, workspace.id)
    // Usage records (one row per agent turn) older than the workspace keeps them.
    result.usageRows += transaction(db, () => createUsage(t, { now }).prune(workspace.retention_usage_days ?? usageDaysDefault, { dryRun }))
    for (const row of t.all('SELECT project_id, board_id FROM boards WHERE workspace_id = :ws ORDER BY project_id, board_id')) {
      if (!ID_RE.test(row.board_id)) continue
      const removed = pruneBoard(db, t, dataDir, row.project_id, row.board_id, keep, dryRun)
      if (removed.files) result.boards += 1
      result.files += removed.files
      result.bytes += removed.bytes
    }
  }
  return result
}

function pruneBoard(db, t, dataDir, projectId, boardId, keep, dryRun) {
  return transaction(db, () => {
    const row = t.get('SELECT * FROM boards WHERE workspace_id = :ws AND project_id = :project AND board_id = :board', {
      project: projectId,
      board: boardId,
    })
    if (!row) return { files: 0, bytes: 0 }
    const config = boardConfig(dataDir, t.workspaceId, projectId, row)
    const referenced = new Set(
      t
        .all(
          `SELECT DISTINCT page_id, viewport, capture_version FROM comments
           WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND capture_version IS NOT NULL`,
          { project: projectId, board: boardId },
        )
        .map((comment) => `${comment.page_id}\u0000${comment.viewport}\u0000${comment.capture_version}`),
    )
    // A reply's drawing is on the capture that was current when it was
    // posted: that version stays too, so its markup keeps rendering.
    for (const comment of t.all(
      `SELECT page_id, viewport, replies FROM comments
       WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND replies LIKE '%"drawing"%'`,
      { project: projectId, board: boardId },
    )) {
      let replies = []
      try {
        replies = JSON.parse(comment.replies)
      } catch {
        /* unreadable: nothing referenced */
      }
      for (const reply of Array.isArray(replies) ? replies : []) {
        const version = reply?.drawing?.captureVersion
        if (typeof version === 'string') referenced.add(`${comment.page_id}\u0000${comment.viewport}\u0000${version}`)
      }
    }
    const names = planBoardRetention(listVersions(config, boardId), referenced, keep)
    const dir = path.join(config.outputDir, boardId, 'versions')
    let bytes = 0
    let files = 0
    for (const name of names) {
      const file = path.join(dir, name)
      if (path.dirname(file) !== dir) continue
      let size
      try {
        size = fs.statSync(file).size
      } catch {
        continue
      }
      if (!dryRun) fs.rmSync(file, { force: true })
      bytes += size
      files += 1
    }
    if (!dryRun && bytes)
      t.run('UPDATE boards SET bytes = MAX(0, bytes - :bytes) WHERE workspace_id = :ws AND project_id = :project AND board_id = :board', {
        bytes,
        project: projectId,
        board: boardId,
      })
    return { files, bytes }
  })
}

// The in-process job: at start, then every `hours`. Returns stop().
export function startRetention({ db, dataDir, hours = RETENTION_EVERY_HOURS, keepDefault = RETENTION_DEFAULT, log = () => {} }) {
  if (!hours) return () => {}
  const run = () => {
    try {
      const result = runRetention({ db, dataDir, keepDefault })
      if (result.usageRows) log(`retention: removed ${result.usageRows} old usage records`)
      if (result.files)
        log(`retention: removed ${result.files} old version files (${(result.bytes / 1048576).toFixed(1)} MB) from ${result.boards} boards`)
    } catch (error) {
      log(`retention: ${error.message}`)
    }
  }
  run()
  const timer = setInterval(run, hours * 3_600_000)
  timer.unref()
  return () => clearInterval(timer)
}
