// Chat on a hosted board, in the database (migration 13): threads, their
// messages, and turns. Every query goes through the tenant handle `t`
// (src/hosted/tenancy.js).
//
//   thread   belongs to one board. "board" and "comment-<n>" are shared by
//            the members of the workspace; a "chat-..." belongs to the person
//            who started it and nobody else reads it. A thread names the
//            agent it talks to (its "profile" on a local board).
//   message  the person's text (with what they mentioned and attached) or
//            the agent's answer with its cards in their final state.
//   turn     one question on its way through an agent: queued, running, then
//            done, stopped, error or interrupted. Its live events are in
//            memory (src/hosted/turn-hub.js).
//
// A usage record (agent_runs) is written for every turn: who asked, which
// agent, where, when, how it ended, and the numbers the agent reported.
// Never message text.
//
// The pure thread rules (titles, who sees a thread, search) are the local
// board's: src/agent/thread-history.js.

import {
  CHAT_RE,
  THREAD_RE,
  autoTitle,
  newestFirst,
  renameThread,
  searchNeedle,
  threadKind,
  threadSummary,
} from '../agent/thread-history.js'
import { newId } from './crypto.js'
import { HttpError } from './http.js'

export const CHAT_LIMITS = {
  // Per thread: the oldest messages go.
  messages: 200,
  // A member's own chats on one board (the shared threads are apart).
  privateChats: 50,
  // Threads read for a snippet in one search.
  searchRead: 40,
  text: 8000,
}
export const TURN_ENDED = ['done', 'stopped', 'error', 'interrupted']
export const INTERRUPTED_MESSAGE = "The agent's machine went away before it finished. Ask again."

const parse = (text) => {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

export function createChatStore(t, { now = () => new Date() } = {}) {
  const iso = () => now().toISOString()
  const KEY = 'workspace_id = :ws AND project_id = :project AND board_id = :board AND thread_id = :thread'

  // ---- Threads ----

  const validThread = (threadId) => typeof threadId === 'string' && THREAD_RE.test(threadId)
  const thread = (projectId, boardId, threadId) =>
    (validThread(threadId) && t.get(`SELECT * FROM chat_threads WHERE ${KEY}`, { project: projectId, board: boardId, thread: threadId })) ||
    null
  // Who may read a thread: the shared ones every member; a chat its owner
  // (a chat nobody wrote in yet has no row and is anyone's to start).
  const visible = (row, threadId, userId) => !CHAT_RE.test(threadId) || !row || !row.owner_user_id || row.owner_user_id === userId
  // The thread's row, made on its first write. A chat belongs to `userId`.
  // Returns { row, created }.
  function ensure(projectId, boardId, threadId, { userId, agentId = null }) {
    const found = thread(projectId, boardId, threadId)
    if (found) return { row: found, created: false }
    // A chat this person opened and never wrote in is forgotten after an
    // hour, so opening chats never fills the board's allowance.
    if (CHAT_RE.test(threadId) && userId)
      t.run(
        `DELETE FROM chat_threads WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND owner_user_id = :user
           AND created_at < :cutoff AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.workspace_id = chat_threads.workspace_id
           AND m.project_id = chat_threads.project_id AND m.board_id = chat_threads.board_id AND m.thread_id = chat_threads.thread_id)
           AND NOT EXISTS (SELECT 1 FROM chat_turns n WHERE n.workspace_id = chat_threads.workspace_id
           AND n.project_id = chat_threads.project_id AND n.board_id = chat_threads.board_id AND n.thread_id = chat_threads.thread_id)`,
        { project: projectId, board: boardId, user: userId, cutoff: new Date(now().getTime() - 60 * 60_000).toISOString() },
      )
    // A member's own chats on a board are capped apart from the shared
    // threads (the board's and one per comment), so one person cannot use
    // up what everyone shares.
    if (CHAT_RE.test(threadId)) {
      const mine = t.get(
        "SELECT COUNT(*) AS n FROM chat_threads WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND owner_user_id = :user AND thread_id LIKE 'chat-%'",
        { project: projectId, board: boardId, user: userId || '' },
      ).n
      if (mine >= CHAT_LIMITS.privateChats)
        throw new HttpError(
          409,
          'too_many_threads',
          `You have ${CHAT_LIMITS.privateChats} chats of your own on this board. Delete some from the chat history first.`,
        )
    }
    const at = iso()
    t.run(
      `INSERT INTO chat_threads (workspace_id, project_id, board_id, thread_id, agent_id, owner_user_id, created_by, created_at, updated_at)
       VALUES (:ws, :project, :board, :thread, :agent, :owner, :user, :at, :at)`,
      {
        project: projectId,
        board: boardId,
        thread: threadId,
        agent: agentId,
        owner: CHAT_RE.test(threadId) ? userId : null,
        user: userId,
        at,
      },
    )
    return { row: thread(projectId, boardId, threadId), created: true }
  }
  function setAgent(projectId, boardId, threadId, agentId) {
    t.run(`UPDATE chat_threads SET agent_id = :agent WHERE ${KEY}`, {
      project: projectId,
      board: boardId,
      thread: threadId,
      agent: agentId,
    })
  }
  function change(projectId, boardId, threadId, { title, archived }) {
    const row = thread(projectId, boardId, threadId)
    if (!row) throw new HttpError(404, 'unknown_thread', 'No such chat.')
    if (title !== undefined) {
      const shape = { id: threadId, messages: messages(projectId, boardId, threadId), title: row.title, titleSource: row.title_source }
      renameThread(shape, title)
      t.run(`UPDATE chat_threads SET title = :title, title_source = :source WHERE ${KEY}`, {
        project: projectId,
        board: boardId,
        thread: threadId,
        title: shape.title || null,
        source: shape.titleSource || null,
      })
    }
    if (archived !== undefined)
      t.run(`UPDATE chat_threads SET archived = :archived WHERE ${KEY}`, {
        project: projectId,
        board: boardId,
        thread: threadId,
        archived: archived ? 1 : 0,
      })
    return thread(projectId, boardId, threadId)
  }
  // The thread and everything in it. Its usage records stay (they are history).
  function remove(projectId, boardId, threadId) {
    const key = { project: projectId, board: boardId, thread: threadId }
    t.run(`DELETE FROM chat_messages WHERE ${KEY}`, key)
    t.run(`DELETE FROM chat_turns WHERE ${KEY}`, key)
    t.run(`DELETE FROM chat_threads WHERE ${KEY}`, key)
  }

  // ---- Messages ----

  const view = (row) => ({ ...parse(row.body), id: row.id, role: row.role, createdAt: row.created_at })
  const rows = (projectId, boardId, threadId) =>
    t.all(`SELECT * FROM chat_messages WHERE ${KEY} ORDER BY created_at, rowid`, { project: projectId, board: boardId, thread: threadId })
  const messages = (projectId, boardId, threadId) => rows(projectId, boardId, threadId).map(view)
  function append(projectId, boardId, threadId, { role, body, userId = null, agentId = null, turnId = null }) {
    const id = newId('msg')
    const text = JSON.stringify(body)
    const at = iso()
    t.run(
      `INSERT INTO chat_messages (workspace_id, project_id, board_id, thread_id, id, role, author_user_id, agent_id, turn_id, body, bytes, created_at)
       VALUES (:ws, :project, :board, :thread, :id, :role, :user, :agent, :turn, :body, :bytes, :at)`,
      {
        project: projectId,
        board: boardId,
        thread: threadId,
        id,
        role,
        user: userId,
        agent: agentId,
        turn: turnId,
        body: text,
        bytes: Buffer.byteLength(text),
        at,
      },
    )
    // The oldest messages make room.
    const extra = t.get(`SELECT COUNT(*) AS n FROM chat_messages WHERE ${KEY}`, { project: projectId, board: boardId, thread: threadId }).n
    if (extra > CHAT_LIMITS.messages)
      t.run(
        `DELETE FROM chat_messages WHERE ${KEY} AND id IN (SELECT id FROM chat_messages WHERE ${KEY} ORDER BY created_at, rowid LIMIT :n)`,
        { project: projectId, board: boardId, thread: threadId, n: extra - CHAT_LIMITS.messages },
      )
    const row = thread(projectId, boardId, threadId)
    if (row && role === 'user' && !row.title && row.title_source !== 'user') {
      const title = autoTitle(body.text)
      if (title)
        t.run(`UPDATE chat_threads SET title = :title, title_source = 'auto' WHERE ${KEY}`, {
          project: projectId,
          board: boardId,
          thread: threadId,
          title,
        })
    }
    t.run(`UPDATE chat_threads SET updated_at = :at WHERE ${KEY}`, { project: projectId, board: boardId, thread: threadId, at })
    return { ...body, id, role, createdAt: at }
  }

  // Every thread of the board this person may read, newest first, as the
  // chat history lists them (thread-history.js threadSummary). `query`
  // searches titles and messages.
  function list(projectId, boardId, { userId, query = '' }) {
    const needle = searchNeedle(query)
    const key = { project: projectId, board: boardId }
    // Titles, counts and last activity only: no message is loaded for the list.
    const all = t
      .all(
        `SELECT c.thread_id, c.agent_id, c.owner_user_id, c.title, c.archived, c.created_at,
           (SELECT COUNT(*) FROM chat_messages m WHERE m.workspace_id = c.workspace_id AND m.project_id = c.project_id
              AND m.board_id = c.board_id AND m.thread_id = c.thread_id) AS n,
           (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.workspace_id = c.workspace_id AND m.project_id = c.project_id
              AND m.board_id = c.board_id AND m.thread_id = c.thread_id) AS last_at
         FROM chat_threads c WHERE c.workspace_id = :ws AND c.project_id = :project AND c.board_id = :board ORDER BY c.updated_at DESC`,
        key,
      )
      .filter((row) => row.n > 0 && visible(row, row.thread_id, userId))
    const entry = (row, match = null) => {
      const kind = threadKind(row.thread_id)
      return {
        id: row.thread_id,
        kind,
        ...(kind === 'comment' ? { commentId: Number(row.thread_id.slice(8)) } : {}),
        title: row.title || null,
        count: row.n,
        createdAt: row.created_at,
        updatedAt: row.last_at,
        archived: row.archived === 1,
        shared: kind !== 'chat',
        ...(match ? { match } : {}),
        agentId: row.agent_id || null,
      }
    }
    if (!needle) return all.map((row) => entry(row)).sort(newestFirst)
    // A search: titles first; then only the threads whose stored text holds
    // the words are read for a snippet (a bounded number of them).
    const like = `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
    const holding = new Set(
      t
        .all(
          "SELECT DISTINCT thread_id FROM chat_messages WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND lower(body) LIKE :like ESCAPE '\\'",
          { ...key, like },
        )
        .map((row) => row.thread_id),
    )
    const out = []
    let read = 0
    for (const row of all) {
      if (
        String(row.title || '')
          .toLowerCase()
          .includes(needle)
      ) {
        out.push(entry(row))
        continue
      }
      if (!holding.has(row.thread_id) || read >= CHAT_LIMITS.searchRead) continue
      read += 1
      const summary = threadSummary(
        { id: row.thread_id, messages: messages(projectId, boardId, row.thread_id), title: row.title || undefined, branches: [] },
        needle,
      )
      if (summary?.match) out.push(entry(row, summary.match))
    }
    return out.sort(newestFirst)
  }

  // ---- Turns ----

  const turn = (turnId) => t.get('SELECT * FROM chat_turns WHERE workspace_id = :ws AND id = :id', { id: String(turnId || '') }) || null
  function createTurn({ projectId, boardId, threadId, agentId, kind = 'chat', userId = null, userMessageId = null, commentNumber = null }) {
    const id = newId('turn')
    const runId = newId('run')
    const at = iso()
    t.run(
      `INSERT INTO chat_turns (workspace_id, project_id, id, board_id, thread_id, agent_id, kind, state, started_by, user_message_id, run_id,
         comment_number, created_at)
       VALUES (:ws, :project, :id, :board, :thread, :agent, :kind, 'queued', :user, :message, :run, :number, :at)`,
      {
        project: projectId,
        id,
        board: boardId,
        thread: threadId,
        agent: agentId,
        kind,
        user: userId,
        message: userMessageId,
        run: runId,
        number: commentNumber,
        at,
      },
    )
    // The usage record: who asked which agent, where and when. No text.
    t.run(
      `INSERT INTO agent_runs (workspace_id, project_id, id, kind, agent_id, board_id, comment_number, thread_id, asked_by, started_at)
       VALUES (:ws, :project, :id, :kind, :agent, :board, :number, :thread, :asked, :at)`,
      {
        project: projectId,
        id: runId,
        kind: kind === 'comment' ? 'review' : 'chat',
        agent: agentId,
        board: boardId,
        number: commentNumber,
        thread: threadId,
        asked: userId,
        at,
      },
    )
    return turn(id)
  }
  const openTurn = (projectId, boardId, threadId) =>
    t.get(`SELECT * FROM chat_turns WHERE ${KEY} AND state IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`, {
      project: projectId,
      board: boardId,
      thread: threadId,
    }) || null
  const openTurnsOf = (agentId) =>
    t.all(
      "SELECT * FROM chat_turns WHERE workspace_id = :ws AND agent_id = :agent AND state IN ('queued', 'running') ORDER BY created_at",
      {
        agent: agentId,
      },
    )
  // Today's turns of a project, from the usage records: they stay when a
  // thread is deleted, so deleting one never gives turns back.
  const turnsToday = (projectId) =>
    t.get(
      "SELECT COUNT(*) AS n FROM agent_runs WHERE workspace_id = :ws AND project_id = :project AND kind IN ('chat', 'review') AND started_at >= :start",
      { project: projectId, start: `${iso().slice(0, 10)}T00:00:00.000Z` },
    ).n
  // Every turn the database still calls open (after a restart: none is).
  const openTurns = () => t.all("SELECT * FROM chat_turns WHERE workspace_id = :ws AND state IN ('queued', 'running') ORDER BY created_at")
  function setRunning(turnId) {
    t.run("UPDATE chat_turns SET state = 'running' WHERE workspace_id = :ws AND id = :id AND state = 'queued'", { id: turnId })
  }
  function ack(turnId, seq) {
    t.run('UPDATE chat_turns SET acked_seq = :seq WHERE workspace_id = :ws AND id = :id', { id: turnId, seq })
  }
  // Ends a turn once (a second end changes nothing): its state, and its
  // usage record with what the agent reported. Returns whether it ended now.
  function endTurn(row, state, usage = {}) {
    const at = iso()
    const result = t.run(
      "UPDATE chat_turns SET state = :state, ended_at = :at WHERE workspace_id = :ws AND id = :id AND state IN ('queued', 'running')",
      { id: row.id, state, at },
    )
    if (!Number(result.changes)) return false
    t.run(
      `UPDATE agent_runs SET ended_at = :at, outcome = :outcome, model = :model, effort = :effort, input_tokens = :input,
         output_tokens = :output, cached_tokens = :cached, cost_micros = :cost, steps = :steps
       WHERE workspace_id = :ws AND id = :run AND ended_at IS NULL`,
      {
        run: row.run_id,
        at,
        outcome: usage.outcome || state,
        model: usage.model ?? null,
        effort: usage.effort ?? null,
        input: usage.inputTokens ?? null,
        output: usage.outputTokens ?? null,
        cached: usage.cachedTokens ?? null,
        cost: usage.costMicros ?? null,
        steps: usage.steps ?? null,
      },
    )
    return true
  }
  // A turn that ended without an answer from the machine (it went away, the
  // server restarted, its agent was revoked): the thread says so.
  function interrupt(row, { message = INTERRUPTED_MESSAGE, agentName = null, state = 'interrupted', partial = null } = {}) {
    if (!endTurn(row, state, { outcome: state })) return null
    return append(row.project_id, row.board_id, row.thread_id, {
      role: 'assistant',
      agentId: row.agent_id,
      turnId: row.id,
      body: {
        text: partial?.text || '',
        cards: partial?.cards || [],
        status: state === 'stopped' ? 'stopped' : 'error',
        ...(state === 'stopped' ? {} : { error: { code: 'interrupted', message } }),
        ...(agentName ? { agent: { id: row.agent_id, name: agentName } } : {}),
      },
    })
  }

  // The shared threads of a board (the board's and its comments') with
  // their messages, for a workspace export. A member's own chats are theirs:
  // only how many there are.
  function shared(projectId, boardId) {
    const all = t.all(
      'SELECT thread_id, agent_id, owner_user_id, title, created_at, updated_at FROM chat_threads WHERE workspace_id = :ws AND project_id = :project AND board_id = :board ORDER BY created_at, thread_id',
      { project: projectId, board: boardId },
    )
    const threads = all
      .filter((row) => !CHAT_RE.test(row.thread_id))
      .map((row) => ({
        id: row.thread_id,
        title: row.title || null,
        agentId: row.agent_id || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messages: messages(projectId, boardId, row.thread_id),
      }))
      .filter((thread) => thread.messages.length)
    return { threads, privateChats: all.filter((row) => CHAT_RE.test(row.thread_id)).length }
  }

  // Bytes of every stored chat message of the workspace, for the storage quota.
  const bytes = () => t.get('SELECT COALESCE(SUM(bytes), 0) AS n FROM chat_messages WHERE workspace_id = :ws').n

  return {
    validThread,
    thread,
    visible,
    ensure,
    setAgent,
    change,
    remove,
    messages,
    append,
    list,
    turn,
    createTurn,
    openTurn,
    openTurnsOf,
    openTurns,
    turnsToday,
    setRunning,
    ack,
    endTurn,
    interrupt,
    shared,
    bytes,
    kindOf: threadKind,
  }
}
