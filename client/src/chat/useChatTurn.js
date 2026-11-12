// One agent turn, from the click to the stored answer: the message goes out,
// the reply streams into the turn store (turns.js) a frame at a time, and at
// the end the thread on screen takes the result. The turn outlives the panel
// that started it; whatever it must hand back (an unsent draft, queued
// messages, a notice) waits in the store for its thread.
import { fileUrl } from '../lib/api'
import { ATTACH_MAX, cropCapture } from './images'
import { sendMessage } from './stream'
import { createFrameBatcher } from './livetext'
import { setAgentFocus } from './agentFocus'
import { hostOf, isSending, queueOf, setAbort, setRun as storeRun, setSending, stash, updateQueue } from './turns'
import { FIX_PROMPT } from './messages'
import { hideNextSteps } from '../../../src/agent/next-steps.js'
import { MENTIONS_MAX, TEXT_FILES_MAX, mentionsForServer } from './composerModel.js'
import { applyTurnEvent } from './turnEvents.js'

export const commentOfThread = (threadId) => (/^comment-(\d+)$/.exec(threadId || '') ? Number(threadId.slice(8)) : null)

// The comment a turn works on: its own thread's, or on the board thread the
// "#12" a tool card names (the demo agent and Shapewall's MCP tools say it).
function focusOfTurn(threadId, cards, comments) {
  const own = commentOfThread(threadId)
  if (own) return own
  for (const card of cards || []) {
    const match = /#(\d{1,9})\b/.exec(card.label || '')
    if (match && comments.some((item) => item.id === Number(match[1]))) return Number(match[1])
  }
  return null
}

// The items of `a`, then those of `b` whose `key` is not in `a`.
export const mergeBy = (a, b, key) => [...a, ...b.filter((item) => !a.some((entry) => entry[key] === item[key]))]

// Sent by an approval or a send the server keeps for the owner (ChatPanel's OWNER_ONLY).
export const ownerOnlyError = (error) => error?.status === 403 && error.code === 'control_needs_owner'

export function useChatTurn({
  boardId,
  threadId,
  draft,
  attachments,
  mentions,
  files,
  running,
  dictation,
  speaker,
  messages,
  comment,
  comments,
  captureFor,
  imageVersion,
  scroll,
  setHelp,
  setNotice,
  setDraft,
  setAttachments,
  setMentions,
  setFiles,
  setSentIn,
  setRun,
  onFixDone,
  // The chat's agent options for this message ({ configId: value }) or null.
  optionChoices = () => null,
}) {
  // A send while a turn is still running in progress (between the click and
  // the stream starting too): one at a time.
  // Resolves true when the message went out (whatever the answer), false
  // when it was not sent (a turn running, dictation on, nothing to send).
  // `queued`: an item from the queue (its own text and attachments); the
  // composer's contents stay where they are.
  // `editOf`: rerun from an edited earlier message (history: the server keeps
  // the replaced turns as an earlier version). The composer is left alone.
  // `regenerate`: { message, request } asks again for the latest answer; the
  // new one takes its place, the old one stays as an earlier version. All of
  // them stream like any turn (frame-batched below).
  const submit = async (textValue = draft, fix = false, { queued = null, editOf = null, regenerate = null } = {}) => {
    const fromComposer = !editOf && !regenerate
    const item = queued || {
      text: regenerate ? regenerate.request.text || '' : String(textValue ?? '').trim(),
      fix: fromComposer && fix,
      attachments: fromComposer ? attachments : [],
      mentions: fromComposer ? mentions : [],
      files: fromComposer ? files : [],
    }
    fix = Boolean(item.fix)
    const text = fix ? FIX_PROMPT : item.text
    if (running || isSending(boardId) || dictation.listening) return false
    if (editOf && !text) return false
    if (!regenerate && !fix && !text && !item.attachments.length && !item.mentions.length && !item.files.length) return false
    setSending(boardId, true)
    const startedThread = threadId
    dictation.cancel()
    speaker.stop()
    setHelp(false)
    const edited = editOf ? messages.find((message) => message.id === editOf) : null
    let sent = regenerate ? regenerate.request.attachments || [] : item.attachments
    if (fix && comment) {
      try {
        const files = captureFor(comment.pageId, comment.viewport)
        if (files)
          sent = [
            await cropCapture(fileUrl(boardId, 'captures', files.file, imageVersion), {
              name: `comment-${comment.id}.png`,
              point: { x: comment.x, y: comment.y },
              source: { kind: 'element', pageId: comment.pageId, viewport: comment.viewport, commentId: comment.id },
            }),
          ]
      } catch {
        /* The page and element context are still supplied by the server. */
      }
    }
    // The chat's options (model, thinking, ...) go with every turn: a session
    // that stopped meanwhile starts with them again (src/agent/routes.js).
    const choices = optionChoices()
    const withOptions = (value) => (choices && Object.keys(choices).length ? { ...value, options: choices } : value)
    const body = regenerate
      ? withOptions({ regenerate: regenerate.message.id })
      : withOptions({
          text,
          ...(fix ? { fix: true } : {}),
          ...(editOf ? { editOf } : {}),
          attachments: sent.map(({ name, mediaType, data, source }) => ({ name, mediaType, data, ...(source ? { source } : {}) })),
          // Composer extras (src/agent/composer.js): mention ids and text files.
          ...(item.mentions.length ? { mentions: mentionsForServer(item.mentions) } : {}),
          ...(item.files.length
            ? { files: item.files.map(({ name, mediaType, text: content }) => ({ name, mediaType, text: content })) }
            : {}),
        })
    setNotice(null)
    if (!queued && fromComposer) {
      setDraft('')
      setAttachments([])
      setMentions([])
      setFiles([])
    }
    scroll.stickNow()
    const startedAt = Date.now()
    let pending = {
      user: regenerate
        ? regenerate.request
        : {
            id: 'pending',
            role: 'user',
            text,
            attachments: edited ? edited.attachments || [] : sent,
            mentions: item.mentions,
            files: item.files,
          },
      replaces: regenerate?.message.id || null,
      reply: { id: 'live', role: 'assistant', text: '', reasoning: '', cards: [] },
      status: 'Sending',
      // Text was the last thing to arrive: the activity line says "Writing".
      writing: false,
      startedAt,
      final: null,
      threadId: startedThread,
      editOf,
    }
    setRun(pending)
    // Text and thinking arrive in many small pieces: one render per frame.
    // Everything else (cards, status, the end) renders at once, in order.
    const frame = createFrameBatcher(() => setRun(pending))
    setSentIn((current) => (current.has(startedThread) ? current : new Set(current).add(startedThread)))
    // The comment this turn works on, for the pin on the canvas (agentFocus.js).
    let focusId = focusOfTurn(startedThread, [], comments)
    const publishFocus = (state) => {
      focusId = focusId ?? focusOfTurn(startedThread, pending.reply.cards, comments)
      if (focusId !== null) setAgentFocus(boardId, focusId, state)
    }
    publishFocus('working')
    let accepted = false
    let interrupted = null
    const controller = new AbortController()
    setAbort(boardId, controller)
    try {
      await sendMessage(boardId, startedThread, body, {
        signal: controller.signal,
        onEvent: (name, data) => {
          if (name === 'tool')
            queueMicrotask(() =>
              publishFocus(
                pending.reply.cards.some((card) => card.kind === 'permission' && card.state === 'pending') ? 'waiting' : 'working',
              ),
            )
          // What the event does to the turn on screen (turnEvents.js).
          const result = applyTurnEvent(pending, name, data)
          pending = result.pending
          if (result.accepted) accepted = true
          if (result.stream) frame.queue()
          else frame.now()
        },
      })
      if (!pending.final) throw new Error('The response was interrupted. Try again.')
    } catch (error) {
      interrupted = error
      // A notice and a restored draft belong to the thread that sent it: they
      // wait there (turns.js stash) when another thread, or no panel, is on screen.
      if (error.name !== 'AbortError' && !pending.final) {
        // Only restore a message the server did not accept. An interrupted
        // response must not invite an accidental duplicate send.
        const restore = !accepted && !editOf && !regenerate
        stash(boardId, startedThread, (composer) => {
          // Not an error to retry: the owner-only note takes the composer's place.
          if (ownerOnlyError(error)) composer.setOwnerRefused(true)
          else composer.setNotice({ tone: 'bad', text: error.message })
          if (!restore) return
          composer.setDraft(text)
          composer.setAttachments(sent)
          composer.setMentions(item.mentions)
          composer.setFiles(item.files)
        })
      }
    } finally {
      frame.cancel()
      setAbort(boardId, null)
      // Another thread on screen now (or the panel closed): its data is not
      // this turn's to write. The server saved the turn; that thread loads it.
      // The panel on screen may be a later one than the one that sent this.
      const live = () => hostOf(boardId)
      const here = () => live()?.threadId === startedThread
      const refreshed = here() ? await live().thread.refetch() : null
      if (accepted && !pending.final && interrupted) {
        // The server may already have saved the stopped/error answer. Prefer it;
        // otherwise keep the received turn visible as interrupted, never complete.
        const stored = refreshed?.messages || []
        const sentIndex = stored.findIndex((message) => message.id === pending.user.id)
        const savedReply = sentIndex >= 0 && stored.slice(sentIndex + 1).find((message) => message.role === 'assistant')
        if (!savedReply) {
          pending.final = {
            ...pending.reply,
            text: hideNextSteps(pending.reply.text),
            cards: pending.reply.cards.map((card) => ({
              ...card,
              state: card.state === 'running' ? 'error' : card.state === 'pending' ? 'cancelled' : card.state,
            })),
            id: `interrupted-${pending.user.id}`,
            durationMs: Date.now() - startedAt,
            status: interrupted.name === 'AbortError' ? 'stopped' : 'error',
            error: interrupted.name === 'AbortError' ? null : { code: 'interrupted', message: 'The response was interrupted. Try again.' },
          }
        }
      }
      // The done event is authoritative even when the follow-up fetch fails.
      // Merge by id so a refresh never flashes or duplicates the final answer.
      // This turn's stream has ended, so the thread is not running any more
      // (the reload above can race the server letting go of the turn).
      if (here()) {
        live().thread.setData((current) => {
          if (!current) return current
          if (!pending.final) return current.running ? { ...current, running: false } : current
          let stored = current.messages || []
          // An edit replaced the edited message and everything after it;
          // a regenerated answer gave its place to the new one.
          const cut = editOf ? stored.findIndex((message) => message.id === editOf) : -1
          if (cut >= 0) stored = stored.slice(0, cut)
          if (pending.replaces) stored = stored.filter((message) => message.id !== pending.replaces)
          const ids = new Set(stored.map((message) => message.id))
          return {
            ...current,
            running: false,
            messages: [...stored, ...[pending.user, pending.final].filter((message) => !ids.has(message.id))],
          }
        })
      }
      // Queued messages go out only after a complete answer. After Stop, an
      // error or a lost connection they come back into the box instead (like
      // Codex): nothing is sent that the person did not see the outcome of.
      const completed = Boolean(pending.final && pending.final.status === 'done' && !pending.final.error)
      const waiting = queueOf(boardId).filter((entry) => entry.threadId === startedThread)
      if (!completed && waiting.length) {
        updateQueue(boardId, (current) => current.filter((entry) => entry.threadId !== startedThread))
        const stopped = pending.final?.status === 'stopped' || interrupted?.name === 'AbortError'
        stash(boardId, startedThread, (composer) => {
          composer.setDraft((current) => [current.trim(), ...waiting.map((entry) => entry.text)].filter(Boolean).join('\n\n'))
          composer.setMentions((current) =>
            mergeBy(
              current,
              waiting.flatMap((entry) => entry.mentions),
              'key',
            ).slice(0, MENTIONS_MAX),
          )
          composer.setFiles((current) => [...current, ...waiting.flatMap((entry) => entry.files)].slice(0, TEXT_FILES_MAX))
          composer.setAttachments((current) => [...current, ...waiting.flatMap((entry) => entry.attachments)].slice(0, ATTACH_MAX))
          composer.setNotice({
            tone: 'info',
            text: stopped
              ? 'Stopped. Your queued messages are back in the box; send them when ready.'
              : 'The answer did not finish, so your queued messages are back in the box.',
          })
        })
      }
      setSending(boardId, false)
      live()?.threads.refetch()
      storeRun(boardId, null)
      publishFocus(pending.final && !['stopped', 'error'].includes(pending.final.status) && !pending.final.error ? 'done' : 'stopped')
      if (fix) (live()?.onFixDone || onFixDone)?.()
    }
    // An edit that the server refused stays open in its editor.
    return editOf ? accepted : true
  }
  return submit
}
