// The chat panel: a thread per board and per comment with the agent the
// person connected (docs/agents.md). Markdown replies that stream in as they
// are written, with a live activity line and cards while the agent works; images from the file picker, paste,
// drop or the board screenshots; voice in and read aloud where supported.
//
// This file is the orchestrator (state, the streaming turn, threads). The
// pieces it renders live beside it: header.jsx (header, settings, the chat
// history button and New chat, the agent picker, not connected), history.jsx
// (chat history: search, rename, archive, export, delete), messages.jsx (the message list), cards.jsx
// (tool, plan and permission cards) and composer.jsx (the composer).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Lock } from 'lucide-react'
import { api, fileUrl } from '../lib/api'
import { cn } from '../lib/utils'
import { useResource } from '../lib/hooks'
import { cropCapture, ATTACH_MAX, fromFile, imageFiles } from './images'
import { NaturalDownloadStrip } from './ReadAloud'
import { savedVoice, saveVoice, useDictation, useSpeaker } from './speech'
import { checkDownloaded, startNatural } from './tts/natural.js'
import { loadReadAloud, saveReadAloud } from './tts/settings.js'
import { answerPermission, stopThread, threadPath, undoTurn } from './stream'
import { useFollowScroll } from './follow'
import { RefsContext } from './RefChip'
import { buildRefIndex } from './refs'
import { abortOf, isSending, registerHost, setRun as storeRun, takeStash, updateQueue, useTurns } from './turns'
import { ConnectedNote } from './QuickConnect'
import { ChatHeader, ConnectAgent } from './header'
import { CONTINUE_PROMPT, FIX_PROMPT, MessageList } from './messages'
import { choice, otherProfile, pickerProfiles, switchedNote } from './profiles'
import { Composer } from './composer'
import { commentOfThread, mergeBy, ownerOnlyError, useChatTurn } from './useChatTurn'
import { useAutoAllow } from './useAutoAllow'
import { excerpt } from './text'
import { ChatHistory, exportThread, restoreVersion } from './history'
import { fallbackTitle, isChatThread, newChatId, threadKind } from './threads'
import { useAnswerRatings } from './actions'
import { AllowForChat } from './allowForChat'
import { AutoAllowSettings } from './composerParts'
import {
  MENTIONS_MAX,
  TEXT_FILES_MAX,
  availableCommands,
  commandPrompt,
  followUps as followUpsFor,
  isTextFile,
  mentionCandidates,
  readTextFile,
  slashInput,
} from './composerModel.js'

const PAGE_ITEMS_MAX = 40

// A local board's ACP agent runs commands as the person, so the server lets
// only its owner use it (403 control_needs_owner; `agent.chatNeedsOwner` says
// so up front). Said once, calmly, in place of a composer that would fail.
export const OWNER_ONLY =
  'Only the owner can run this agent. Open the owner link from your terminal (shapewall serve --open), or use a paired device.'

export { threadForComment } from './threads'
export { commentOfThread }
// ---- The panel -------------------------------------------------------------------

export default function ChatPanel({
  boardId,
  agent: defaultAgent,
  threadId,
  onThread,
  onClose,
  comments,
  pages,
  captures,
  imageVersion,
  defaultViewport,
  focused,
  touch = false,
  heading = true,
  onOpenSettings = null,
  settingsHint = null,
  onAgentChanged = null,
  fixRequest = null,
  onFixDone = null,
  // References in answers (refs.js): journeys and checks counts to link to,
  // and the board's navigation for a chip (null: chips are plain text).
  journeys = [],
  checksCounts = null,
  onNavigate = null,
  // "Recapture to verify" on a run summary (a list of page ids) and the
  // composer's /recapture (one page id); null: the whole board.
  onRecapture = null,
  // After an Undo: the board's comments may have changed.
  onBoardChanged = null,
  // The composer's "@" list and "/" commands (composer track).
  people = [],
  onRunChecks = null,
}) {
  // The test result of a one-click Connect, shown above the new thread.
  const [connected, setConnected] = useState(null)
  // A starter agent run (shapewall agent) writes this thread from another
  // process: poll it while one is running or waits for an answer.
  const [starterBusy, setStarterBusy] = useState(false)
  // A turn the server is running in this thread that this tab did not start
  // (another tab or person, or this tab before a reload): poll until it ends.
  const [remoteBusy, setRemoteBusy] = useState(false)
  const thread = useResource(defaultAgent ? threadPath(boardId, threadId) : null, { pollMs: starterBusy || remoteBusy ? 3000 : 0 })
  const threads = useResource(defaultAgent ? `/api/agent/boards/${encodeURIComponent(boardId)}/threads` : null)
  // useResource loads the thread; a changed agent (connected, settings saved)
  // loads it again.
  const refetchThread = thread.refetch
  const agentSeen = useRef(defaultAgent)
  useEffect(() => {
    if (agentSeen.current === defaultAgent) return
    agentSeen.current = defaultAgent
    refetchThread()
  }, [defaultAgent, refetchThread])
  const selectedThread = thread.data?.id === threadId ? thread.data : null
  const agent = selectedThread?.agent ? { ...defaultAgent, ...selectedThread.agent } : defaultAgent
  const configured = Boolean(agent?.configured)
  const [selectingProfile, setSelectingProfile] = useState(false)
  // Resolves to whether the chat now uses `profileId`.
  const chooseProfile = async (profileId) => {
    setSelectingProfile(true)
    try {
      await api.post(`/api/agent/boards/${encodeURIComponent(boardId)}/threads/${encodeURIComponent(threadId)}/profile`, { profileId })
      await thread.refetch()
      return true
    } catch (error) {
      setNotice({ tone: 'bad', text: error.message })
      return false
    } finally {
      setSelectingProfile(false)
    }
  }
  const [draft, setDraft] = useState('')
  // Threads this person sent something in since the panel opened: their
  // starter prompts are put away.
  const [sentIn, setSentIn] = useState(() => new Set())
  const [attachments, setAttachments] = useState([])
  // "@" mentions and text files waiting to go with the next message.
  const [mentions, setMentions] = useState([])
  const [files, setFiles] = useState([])
  // The turn in flight and the messages written while it runs (sent one by
  // one when it finishes: [{ id, threadId, text, fix, attachments, mentions,
  // files }]) live in turns.js, so they outlast this panel closing.
  const { run, queue, stashed } = useTurns(boardId)
  const setRun = useCallback((value) => storeRun(boardId, value), [boardId])
  const setQueue = useCallback((update) => updateQueue(boardId, update), [boardId])
  const [help, setHelp] = useState(false)
  const [notice, setNotice] = useState(null)
  // The server refused a send or an approval with control_needs_owner.
  const [ownerRefused, setOwnerRefused] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [voiceUri, setVoiceUri] = useState(savedVoice)
  const [readAloud, setReadAloud] = useState(loadReadAloud)
  const speaker = useSpeaker()
  // Natural voices on and already downloaded: load them from the browser's
  // cache now, so the first Read aloud uses them.
  useEffect(() => {
    if (!readAloud.natural) return
    let live = true
    checkDownloaded()
      .then((downloaded) => live && downloaded && startNatural({ voice: readAloud.voice }))
      // No cache to read (private window, storage blocked): the voices load on first use.
      .catch(() => {})
    return () => {
      live = false
    }
    // Only turning it on loads it; a new voice is fetched on its first use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readAloud.natural])
  // The thread on screen now, for async work that started in another one.
  const threadRef = useRef(threadId)
  threadRef.current = threadId
  // Closing the panel leaves a turn running: the server stops the agent when
  // the stream disconnects, so the stream is not aborted, only detached. The
  // turn finds the panel that is on screen when it ends through this host.
  const host = useRef(null)
  host.current = { threadId, thread, threads, onFixDone }
  useEffect(() => registerHost(boardId, host), [boardId])
  const listRef = useRef(null)
  const dictationBase = useRef('')
  const commentId = commentOfThread(threadId)
  const comment = commentId ? comments.find((item) => item.id === commentId) || null : null
  const messages = useMemo(
    () => (thread.data?.id === threadId && Array.isArray(thread.data.messages) ? thread.data.messages : []),
    [thread.data, threadId],
  )
  useEffect(() => {
    setStarterBusy(
      messages.some(
        (message) =>
          message.starter?.state === 'running' || message.cards?.some((card) => card.answerable === true && card.state === 'pending'),
      ),
    )
  }, [messages])
  const remoteRunning = Boolean(selectedThread?.running) && !run
  useEffect(() => setRemoteBusy(remoteRunning), [remoteRunning])
  const running = Boolean(run) || selectingProfile || remoteRunning
  const answerRatings = useAnswerRatings({ boardId, threadId, thread: thread.data })

  const dictation = useDictation((text) => {
    const base = dictationBase.current
    setDraft(`${base}${base && !/\s$/.test(base) ? ' ' : ''}${text}`)
  })

  const readMessage = (message) => {
    dictation.cancel()
    speaker.speak(message.id, message.text, { voiceUri, readAloud })
  }
  const cancelDictation = dictation.cancel
  const stopSpeaking = speaker.stop
  useEffect(() => {
    cancelDictation()
    stopSpeaking()
  }, [boardId, threadId, cancelDictation, stopSpeaking])

  // Follow the answer while the reader is at the bottom (follow.js).
  const scroll = useFollowScroll(listRef, threadId)
  const followScroll = scroll.follow
  useEffect(() => {
    followScroll()
  }, [messages, run, followScroll])

  const shownThread = useRef(threadId)
  useEffect(() => {
    if (shownThread.current === threadId) return
    shownThread.current = threadId
    setNotice(null)
    setAttachments([])
    setMentions([])
    setFiles([])
    setHelp(false)
  }, [threadId])
  // What a turn that ended badly gave back to this thread (turns.js stash):
  // the unsent draft, its queued messages, a notice.
  useEffect(() => {
    for (const op of takeStash(boardId, threadId)) op({ setDraft, setAttachments, setMentions, setFiles, setNotice, setOwnerRefused })
  }, [boardId, threadId, stashed])

  const addAttachments = useCallback(
    async (makers) => {
      const started = threadRef.current
      setNotice(null)
      for (const make of makers) {
        try {
          const item = await make()
          // The thread changed while the image was cropped: it belonged to the old one.
          if (threadRef.current !== started) return
          setAttachments((current) => {
            if (current.length >= ATTACH_MAX) {
              setNotice({ tone: 'warn', text: `Attach at most ${ATTACH_MAX} images to a message.` })
              return current
            }
            return [...current, item]
          })
        } catch (error) {
          if (threadRef.current !== started) return
          setNotice({ tone: 'bad', text: error.message })
        }
      }
    },
    [setAttachments],
  )
  // Images (when the model takes them) and text files (.txt, .log, .md,
  // .json, .csv), from the picker, a paste or a drop. True when any was taken.
  const addTextFiles = async (list) => {
    const started = threadRef.current
    for (const file of list) {
      try {
        const item = await readTextFile(file)
        if (threadRef.current !== started) return
        setFiles((current) => {
          if (current.length >= TEXT_FILES_MAX) {
            setNotice({ tone: 'warn', text: `Attach at most ${TEXT_FILES_MAX} text files to a message.` })
            return current
          }
          return [...current, item]
        })
      } catch (error) {
        if (threadRef.current === started) setNotice({ tone: 'bad', text: error.message })
      }
    }
  }
  const addFiles = (list) => {
    const texts = [...(list || [])].filter(isTextFile)
    const images = vision ? imageFiles(list) : []
    if (images.length) addAttachments(images.map((file) => () => fromFile(file)))
    if (texts.length) addTextFiles(texts)
    if (!vision && imageFiles(list).length && !texts.length) setNotice({ tone: 'warn', text: 'This model does not take images.' })
    // Other kinds (a PDF, a zip) say so, like a file that is too big.
    const known = new Set([...texts, ...imageFiles(list)])
    const other = [...(list || [])].filter((file) => !known.has(file))
    if (other.length) {
      const what = other.length === 1 ? `${other[0].name || 'That file'} can't be attached` : `${other.length} files can't be attached`
      setNotice({
        tone: 'bad',
        text: `${what}. Attach ${vision ? 'images (PNG, JPEG, WebP, GIF) or ' : ''}text files (.txt, .log, .md, .json, .csv).`,
      })
    }
    return images.length + texts.length > 0
  }
  const captureFor = (pageId, viewport) => captures?.[pageId]?.[viewport] || null
  // `mentionKey`: the image came with an "@" mention and goes when it is removed.
  const attachPage = (page, viewport, mentionKey = null) =>
    addAttachments([
      async () => {
        const files = captureFor(page.id, viewport)
        if (!files) throw new Error(`${page.title} has no ${viewport} capture yet.`)
        const item = await cropCapture(fileUrl(boardId, 'captures', files.file, imageVersion), {
          name: `${page.id}.${viewport}.jpg`,
          source: { kind: 'page', pageId: page.id, viewport },
        })
        return mentionKey ? { ...item, mentionKey } : item
      },
    ])
  const attachElement = (item, mentionKey = null) =>
    addAttachments([
      async () => {
        const files = captureFor(item.pageId, item.viewport)
        if (!files) throw new Error('That page has no capture yet.')
        const image = await cropCapture(fileUrl(boardId, 'captures', files.file, imageVersion), {
          name: `comment-${item.id}.${item.viewport}.png`,
          point: { x: item.x, y: item.y },
          source: { kind: 'element', pageId: item.pageId, viewport: item.viewport, commentId: item.id },
        })
        return mentionKey ? { ...image, mentionKey } : image
      },
    ])
  // An "@" pick: a chip, and for a page or an element its screenshot too
  // (the same path as the attach menu) when the model takes images.
  const addMention = (item) => {
    if (mentions.length >= MENTIONS_MAX) {
      setNotice({ tone: 'warn', text: `Mention at most ${MENTIONS_MAX} things in a message.` })
      return
    }
    if (mentions.some((entry) => entry.key === item.key)) return
    setMentions((current) => [...current, item])
    if (!vision || attachments.length >= ATTACH_MAX) return
    if (item.kind === 'page') {
      const page = pages.find((entry) => entry.id === item.id)
      const view = page && (captureFor(page.id, viewport) ? viewport : page.viewports?.find((name) => captureFor(page.id, name)))
      if (view) attachPage(page, view, item.key)
    } else if (item.kind === 'element') {
      const target = comments.find((entry) => entry.id === item.id)
      if (target && captureFor(target.pageId, target.viewport)) attachElement(target, item.key)
    }
  }
  const removeMention = (item) => {
    setMentions((current) => current.filter((entry) => entry.key !== item.key))
    setAttachments((current) => current.filter((entry) => entry.mentionKey !== item.key))
  }

  // One turn: send, stream, finish (useChatTurn.js).
  const submit = useChatTurn({
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
  })

  const submitRef = useRef(null)
  submitRef.current = submit
  const startedFix = useRef(null)
  useEffect(() => {
    if (!fixRequest || fixRequest.commentId !== commentId || !configured || startedFix.current === fixRequest.nonce) return
    const nonce = fixRequest.nonce
    startedFix.current = nonce
    // Not sent (a turn still running, dictation on): try again when that ends.
    submitRef.current('', true).then((started) => {
      if (!started && startedFix.current === nonce) startedFix.current = null
    })
  }, [fixRequest, commentId, configured, running, dictation.listening])

  // The composer's send: while a turn runs (or a message is still going
  // out), the message waits in the queue instead.
  const send = (textValue = draft, fix = false) => {
    // "/word" on its own is a command: a known one runs, an unknown one says
    // so instead of going to the agent; "//" sends text that starts with "/".
    const slash = fix ? null : slashInput(textValue, commands)
    if (slash?.command) {
      setDraft('')
      setNotice(null)
      runCommand(slash.command)
      return
    }
    if (slash?.unknown) {
      setNotice({
        tone: 'info',
        text: `Unknown command ${slash.unknown}. Type / to see the commands, or start with // to send text that begins with /.`,
      })
      return
    }
    if (slash?.text) textValue = slash.text
    const item = { text: String(textValue ?? '').trim(), fix, attachments, mentions, files }
    const empty = !fix && !item.text && !item.attachments.length && !item.mentions.length && !item.files.length
    if (empty || dictation.listening) return
    // A turn another tab started in this thread: the server takes one at a time.
    if (run || isSending(boardId) || remoteRunning) {
      if (selectingProfile) return
      const id = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      setQueue((current) => [...current, { id, threadId, ...item }])
      setDraft('')
      setAttachments([])
      setMentions([])
      setFiles([])
      setHelp(false)
      return
    }
    submit(item.text, fix)
  }
  // Edit: the queued message back in the box (whatever is there stays, after it).
  const editQueued = (item) => {
    setQueue((current) => current.filter((entry) => entry.id !== item.id))
    setDraft((current) => [item.text, current.trim()].filter(Boolean).join('\n\n'))
    setMentions((current) => mergeBy(item.mentions, current, 'key').slice(0, MENTIONS_MAX))
    setFiles((current) => [...item.files, ...current].slice(0, TEXT_FILES_MAX))
    setAttachments((current) => [...item.attachments, ...current].slice(0, ATTACH_MAX))
  }
  // The next queued message of the thread on screen goes once nothing runs.
  const [flushTick, setFlushTick] = useState(0)
  useEffect(() => {
    if (running || isSending(boardId) || dictation.listening || !configured) return
    const next = queue.find((entry) => entry.threadId === threadId)
    if (!next) return
    setQueue((current) => current.filter((entry) => entry.id !== next.id))
    submitRef.current(next.text, next.fix, { queued: next }).then((started) => {
      // Not sent after all (a race with another send): back to the front.
      if (!started) setQueue((current) => [next, ...current])
      setFlushTick((value) => value + 1)
    })
  }, [boardId, queue, running, setQueue, threadId, configured, dictation.listening, flushTick])

  // "Allow for this chat": a rule per thread for the exact same request (useAutoAllow.js).
  const ownerWrites = Boolean(agent?.ownerWrites)
  const { allowRules, setAllowRules, allowForChat, revokeRule } = useAutoAllow({ boardId, run, threadId, threadRef, ownerWrites })

  // The thread's model and effort (a running ACP session's own choices).
  const chooseOption = async (configId, value) => {
    try {
      const result = await api.post(`/api/agent/boards/${encodeURIComponent(boardId)}/threads/${encodeURIComponent(threadId)}/options`, {
        configId,
        value,
      })
      thread.setData((current) => (current?.id === threadId ? { ...current, options: result.options } : current))
    } catch (error) {
      setNotice({ tone: 'bad', text: error.message })
      thread.refetch()
    }
  }

  // "/" commands. /fix and /review send (or queue) a prompt; the others act here.
  const runCommand = async (id) => {
    if (id === 'help') return setHelp(true)
    if (id === 'fix' || id === 'review') {
      const prompt = commandPrompt(id, { comment, mentions, fixWithAgent: Boolean(agent?.fixWithAgent) })
      return send(prompt.text, Boolean(prompt.fix))
    }
    if (id === 'checks') {
      if (!onRunChecks) return
      const started = await onRunChecks()
      if (started === false) setNotice({ tone: 'bad', text: 'Page checks did not start. See Checks for why.' })
      return
    }
    if (id === 'recapture') {
      if (!onRecapture) return
      onRecapture(comment?.pageId || focusedPage?.id || null)
      return
    }
    if (id === 'new' || id === 'clear') {
      if (running) return setNotice({ tone: 'warn', text: 'Stop the answer first.' })
      if (id === 'new') return newChat()
      return clear()
    }
  }

  // The turn in flight may belong to another thread than the one on screen.
  const stop = async () => {
    try {
      await stopThread(boardId, run?.threadId || threadId)
    } catch {
      abortOf(boardId)?.abort()
    }
  }

  const answer = async (permissionId, optionId, target = threadId) => {
    try {
      await answerPermission(boardId, target, permissionId, optionId)
      if (!running && target === threadRef.current) thread.refetch()
    } catch (error) {
      if (ownerOnlyError(error)) setNotice({ tone: 'info', text: OWNER_ONLY })
      else setNotice({ tone: 'bad', text: error.message })
    }
  }

  const clear = async () => {
    try {
      await api.delete(threadPath(boardId, threadId).replace(/^api\//, '/api/'))
      speaker.stop()
      // A cleared thread starts over: no "Allow for this chat" rules either.
      setAllowRules((current) => ({ ...current, [threadId]: [] }))
      thread.setData({ id: threadId, messages: [] })
      threads.refetch()
    } catch (error) {
      setNotice({ tone: 'bad', text: error.message })
    }
  }

  // ---- Chat history (history.jsx) ----
  const [historyOpen, setHistoryOpen] = useState(false)
  const closeHistory = useCallback(() => {
    setHistoryOpen(false)
    // Back to the button that opened it (the drawer unmounts with the focus in it).
    requestAnimationFrame(() => document.querySelector('[data-sw-chat-history-open]')?.focus())
  }, [])
  useEffect(() => setHistoryOpen(false), [threadId])
  // A fresh board conversation: the agent starts without this chat's context
  // (its own thread, so its own agent session). An empty New chat is reused.
  const newChat = () => {
    setHistoryOpen(false)
    if (isChatThread(threadId) && !messages.length && !run) {
      requestAnimationFrame(() => document.querySelector('[data-sw-chat-input]')?.focus())
      return
    }
    onThread(newChatId())
  }
  const threadTitle = useMemo(() => {
    if (selectedThread?.title) return selectedThread.title
    if (commentId) return comment ? excerpt(comment.body, 48) : 'Comment chat'
    return fallbackTitle(threadId)
  }, [comment, commentId, selectedThread, threadId])
  const removedThread = (id) => {
    if (id !== threadId) return
    speaker.stop()
    if (threadKind(id) === 'chat') onThread(newChatId())
    else thread.setData({ id: threadId, messages: [] })
  }
  const exportCurrent = async (how) => {
    try {
      const text = await exportThread({ boardId, threadId, title: threadTitle, comment, how, messages, refIndex })
      setNotice({ tone: 'info', text })
    } catch (error) {
      setNotice({ tone: 'bad', text: error.message || 'Could not export this chat.' })
    }
  }
  const chooseVersion = async (versionId) => {
    if (!versionId || running) return
    try {
      await restoreVersion(boardId, threadId, versionId)
      speaker.stop()
      await thread.refetch()
      threads.refetch()
    } catch (error) {
      setNotice({ tone: 'bad', text: error.message })
    }
  }
  const editMessage = (message, text) => submit(text, false, { editOf: message.id })

  const viewport = focused?.viewport || defaultViewport
  const pageItems = pages.filter((page) => captureFor(page.id, viewport)).slice(0, PAGE_ITEMS_MAX)
  const focusedPage = focused ? pages.find((page) => page.id === focused.pageId) : null
  const vision = agent?.vision !== false
  const needsOwner = Boolean(defaultAgent?.chatNeedsOwner || agent?.chatNeedsOwner || ownerRefused)
  // The turn in flight, until the refetched thread has it (by id, no doubles).
  // Only in its own thread: a comment's Ask agent can switch threads mid-turn.
  const liveRun = run?.threadId === threadId ? run : null
  // An edit in flight: the edited message and what came after it are replaced.
  // A regenerated answer gives its place to the one being written.
  const editCut = liveRun?.editOf ? messages.findIndex((message) => message.id === liveRun.editOf) : -1
  const before = (editCut >= 0 ? messages.slice(0, editCut) : messages).filter((message) => message.id !== liveRun?.replaces)
  const stored = new Set(before.map((message) => message.id))
  const shown = liveRun ? [...before, ...[liveRun.user, liveRun.final].filter((message) => message && !stored.has(message.id))] : messages
  const waitingForPerson = Boolean(
    liveRun?.reply?.cards?.some((card) => card.kind === 'permission' && card.state === 'pending') ||
    messages.at(-1)?.cards?.some((card) => card.kind === 'permission' && card.state === 'pending' && card.answerable === true),
  )
  const agentState = waitingForPerson ? 'waiting' : run || starterBusy || remoteRunning ? 'working' : 'ready'
  // The agent picker on the chip (AgentPicker.jsx): for the owner, when there
  // is a choice or a way to connect another. A switch starts a fresh agent
  // session and keeps the transcript, said once after it.
  const profileChoice = pickerProfiles(selectedThread)
  const agentSettingsHref = agent?.settingsUrl || (onOpenSettings ? '/console?section=agents' : null)
  const picker =
    agent?.ownerWrites && selectedThread && profileChoice.options.length && (profileChoice.show || onOpenSettings || agent?.settingsUrl)
      ? {
          options: profileChoice.known
            ? profileChoice.options
            : [{ id: profileChoice.value, label: 'Removed agent', configured: false, state: 'unavailable' }, ...profileChoice.options],
          value: profileChoice.value,
          onChoose: async (picked) => {
            const next = choice(selectedThread, picked)
            if (!next || running) return
            const label = profileChoice.options.find((option) => option.id === next)?.label || 'the agent'
            if (await chooseProfile(next)) setNotice({ tone: 'info', text: switchedNote(label) })
          },
          onConnect: onOpenSettings,
          settingsHref: agentSettingsHref,
          disabledReason: running ? 'Wait for the answer or stop it to switch' : null,
        }
      : null
  const showStarters = !running && !dictation.listening && !draft.trim() && !attachments.length && !sentIn.has(threadId) && !thread.loading
  // After an answer: the agent's suggested next steps (or a few that fit),
  // while the box is empty.
  const composing = Boolean(draft.trim() || attachments.length || mentions.length || files.length)
  const lastShown = shown.at(-1)
  const followUps =
    !showStarters && !running && !dictation.listening && !composing && !liveRun
      ? followUpsFor({ message: lastShown, comment, comments, fixWithAgent: Boolean(agent?.fixWithAgent) })
      : []
  const candidates = useMemo(() => mentionCandidates({ pages, comments, journeys, people }), [pages, comments, journeys, people])
  const commands = availableCommands({
    comment,
    ownerWrites,
    fixWithAgent: Boolean(agent?.fixWithAgent),
    checks: Boolean(onRunChecks),
    recapture: Boolean(onRecapture),
    clear: messages.length > 0,
    newChat: true,
  })
  // Usage of the turn in flight, else of the last answer that reported it.
  const usage = liveRun?.reply?.usage || messages.findLast((message) => message.role === 'assistant' && message.usage)?.usage || null
  const sessionOptions = selectedThread?.options || null
  const threadQueue = queue.filter((entry) => entry.threadId === threadId)

  // Put the request of a failed or stopped turn back in the composer, to review.
  const retry = (request) => {
    if (!request || running || draft.trim() || attachments.length) return
    setDraft(request.text || '')
    setNotice({
      tone: 'info',
      text: request.attachments?.length
        ? 'Review the request and reattach any images before sending again. The previous attempt may have made changes.'
        : 'Review before sending again. The previous attempt may have made changes; retrying can repeat them.',
    })
  }
  // The agent could not start (not logged in, not set up): switch this chat to
  // another connected agent and send the same request again.
  const otherAgent = otherProfile(selectedThread)
  const tryOther = async (message, request) => {
    if (!otherAgent || running || !request) return
    if (!(await chooseProfile(otherAgent.id))) return
    if (request.text === FIX_PROMPT) await submit('', true)
    else await submit('', false, { regenerate: { message, request } })
  }
  const readAloudProps = useMemo(() => ({ voiceUri, settings: readAloud }), [voiceUri, readAloud])

  // Board references in answers: what they can link to and where a chip goes.
  const refIndex = useMemo(
    () => buildRefIndex({ comments, pages, journeys, checks: checksCounts }),
    [comments, pages, journeys, checksCounts],
  )
  const refs = useMemo(
    () => ({
      index: refIndex,
      onNavigate,
      touch,
      thumbFor: (pageId) => {
        const shots = captures?.[pageId] || {}
        const image = shots[viewport] || Object.values(shots)[0]
        const file = image?.thumb || image?.file
        return file ? fileUrl(boardId, 'captures', file, imageVersion) : null
      },
    }),
    [refIndex, onNavigate, touch, captures, viewport, boardId, imageVersion],
  )
  // Undo a turn's change (RunSummary): the server checks and does it; the
  // stored answer comes back marked undone.
  const undo = async (messageId) => {
    const result = await undoTurn(boardId, threadId, messageId)
    if (result?.message && threadRef.current === threadId) {
      thread.setData((current) =>
        current ? { ...current, messages: current.messages.map((item) => (item.id === messageId ? result.message : item)) } : current,
      )
      // Only the latest change offers Undo: the one before it may offer it now.
      thread.refetch()
    }
    // The comment may need a person again (no longer "Agent done").
    onBoardChanged?.()
  }

  return (
    <section
      className="relative flex h-full min-h-0 flex-col"
      aria-label="Agent chat"
      data-sw-chat={threadId}
      onDragOver={(event) => {
        if (!configured || ![...event.dataTransfer.types].includes('Files')) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false)
      }}
      onDrop={(event) => {
        setDragging(false)
        if (!configured) return
        event.preventDefault()
        addFiles(event.dataTransfer.files)
      }}
    >
      {heading || configured || onClose ? (
        <ChatHeader
          heading={heading}
          configured={configured}
          agent={agent}
          agentState={agentState}
          picker={picker}
          voiceUri={voiceUri}
          onVoice={(uri) => {
            setVoiceUri(uri)
            saveVoice(uri)
          }}
          readAloud={readAloud}
          onReadAloud={(next) => {
            speaker.stop()
            setReadAloud(saveReadAloud(next))
          }}
          onClear={clear}
          canClear={!running && messages.length > 0}
          onOpenSettings={onOpenSettings}
          settingsHint={settingsHint}
          onClose={onClose}
          threadId={threadId}
          threadTitle={threadTitle}
          threadBadge={commentId ? `#${commentId}` : null}
          onOpenHistory={() => setHistoryOpen(true)}
          onNewChat={running ? null : newChat}
          onExport={exportCurrent}
          touch={touch}
          settingsExtra={<AutoAllowSettings rules={allowRules[threadId]} onRevoke={revokeRule} touch={touch} />}
        />
      ) : null}
      {configured ? (
        <ChatHistory
          open={historyOpen}
          onClose={closeHistory}
          touch={touch}
          boardId={boardId}
          threads={threads.data?.threads || null}
          loading={threads.loading}
          currentId={threadId}
          comments={comments}
          refIndex={refIndex}
          onSelect={(id) => {
            setHistoryOpen(false)
            if (id !== threadId && !running) onThread(id)
          }}
          onNew={newChat}
          onChanged={() => Promise.all([threads.refetch(), thread.refetch()])}
          onRemoved={removedThread}
        />
      ) : null}

      {!configured ? (
        <ConnectAgent
          agent={agent}
          touch={touch}
          onOpenSettings={onOpenSettings}
          settingsHint={settingsHint}
          onConnected={(result) => {
            setConnected(result)
            onAgentChanged?.()
          }}
        />
      ) : (
        <>
          <NaturalDownloadStrip touch={touch} />
          {/* Above the thread, which may already hold messages from an agent connected before. */}
          {connected ? (
            <div className="shrink-0 px-3 pt-3">
              <ConnectedNote result={connected} onDismiss={() => setConnected(null)} touch={touch} />
            </div>
          ) : null}
          <AllowForChat.Provider value={allowForChat}>
            <RefsContext.Provider value={refs}>
              <MessageList
                listRef={listRef}
                scroll={scroll}
                onContinue={() => submit(CONTINUE_PROMPT)}
                comment={comment}
                loading={thread.loading}
                messages={messages}
                shown={shown}
                liveRun={liveRun}
                remoteRunning={remoteRunning}
                boardId={boardId}
                pages={pages}
                agent={agent}
                speaker={speaker}
                readAloud={readAloudProps}
                touch={touch}
                onAnswer={answer}
                onRead={readMessage}
                onRetry={retry}
                retryDisabled={running || Boolean(draft.trim() || attachments.length)}
                owner={Boolean(agent?.ownerWrites)}
                onUndo={running ? null : undo}
                onRecapture={onRecapture}
                versions={selectedThread?.versions || null}
                onEdit={editMessage}
                onVersion={chooseVersion}
                editDisabled={running || dictation.listening}
                ratings={answerRatings.ratings}
                onRate={answerRatings.rate}
                onRegenerate={(message, request) => submit('', false, { regenerate: { message, request } })}
                regenerateDisabled={running || dictation.listening}
                otherAgent={agent?.ownerWrites && otherAgent ? otherAgent : null}
                onTryOther={tryOther}
              />
            </RefsContext.Provider>
          </AllowForChat.Provider>
          {needsOwner ? (
            <div className="shrink-0 p-3" data-sw-chat-needs-owner="true">
              <p
                className="flex items-start gap-2 rounded-lg border border-line bg-surface-2/60 px-3 py-2.5 text-ui text-muted"
                role="note"
              >
                <Lock size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{OWNER_ONLY}</span>
              </p>
              {notice && notice.text !== OWNER_ONLY ? (
                <p
                  className={cn('mt-2 text-xs', notice.tone === 'bad' ? 'text-bad' : 'text-muted')}
                  role={notice.tone === 'bad' ? 'alert' : 'status'}
                >
                  {notice.text}
                </p>
              ) : null}
            </div>
          ) : (
            <Composer
              touch={touch}
              notice={notice}
              dictation={dictation}
              showStarters={showStarters}
              followUps={followUps}
              comment={comment}
              draft={draft}
              onDraft={setDraft}
              attachments={attachments}
              onRemoveAttachment={(id) => setAttachments((current) => current.filter((entry) => entry.id !== id))}
              mentions={mentions}
              candidates={candidates}
              onMention={addMention}
              onRemoveMention={removeMention}
              commands={commands}
              onCommand={runCommand}
              files={files}
              onRemoveFile={(item) => setFiles((current) => current.filter((entry) => entry.id !== item.id))}
              queue={threadQueue}
              onEditQueued={editQueued}
              onRemoveQueued={(item) => setQueue((current) => current.filter((entry) => entry.id !== item.id))}
              help={help}
              onCloseHelp={() => setHelp(false)}
              usage={usage}
              options={sessionOptions}
              onChooseOption={chooseOption}
              onSubmit={send}
              onStop={stop}
              onMic={() => {
                if (dictation.listening) dictation.stop()
                else {
                  speaker.stop()
                  dictationBase.current = draft
                  dictation.start()
                }
              }}
              addFiles={addFiles}
              vision={vision}
              running={running}
              turnRunning={Boolean(run) || remoteRunning}
              selectingProfile={selectingProfile}
              captureFor={captureFor}
              attachElement={attachElement}
              attachPage={attachPage}
              focused={focused}
              focusedPage={focusedPage}
              pageItems={pageItems}
              viewport={viewport}
            />
          )}
          {dragging ? (
            <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10 text-sm font-medium text-fg">
              {vision ? 'Drop images or text files to attach' : 'Drop text files to attach'}
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
