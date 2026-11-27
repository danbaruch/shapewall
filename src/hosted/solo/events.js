// The solo engine's comment events (gap G8): `<outputDir>/events.jsonl` and
// notifications, the same as `shapewall serve` on the local store.
//
// The hosted EventBus (src/hosted/events.js) carries ids only: { type,
// workspace, project, board, comment }. This module turns those into the
// local comment events (src/events.js) by diffing each comment against the
// last state it saw, so a solo board's log lines and notifications are the
// ones the local store makes for the same change:
// - a comment it has not seen on a board it knows: comment.created (plus
//   comment.mentioned for each @handle);
// - a reply it has not seen: comment.replied (plus mentions);
// - a body edit that adds a mention, resolve, reopen, an agent status change:
//   updateEvents(), the store's own diff.
// Guests of share links never @mention anyone (src/hosted/comments.js), so
// their text makes no comment.mentioned. A change that names no comment (an
// import, a push, approvals) rereads the board: changes to known comments
// are diffed, comments it had not seen are taken in silently (imported
// comments are not new to anyone; the local import makes no events either).
//
// The log is written with src/event-log.js unchanged, so the file stays
// byte-compatible with the local one (`shapewall events`, bots). Events go
// into the log first, then to this process's listeners, as in the store.
// This process is the notifier while it runs (src/notify/run.js, serve:
// true): it holds the lease and sends every change from the log, its own and
// any other process's.
//
// What the bus does not say: who made an update. `actor` is the author for
// a new comment or reply and null for the rest ("nobody said").
//
// Known limit: with no workspace given at start, the first change on a board
// only teaches this module the board (nothing before it is known), so that
// one change makes no event unless it is a new comment. The solo mount passes
// the owner's workspace once it exists, and every board is read at start.

import { createdEvents, emitCommentEvents, replyEvents, updateEvents } from '../../events.js'
import { appendEvents } from '../../event-log.js'
import { startNotifications } from '../../notify/run.js'
import { rowToComment } from '../comments.js'
import { tenant } from '../tenancy.js'

const COMMENT_SQL = 'SELECT * FROM comments WHERE workspace_id = :ws AND project_id = :project AND board_id = :board'

const keyOf = (workspace, project, board) => `${workspace}\n${project}\n${board}`
const noMentions = (events) => events.filter((event) => event.type !== 'comment.mentioned')

// The events between what was known of a comment and what it is now.
export function commentChanges(boardId, before, after, now, { known = true } = {}) {
  if (!after) return []
  if (!before) {
    if (!known) return []
    const made = createdEvents(boardId, after, now)
    return after.authorGuest ? noMentions(made) : made
  }
  const events = []
  const had = new Set((before.replies || []).map((reply) => reply.id))
  for (const reply of after.replies || []) {
    if (had.has(reply.id)) continue
    const made = replyEvents(boardId, after, reply, now)
    events.push(...(reply.guest ? noMentions(made) : made))
  }
  const updates = updateEvents(boardId, before, after, now, null)
  events.push(...(after.authorGuest ? noMentions(updates) : updates))
  return events
}

// startSoloEvents({ db, events, config, ... }) -> { flush(), close(), notifications }.
// - db, events: the engine's database and EventBus.
// - config: the project's config (outputDir for the log, notifications, boards).
// - workspaceId, projectId: the solo owner's workspace and project, a value or
//   a function (the owner may be made after start); events of other projects
//   are ignored once projectId is known. Every comment of the workspace is
//   read at start (or when the workspace first becomes known).
// - boardUrl: where notification links point (the project's board URL).
// - notify: false turns notifications off (the log is still written).
export function startSoloEvents({
  db,
  events,
  config,
  workspaceId = null,
  projectId = null,
  boardUrl = null,
  notify = true,
  now = () => new Date(),
  log = () => {},
  notifyOptions = {},
}) {
  if (!db || !events || !config?.outputDir) throw new Error('solo events: db, events and config.outputDir are needed')
  const value = (item) => (typeof item === 'function' ? item() : item) || null
  // key -> Map(number -> comment): the last state seen of every comment.
  const boards = new Map()
  const loaded = new Set()
  let queue = Promise.resolve()
  let closed = false

  function readBoard(workspace, project, board) {
    const t = tenant(db, workspace)
    const rows = t.all(`${COMMENT_SQL} ORDER BY number`, { project, board })
    return new Map(rows.map((row) => [row.number, rowToComment(row)]))
  }

  // Every board of the workspace (of the project when it is known), once.
  function preload(workspace) {
    if (!workspace || loaded.has(workspace)) return
    loaded.add(workspace)
    const project = value(projectId)
    const t = tenant(db, workspace)
    const rows = project
      ? t.all('SELECT * FROM comments WHERE workspace_id = :ws AND project_id = :project ORDER BY number', { project })
      : t.all('SELECT * FROM comments WHERE workspace_id = :ws ORDER BY number')
    for (const row of rows) {
      const key = keyOf(workspace, row.project_id, row.board_id)
      if (!boards.has(key)) boards.set(key, new Map())
      boards.get(key).set(row.number, rowToComment(row))
    }
    // Boards with no comments yet are known too: their first comment is new.
    const boardRows = project
      ? t.all('SELECT project_id, board_id FROM boards WHERE workspace_id = :ws AND project_id = :project', { project })
      : t.all('SELECT project_id, board_id FROM boards WHERE workspace_id = :ws')
    for (const row of boardRows) {
      const key = keyOf(workspace, row.project_id, row.board_id)
      if (!boards.has(key)) boards.set(key, new Map())
    }
  }

  function changesFor(item) {
    const { workspace, project, board } = item
    const key = keyOf(workspace, project, board)
    if (item.type === 'board.removed') {
      boards.delete(key)
      return []
    }
    const at = now()
    let known = boards.get(key)
    const fresh = !known
    if (fresh) {
      // Not seen at start (made since): what is there now is the start.
      known = new Map()
      boards.set(key, known)
    }
    const t = tenant(db, workspace)
    if (item.comment) {
      const row = t.get(`${COMMENT_SQL} AND number = :number`, { project, board, number: item.comment })
      if (!row) {
        known.delete(item.comment)
        return []
      }
      const after = rowToComment(row)
      const before = known.get(item.comment) || null
      known.set(item.comment, after)
      return commentChanges(board, before, after, at, { known: !fresh || item.type === 'comment.created' })
    }
    // No single comment named (a new comment's URL has no number yet; an
    // import, a push, approvals): reread the board. Comments not seen before
    // are new only after a comment.created; on a board first seen now, only
    // the newest one is.
    const current = readBoard(workspace, project, board)
    const newest = Math.max(0, ...current.keys())
    const out = []
    for (const [number, after] of current) {
      const before = known.get(number) || null
      const created = item.type === 'comment.created' && (!fresh || number === newest)
      out.push(...commentChanges(board, before, after, at, { known: Boolean(before) || created }))
    }
    boards.set(key, current)
    return out
  }

  function onEvent(item) {
    if (closed) return
    if (item.type === 'close') {
      unsubscribe()
      return
    }
    if (!item.workspace) return
    const wantedWorkspace = value(workspaceId)
    if (wantedWorkspace && item.workspace !== wantedWorkspace) return
    const wantedProject = value(projectId)
    if (wantedProject && item.project !== wantedProject) return
    let changes
    try {
      // Any event of the workspace (a push, an agent) teaches this module
      // its boards before their first comment change.
      preload(item.workspace)
      if (
        typeof item.type !== 'string' ||
        !(item.type.startsWith('comment.') || item.type === 'push.committed' || item.type === 'board.removed') ||
        !item.project ||
        !item.board
      )
        return
      changes = changesFor(item)
    } catch (error) {
      log(`solo events: ${error.message}`)
      return
    }
    if (!changes.length) return
    // In order, one batch at a time: the log keeps the order changes were made.
    queue = queue.then(async () => {
      await appendEvents(config, changes)
      emitCommentEvents(changes)
    })
  }

  // The workspace known at start: read now, so the first change is a diff.
  try {
    preload(value(workspaceId))
  } catch (error) {
    log(`solo events: ${error.message}`)
  }
  const unsubscribe = events.subscribe(onEvent)

  // Links in messages: the board URL when each message is made.
  const linkBase = boardUrl ? () => value(boardUrl) : null
  const notifications = notify ? startNotifications(config, { serve: true, log, boardUrl: linkBase, ...notifyOptions }) : null

  return {
    notifications,
    // Resolves once every change seen so far is in the log and handed to listeners.
    flush: () => queue,
    async close(ms = 1500) {
      if (closed) return
      closed = true
      unsubscribe()
      await queue
      await notifications?.close(ms)
    },
  }
}

// The solo hook's entry (mountSolo, src/hosted/solo/index.js): starts the
// event log and the notifier for the engine's project. Returns the handle
// (its close() is awaited by app.locals.close()), or null when the solo
// profile names no project config (nothing to write to).
// deps: the hook's deps (db, events, publicOrigin, now, log) and deps.solo:
//   config       the project's loaded config (outputDir, notifications, boards)
//   workspaceId, projectId   the owner's workspace and project (values or functions)
//   notify       false: the log only, no notifications
//   boardUrl     where notification links point; default the project's board
//                (/w/<ws>/p/<project>/ on the engine's origin)
//   notifyOptions  passed to src/notify/run.js (tests: env, backoffMs, pollMs)
export function mountSoloEvents(app, deps = {}) {
  const solo = deps.solo || {}
  if (!solo.config?.outputDir) return null
  const value = (item) => (typeof item === 'function' ? item() : item) || null
  const origin = deps.publicOrigin
  const boardUrl =
    solo.boardUrl ||
    (origin
      ? () => {
          const ws = value(solo.workspaceId)
          const project = value(solo.projectId)
          return new URL(ws && project ? `/w/${ws}/p/${project}/` : '/', origin).toString()
        }
      : null)
  const handle = startSoloEvents({
    db: deps.db,
    events: deps.events,
    config: solo.config,
    workspaceId: solo.workspaceId ?? null,
    projectId: solo.projectId ?? null,
    boardUrl,
    notify: solo.notify !== false,
    notifyOptions: solo.notifyOptions || {},
    now: deps.now,
    log: deps.log,
  })
  // For `serve` (its startup line names the channels) and tests.
  if (app?.locals) app.locals.soloEvents = handle
  return handle
}
