// Chat with the scripted agent: threads, messages streamed as events, Stop
// and permission answers, and chat history (New chat, rename, archive,
// search, delete, edit with earlier versions) by the server's own rules
// (src/agent/thread-history.js). Messages stay in state.threads[key] (an
// array, as before history); a thread's history fields are in
// state.threadMeta[key]. Private chats belong to the person viewing as.

import { runScriptedTurn } from '../agent.js'
import { seedChats } from '../fixtures.js'
import {
  CHAT_RE,
  QUERY_MAX,
  THREAD_RE,
  branchFrom,
  cleanBranches,
  newestFirst,
  refreshAutoTitle,
  renameThread,
  restoreBranch,
  searchNeedle,
  threadKind,
  threadSummary,
  titleOf,
  trimThread,
  versionsOf,
  visibleTo,
} from '../../../../src/agent/thread-history.js'
import { latestChange, withUndoAvailability } from '../../../../src/agent/undo-state.js'
import { AGENT_INFO, demoAgentInfo, demoAgentOf, demoProfiles, fail, hex, newId, cleanText } from './util.js'
import { dropRating, findAnswer, ratingEntry, ratingsOf, upsertRating, validateRating } from '../../../../src/agent/ratings-core.js'

const MESSAGES_MAX = 200
import { DEMO_OPTIONS, demoFiles, demoMentions } from './composer.js'

export function chatRoutes(ctx) {
  const { state, now, save, iso, runs, boardAccess, boardViewOf, commentsOf, chatAllowed } = ctx

  // ---- Chat (the scripted agent) --------------------------------------------

  const threadKey = (access, boardId, threadId) => `${access.project.id}/${boardId}/${threadId}`
  const viewerOf = (access) => (access.user ? `user:${access.user.id}` : null)
  // A demo saved before chat history: add the sample past chats once.
  if (state.threads && !state.threadMeta) {
    const seeded = seedChats(now())
    for (const [key, messages] of Object.entries(seeded.threads)) state.threads[key] ??= messages
    state.threadMeta = seeded.threadMeta
  }
  const metaStore = () => (state.threadMeta = state.threadMeta || {})
  // The thread with its history fields, as thread-history.js reads it.
  const threadAt = (key, id) => {
    const meta = metaStore()[key] || {}
    return { ...meta, id, messages: state.threads[key] || [], branches: cleanBranches(meta.branches) }
  }
  const keepThread = (key, thread) => {
    trimThread(thread, MESSAGES_MAX)
    state.threads[key] = thread.messages
    const meta = {}
    for (const field of ['owner', 'title', 'titleSource', 'createdAt', 'archived', 'profileId'])
      if (thread[field]) meta[field] = thread[field]
    if (thread.branches.length) meta.branches = thread.branches
    if (Object.keys(meta).length) metaStore()[key] = meta
    else delete metaStore()[key]
  }
  function chatAccess(boardId, threadId) {
    const access = boardAccess()
    if (!chatAllowed(access)) fail(404, 'not_found', 'No such API route.')
    if (!access.project.boards.some((item) => item.id === boardId)) fail(404, 'unknown_board', 'No such board.')
    if (threadId !== undefined && !THREAD_RE.test(threadId)) fail(404, 'unknown_thread', 'No such chat thread.')
    // Someone else's chat is not there at all.
    if (
      threadId !== undefined &&
      CHAT_RE.test(threadId) &&
      !visibleTo(threadAt(threadKey(access, boardId, threadId), threadId), viewerOf(access))
    )
      fail(404, 'unknown_thread', 'No such chat thread.')
    return access
  }
  const messagesOf = (key) => (state.threads[key] = state.threads[key] || [])
  // Undo records of the scripted agent's pretend edits: message id -> what to put back.
  const undoOf = () => (state.chatUndo = state.chatUndo || {})
  // Only the thread's latest change offers Undo, as on a real board (undo-state.js).
  const undoState = (key, messages) =>
    withUndoAvailability(messages, (message) => message.summary.undo.available !== false && undoOf()[message.id]?.key === key)
  // Answer ratings per board (ratings-core.js, the server's rules): one per
  // answer per signed-in person.
  const ratingsOfBoard = (access, boardId) => {
    state.ratings = state.ratings || {}
    const key = `${access.project.id}/${boardId}`
    return (state.ratings[key] = state.ratings[key] || [])
  }
  // Earlier versions Regenerate keeps (src/agent/threads.js VERSIONS_MAX).
  const VERSIONS_MAX = 5
  const raterOf = (access) => ({ key: `user:${access.user.id}`, name: access.user.displayName })
  const rateRoute =
    (remove) =>
    ({ params, body }) => {
      const access = chatAccess(params[0], params[1])
      const found = findAnswer(messagesOf(threadKey(access, params[0], params[1])), params[2])
      if (!found) fail(404, 'unknown_message', 'No such answer in this thread.')
      const entries = ratingsOfBoard(access, params[0])
      const keyOf = { threadId: params[1], messageId: found.answer.id, rater: raterOf(access) }
      if (remove) {
        dropRating(entries, keyOf)
        return { rating: null }
      }
      let value
      try {
        value = validateRating(body)
      } catch (error) {
        fail(error.status || 400, error.code, error.message)
      }
      const entry = upsertRating(entries, keyOf, (previous) =>
        ratingEntry({
          boardId: params[0],
          threadId: params[1],
          rater: keyOf.rater,
          value,
          found,
          agent: {
            profileId: threadAt(threadKey(access, params[0], params[1]), params[1]).profileId || 'default',
            backend: AGENT_INFO.backend,
            label: demoAgentOf(threadAt(threadKey(access, params[0], params[1]), params[1]).profileId).label,
            model: AGENT_INFO.model,
          },
          previous,
          time: iso(),
        }),
      )
      return { rating: { rating: entry.rating, reasons: entry.reasons, note: entry.note } }
    }
  // The demo agent's model and effort pickers (in memory). Like an endpoint's
  // model list, they are known before the first message, so a new chat can
  // pick both before it sends anything.
  const choices = new Map()
  // The demo console's Settings page, where the (read-only) Agents card is.
  const settingsUrlOf = (access = null) => {
    let workspaceId = access?.project?.workspaceId || null
    if (!workspaceId) {
      try {
        workspaceId = boardAccess().project.workspaceId
      } catch {
        workspaceId = null
      }
    }
    return workspaceId ? `console.html#/w/${workspaceId}/settings#agents` : 'console.html'
  }
  const optionsOf = (key) =>
    DEMO_OPTIONS.map((option) => ({ ...option, currentValue: choices.get(`${key}|${option.id}`) || option.currentValue }))

  return [
    // The board's agent, both scripted agents, and where the Agents card is
    // (the demo console's Settings page, read-only there).
    ['GET', /^\/api\/agent\/status$/, () => ({ ...demoAgentInfo('demo'), profiles: demoProfiles(), settingsUrl: settingsUrlOf() })],
    [
      'GET',
      /^\/api\/agent\/boards\/([a-z0-9-]+)\/threads$/,
      ({ params, search }) => {
        const access = chatAccess(params[0])
        const prefix = `${access.project.id}/${params[0]}/`
        const needle = searchNeedle(new URLSearchParams(search || '').get('q')?.slice(0, QUERY_MAX))
        return {
          threads: Object.entries(state.threads)
            .filter(([key, list]) => key.startsWith(prefix) && list.length && THREAD_RE.test(key.slice(prefix.length)))
            .map(([key]) => threadAt(key, key.slice(prefix.length)))
            .filter((thread) => visibleTo(thread, viewerOf(access)))
            .map((thread) => threadSummary(thread, needle))
            .filter(Boolean)
            .sort(newestFirst),
        }
      },
    ],
    [
      'GET',
      /^\/api\/agent\/boards\/([a-z0-9-]+)\/threads\/([a-z0-9-]+)$/,
      ({ params }) => {
        const access = chatAccess(params[0], params[1])
        const key = threadKey(access, params[0], params[1])
        const thread = threadAt(key, params[1])
        return {
          id: params[1],
          messages: undoState(key, messagesOf(key)),
          kind: threadKind(params[1]),
          title: titleOf(thread),
          archived: thread.archived === true,
          shared: threadKind(params[1]) !== 'chat',
          versions: versionsOf(thread),
          running: runs.has(key),
          ratings: ratingsOf(ratingsOfBoard(access, params[0]), params[1], raterOf(access)),
          options: optionsOf(key),
          profileId: thread.profileId || 'default',
          profiles: demoProfiles(),
          agent: { ...demoAgentInfo(demoAgentOf(thread.profileId).id), settingsUrl: settingsUrlOf(access) },
        }
      },
    ],
    // The agent picker: which scripted agent this chat uses. Never while an
    // answer runs; the default stays as it is.
    [
      'POST',
      /^\/api\/agent\/boards\/([a-z0-9-]+)\/threads\/([a-z0-9-]+)\/profile$/,
      ({ params, body }) => {
        const access = chatAccess(params[0], params[1])
        const key = threadKey(access, params[0], params[1])
        if (runs.has(key)) fail(409, 'agent_running', 'Stop the answer before changing its agent.')
        const profileId = body?.profileId
        if (typeof profileId !== 'string' || !demoProfiles().some((item) => item.id === profileId))
          fail(400, 'unknown_profile', 'Choose a saved native agent profile.')
        const meta = metaStore()
        meta[key] = { ...(meta[key] || {}), profileId }
        if (profileId === 'default') delete meta[key].profileId
        if (!Object.keys(meta[key]).length) delete meta[key]
        save()
        return { profileId, agent: demoAgentInfo(demoAgentOf(profileId).id) }
      },
    ],
    [
      'POST',
      /^\/api\/agent\/boards\/([a-z0-9-]+)\/threads\/([a-z0-9-]+)\/options$/,
      ({ params, body }) => {
        const access = chatAccess(params[0], params[1])
        const key = threadKey(access, params[0], params[1])
        if (runs.has(key)) fail(409, 'agent_running', 'Wait for the answer to finish before switching.')
        const options = optionsOf(key)
        const option = options.find((item) => item.id === body?.configId)
        if (!option || !option.values.some((item) => item.value === body?.value))
          fail(400, 'bad_option', 'The agent does not offer that choice.')
        choices.set(`${key}|${option.id}`, body.value)
        return { options: optionsOf(key) }
      },
    ],
    [
      'PATCH',
      /^\/api\/agent\/boards\/([a-z0-9-]+)\/threads\/([a-z0-9-]+)$/,
      ({ params, body }) => {
        const access = chatAccess(params[0], params[1])
        const key = threadKey(access, params[0], params[1])
        const { title, archived } = body || {}
        if ((title !== undefined && typeof title !== 'string') || (archived !== undefined && typeof archived !== 'boolean'))
          fail(400, 'bad_thread_info', 'Send { title: string } or { archived: true | false }.')
        const thread = threadAt(key, params[1])
        if (!thread.messages.length) fail(409, 'empty_thread', 'Send a message in this chat first.')
        if (title !== undefined) renameThread(thread, title)
        if (archived !== undefined) thread.archived = archived
        keepThread(key, thread)
        return { title: titleOf(thread), archived: thread.archived === true }
      },
    ],
    [
      'POST',
      /^\/api\/agent\/boards\/([a-z0-9-]+)\/threads\/([a-z0-9-]+)\/versions\/([a-z0-9_]+)$/,
      ({ params }) => {
        const access = chatAccess(params[0], params[1])
        const key = threadKey(access, params[0], params[1])
        if (runs.has(key)) fail(409, 'agent_running', 'Stop the answer first.')
        const thread = threadAt(key, params[1])
        if (!restoreBranch(thread, params[2], { id: newId('ver'), createdAt: iso() }))
          fail(404, 'unknown_version', 'That version is no longer kept. Reload the thread.')
        keepThread(key, thread)
        return { ok: true }
      },
    ],
    ['POST', /^\/api\/agent\/boards\/([a-z0-9-]+)\/threads\/([a-z0-9-]+)\/messages\/([a-z0-9_]+)\/rating$/, rateRoute(false)],
    ['DELETE', /^\/api\/agent\/boards\/([a-z0-9-]+)\/threads\/([a-z0-9-]+)\/messages\/([a-z0-9_]+)\/rating$/, rateRoute(true)],
    [
      'DELETE',
      /^\/api\/agent\/boards\/([a-z0-9-]+)\/threads\/([a-z0-9-]+)$/,
      ({ params }) => {
        const access = chatAccess(params[0], params[1])
        const key = threadKey(access, params[0], params[1])
        if (runs.has(key)) fail(409, 'agent_running', 'Stop the answer first.')
        delete state.threads[key]
        delete metaStore()[key]
        // A cleared thread is a fresh session: its model and effort start over.
        for (const id of DEMO_OPTIONS.map((item) => item.id)) choices.delete(`${key}|${id}`)
        return { ok: true }
      },
    ],
    [
      'POST',
      /^\/api\/agent\/boards\/([a-z0-9-]+)\/threads\/([a-z0-9-]+)\/messages\/([A-Za-z0-9_-]+)\/undo$/,
      async ({ params }) => {
        const access = chatAccess(params[0], params[1])
        const key = threadKey(access, params[0], params[1])
        if (runs.size) fail(409, 'agent_running', 'Wait for the agent to finish, then undo.')
        const message = messagesOf(key).find((item) => item.id === params[2] && item.role === 'assistant')
        if (!message?.summary?.undo) fail(404, 'undo_unavailable', 'That answer changed nothing that can be undone.')
        if (message.summary.undone) fail(409, 'undo_done', 'That change was undone already.')
        if (latestChange(messagesOf(key)) !== message.id)
          fail(409, 'undo_unavailable', 'A later answer changed things after this one. Undo that one first.')
        const record = undoOf()[message.id]
        if (!record || record.key !== key) fail(410, 'undo_unavailable', 'Undo is no longer available for this answer.')
        if (record.commentId) {
          const store = await commentsOf(access.project, params[0])
          const comment = store.list.find((item) => item.id === record.commentId)
          if (comment) {
            Object.assign(comment, record.before)
            comment.replies = (comment.replies || []).filter((item) => item.id !== record.replyId)
            comment.updatedAt = iso()
          }
        }
        delete undoOf()[message.id]
        message.summary = {
          ...message.summary,
          undo: { ...message.summary.undo, available: false },
          undone: { kind: 'files', files: message.summary.files.length, at: iso(), by: access.user?.name || null },
        }
        save()
        return { ok: true, message }
      },
    ],
    [
      'POST',
      /^\/api\/agent\/boards\/([a-z0-9-]+)\/threads\/([a-z0-9-]+)\/stop$/,
      ({ params }) => {
        const access = chatAccess(params[0], params[1])
        const run = runs.get(threadKey(access, params[0], params[1]))
        if (run) run.controller.abort('stopped')
        return { stopped: Boolean(run) }
      },
    ],
    [
      'POST',
      /^\/api\/agent\/boards\/([a-z0-9-]+)\/threads\/([a-z0-9-]+)\/permissions\/([a-z0-9-]+)$/,
      ({ params, body }) => {
        const access = chatAccess(params[0], params[1])
        const run = runs.get(threadKey(access, params[0], params[1]))
        const optionId = body?.optionId ?? null
        if (optionId !== null && typeof optionId !== 'string') fail(400, 'bad_option', 'optionId is a string or null.')
        const state = run?.answer?.(params[2], optionId)
        if (state === false) fail(400, 'bad_option', 'The agent did not offer that option.')
        if (!state) fail(404, 'no_permission', 'That request is no longer waiting for an answer.')
        return { state }
      },
    ],
    [
      'POST',
      /^\/api\/agent\/boards\/([a-z0-9-]+)\/threads\/([a-z0-9-]+)\/messages$/,
      async ({ params, body, signal }) => {
        const access = chatAccess(params[0], params[1])
        const key = threadKey(access, params[0], params[1])
        if (runs.has(key)) fail(409, 'agent_running', 'An answer is still being written in this thread.')
        // Regenerate (the server's rules, src/agent/routes.js): the latest
        // answer only, the same request again, the new answer in its place.
        let previous = null
        if (body?.regenerate !== undefined) {
          if (body?.fix === true) fail(400, 'bad_regenerate', 'Regenerate and Fix with agent do not go together.')
          const list = messagesOf(key)
          const last = list.at(-1)
          if (!last || last.id !== String(body.regenerate) || last.role !== 'assistant' || list.at(-2)?.role !== 'user')
            fail(409, 'cannot_regenerate', 'Only the latest answer to a message can be regenerated.')
          previous = last
        }
        const text = previous
          ? messagesOf(key).at(-2).text || ''
          : typeof body?.text === 'string'
            ? body.text.replace(/\r\n/g, '\n').trim().slice(0, 8000)
            : ''
        const raw = !previous && Array.isArray(body?.attachments) ? body.attachments.slice(0, 4) : []
        // Composer extras, checked like the server's (src/agent/composer.js).
        const files = previous ? [] : demoFiles(body?.files)
        const mentionIds = !previous && Array.isArray(body?.mentions) ? body.mentions.slice(0, 8) : []
        if (!previous && !text && !raw.length && !files.length && !mentionIds.length)
          fail(400, 'empty_message', 'Write a message or attach an image.')
        const editOf = body?.editOf ?? null
        if (editOf !== null && (typeof editOf !== 'string' || body?.fix === true || previous))
          fail(400, 'bad_edit', 'editOf is the id of one of your messages in this thread.')
        if (editOf !== null && !messagesOf(key).some((item) => item.id === editOf && item.role === 'user'))
          fail(404, 'unknown_message', 'That message is no longer in this thread. Reload it and try again.')
        const attachments = raw.map((item, index) => {
          if (!/^image\/(png|jpeg|webp|gif)$/.test(String(item?.mediaType || '')))
            fail(400, 'bad_attachment', 'Attach PNG, JPEG, WebP or GIF images.')
          const data = String(item.data || '').replace(/^data:[^;,]+;base64,/, '')
          const file = `${hex(12)}.${item.mediaType.split('/')[1].replace('jpeg', 'jpg')}`
          return {
            id: file.split('.')[0],
            name: cleanText(item.name, 120) || `image-${index + 1}`,
            mediaType: item.mediaType,
            file,
            bytes: Math.floor((data.length * 3) / 4),
            ...(item.source ? { source: item.source } : {}),
            data,
          }
        })
        const controller = new AbortController()
        const run = { controller, answer: null }
        // Taken before the awaits so a second message waits its turn; given
        // back if the board cannot be read, so the thread is not stuck.
        runs.set(key, run)
        let store
        let view
        try {
          store = await commentsOf(access.project, params[0])
          view = await boardViewOf(access.project, params[0])
        } catch (error) {
          runs.delete(key)
          throw error
        }
        let mentions
        try {
          mentions = demoMentions(mentionIds, { comments: store.list, pages: view.board.pages, journeys: view.journeys || [] })
        } catch (error) {
          runs.delete(key)
          throw error
        }
        signal?.addEventListener('abort', () => controller.abort('disconnected'))
        let userMessage
        if (previous) userMessage = messagesOf(key).at(-2)
        else {
          userMessage = {
            id: newId('msg'),
            role: 'user',
            text,
            attachments: attachments.map(({ data: _data, ...rest }) => rest),
            ...(mentions.length ? { mentions } : {}),
            ...(files.length ? { files } : {}),
            createdAt: iso(),
          }
          // The first message claims a New chat; an edit keeps what it
          // replaced as an earlier version, with its images.
          const thread = threadAt(key, params[1])
          if (threadKind(params[1]) === 'chat' && !thread.owner) thread.owner = viewerOf(access)
          if (!thread.createdAt) thread.createdAt = thread.messages[0]?.createdAt || userMessage.createdAt
          thread.messages = [...thread.messages]
          if (editOf !== null) {
            const at = thread.messages.findIndex((item) => item.id === editOf)
            const tail = branchFrom(thread, at, { id: newId('ver'), createdAt: userMessage.createdAt })
            if (!userMessage.attachments.length) userMessage.attachments = [...(tail[0].attachments || [])]
            userMessage.editedFrom = tail[0].id
          }
          thread.messages.push(userMessage)
          if (thread.messages.findIndex((item) => item.role === 'user') === thread.messages.length - 1) refreshAutoTitle(thread)
          keepThread(key, thread)
        }
        const messages = messagesOf(key)
        const context = {
          threadId: params[1],
          comments: store.list,
          pages: view.board.pages,
          variants: view.variants || [],
          attachments,
          mentions,
          files,
          options: optionsOf(key),
          history: messages.length,
          fix: body?.fix === true,
          regenerate: Boolean(previous),
          board: view.board,
          user: access.user,
        }
        // Fix with agent: the comment moves through working like on a real
        // board; an approved (pretend) edit ends as "Agent done" with a reply
        // on the thread, anything else puts the comment back as it was.
        const fixing =
          body?.fix === true && params[1].startsWith('comment-') ? store.list.find((item) => item.id === Number(params[1].slice(8))) : null
        const before = fixing ? { agentStatus: fixing.agentStatus ?? null, agentStatusAt: fixing.agentStatusAt ?? null } : null
        if (fixing && fixing.status === 'open') {
          fixing.agentStatus = 'working'
          fixing.agentStatusAt = iso()
        }
        const events = (async function* stream() {
          let reply = null
          try {
            yield ['user', { message: userMessage }]
            reply = yield* runScriptedTurn({
              text,
              context,
              signal: controller.signal,
              run,
              now,
              voice: demoAgentOf(threadAt(key, params[1]).profileId).voice,
            })
            const index = previous ? messages.indexOf(previous) : -1
            if (index >= 0) {
              const { versions = [], ...old } = previous
              reply.versions = [...versions, old].slice(-VERSIONS_MAX)
              messages[index] = reply
            } else messages.push(reply)
            yield ['done', { message: reply }]
          } finally {
            if (fixing && fixing.agentStatus === 'working') {
              const approved =
                reply?.status === 'done' && reply.cards.some((card) => card.kind === 'permission' && card.state === 'approved')
              if (approved) {
                fixing.agentStatus = 'done'
                fixing.agentStatusAt = iso()
                fixing.replies = fixing.replies || []
                const replyId = Math.max(0, ...fixing.replies.map((item) => Number(item.id) || 0)) + 1
                // Undo puts the comment back as it was (the "file" was never real).
                if (reply?.summary) undoOf()[reply.id] = { key, commentId: fixing.id, before, replyId }
                fixing.replies.push({
                  id: replyId,
                  author: 'Coding agent',
                  agent: true,
                  body: 'Made the change and recaptured the page. Have a look, then resolve this or reply "not yet". (Demo: nothing was edited.)',
                  createdAt: iso(),
                })
                fixing.updatedAt = iso()
              } else Object.assign(fixing, before)
            } else if (reply?.summary) undoOf()[reply.id] = { key, commentId: null }
            save()
            runs.delete(key)
          }
        })()
        return { status: 200, events, attachments }
      },
    ],
  ]
}
