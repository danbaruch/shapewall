// The composer's agent options (model, thinking level, mode, ...) from the
// moment the panel shows a chat: before the first message they come from
// POST .../prepare (the thread's agent session, started the way its first
// turn starts it, or what the server already knows of that agent); once a
// session runs, from the thread itself. The choices live in this browser
// (composerModel.js prefs): per chat, and the last used per agent as the
// default for a new chat. They go with every message, so a session that
// stopped meanwhile (idle, a server restart) starts with them again.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import {
  agentOptionKey,
  chatOptionKey,
  choicesFor,
  keepChoices,
  loadOptionPrefs,
  rememberChoice,
  saveOptionPrefs,
  withChoices,
} from './composerModel.js'

const threadUrl = (boardId, threadId, tail) =>
  `/api/agent/boards/${encodeURIComponent(boardId)}/threads/${encodeURIComponent(threadId)}/${tail}`

// `enabled`: the panel is on screen, the chat's agent is ready and this
// viewer may use it (nothing is asked for, so no agent starts, otherwise).
// `fresh`: the chat has no message yet. `live`: the running session's
// options from the thread, which win once there are any.
// `profileId`: the agent this chat runs, by its own id (not its name, which its owner may change).
export function useAgentOptions({ boardId, threadId, profileId, enabled, fresh, live, onLive, onNotice }) {
  const [prefs, setPrefs] = useState(loadOptionPrefs)
  const chat = chatOptionKey(boardId, threadId)
  const agent = agentOptionKey(profileId)
  const choices = useMemo(() => choicesFor(prefs, { chat, agent, fresh }), [prefs, chat, agent, fresh])
  const choicesRef = useRef(choices)
  choicesRef.current = choices
  // { key, options, error, loading } for the chat and agent on screen.
  const [prepared, setPrepared] = useState({ key: null, options: null, error: null, loading: false })
  const key = `${chat}|${agent}`
  const hasLive = Boolean(live?.length)

  const load = useCallback(
    async (force = false) => {
      const started = key
      setPrepared((current) => ({ key: started, options: current.key === started ? current.options : null, error: null, loading: true }))
      let result = null
      try {
        result = await api.post(threadUrl(boardId, threadId, 'prepare'), { choices: choicesRef.current, ...(force ? { force: true } : {}) })
      } catch {
        result = null
      }
      setPrepared((current) =>
        current.key === started
          ? { key: started, options: result?.options || null, error: result?.error || null, loading: false }
          : current,
      )
      return result
    },
    [boardId, threadId, key],
  )

  // Once per chat and agent while the panel shows it; never for a hidden
  // panel or a viewer who cannot chat; not again while a session answers.
  const loadedFor = useRef(null)
  useEffect(() => {
    if (!enabled || hasLive || loadedFor.current === key) return
    loadedFor.current = key
    load()
  }, [enabled, hasLive, key, load])

  const shownPrepared = prepared.key === key ? prepared : null
  const options = hasLive ? live : shownPrepared?.options ? withChoices(shownPrepared.options, choices) : null
  const loading = Boolean(enabled && !hasLive && (!shownPrepared || shownPrepared.loading) && !shownPrepared?.options)

  // A pick, from the next message on: the running session switches now;
  // without one the server checks it against what the agent offers.
  const choose = async (configId, value) => {
    try {
      const result = await api.post(threadUrl(boardId, threadId, 'options'), { configId, value, choices: choicesRef.current })
      setPrefs((current) => saveOptionPrefs(rememberChoice(current, { chat, agent, configId, value, base: choicesRef.current })))
      if (hasLive) onLive?.(result.options)
      else setPrepared((current) => (current.key === key ? { ...current, options: result.options } : current))
    } catch (error) {
      onNotice?.({ tone: 'bad', text: error.message })
    }
  }

  // What a message sends: this chat's choices (kept with the chat on its
  // first message).
  const forMessage = () => {
    const now = choicesRef.current
    if (Object.keys(now).length) setPrefs((current) => saveOptionPrefs(keepChoices(current, { chat, choices: now })))
    return now
  }

  return {
    options: options?.length ? options : null,
    loading,
    // Not signed in (prepare said so): the chat can say it before a message.
    error: shownPrepared?.error || null,
    choose,
    forMessage,
    // Check again: start the agent afresh; resolves to the server's answer.
    recheck: () => load(true),
  }
}

// Whether `ref`'s element is on screen (laid out, in view, the tab visible):
// a panel kept mounted while hidden asks for nothing.
export function useOnScreen(ref) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!node) return undefined
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true)
      return undefined
    }
    let inView = false
    const update = () => setShown(inView && document.visibilityState !== 'hidden')
    const observer = new IntersectionObserver((entries) => {
      inView = entries.some((entry) => entry.isIntersecting)
      update()
    })
    observer.observe(node)
    document.addEventListener('visibilitychange', update)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', update)
    }
  }, [ref])
  return shown
}
