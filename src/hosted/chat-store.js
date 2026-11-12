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
  // Per board.
  threads: 500,
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
    const count = t.get('SELECT COUNT(*) AS n FROM chat_threads WHERE workspace_id = :ws AND project_id = :project AND board_id = :board', {
      project: projectId,
      board: boardId,
    }).n
    if (count >= CHAT_LIMITS.threads)
      throw new HttpError(409, 'too_many_threads', `This board has ${CHAT_LIMITS.threads} chats. Delete some from the chat history first.`)
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
    const all = t.all(
      'SELECT * FROM chat_threads WHERE workspace_id = :ws AND project_id = :project AND board_id = :board ORDER BY updated_at DESC',
      { project: projectId, board: boardId },
    )
    const out = []
    for (const row of all) {
      if (!visible(row, row.thread_id, userId)) continue
      const stored = messages(projectId, boardId, row.thread_id)
      if (!stored.length) continue
      const summary = threadSummary(
        {
          id: row.thread_id,
          messages: stored,
          title: row.title || undefined,
          archived: row.archived === 1,
          createdAt: row.created_at,
          branches: [],
        },
        needle,
      )
      if (summary) out.push({ ...summary, agentId: row.agent_id || null })
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
  const turnsToday = (projectId) =>
    t.get('SELECT COUNT(*) AS n FROM chat_turns WHERE workspace_id = :ws AND project_id = :project AND created_at >= :start', {
      project: projectId,
      start: `${iso().slice(0, 10)}T00:00:00.000Z`,
    }).n
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
    turnsToday,
    setRunning,
    ack,
    endTurn,
    interrupt,
    bytes,
    kindOf: threadKind,
  }
}
