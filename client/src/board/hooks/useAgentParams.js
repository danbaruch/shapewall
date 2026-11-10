import { useCallback, useEffect } from 'react'
import { STATIC } from '../../lib/api'
import { DEMO } from '../../lib/demo'
import { chatParamFor, lastChatParam, rememberChatParam, threadForChatParam } from '../../chat/threads'

// The agent chat and the settings dialogs: whether this board offers them,
// and which one the URL opens (`chat`, `settings`).
export function useAgentParams({ boardId, info, params, updateParams }) {
  // Chat: on a live board whose server offers it (not static exports, not
  // read-only boards). `chat=board`, `chat=c<comment id>` or `chat=chat-<id>` (a New chat) picks the thread.
  const chatAvailable = !STATIC && Boolean(info?.agent) && !(info?.remote?.noRemoteChat && info?.remote?.kind !== 'host')
  const chatParam = params.get('chat') || ''
  const chatThread = !chatAvailable ? null : threadForChatParam(chatParam)
  // Settings > Agent: only for a browser on the machine that serves the board
  // (the server says so in info.agent.settingsEditable). `settings=agent`.
  const settingsAvailable = Boolean(info?.agent?.settingsEditable || info?.agent?.settingsReadonly)
  const localSettingsAvailable = !STATIC && !DEMO && !info?.consoleUrl && !info?.workspace && !info?.hosted && !info?.guest
  const generalSettingsOpen = localSettingsAvailable && params.get('settings') === 'general'
  const settingsOpen = settingsAvailable && params.get('settings') === 'agent'
  const openSettings = useCallback(() => updateParams({ settings: 'agent' }), [updateParams])
  // Reopening the chat (the Agent toggle, the phone menu, the palette) goes
  // back to the thread that was open last on this board, not always Board chat.
  useEffect(() => {
    if (chatThread) rememberChatParam(boardId, chatParamFor(chatThread))
  }, [boardId, chatThread])
  const reopenChat = useCallback(() => updateParams({ chat: lastChatParam(boardId), checks: null, cv: null }), [boardId, updateParams])
  const openChat = useCallback(
    (threadId) => {
      updateParams({ chat: chatParamFor(threadId), checks: null, cv: null })
    },
    [updateParams],
  )
  return {
    chatAvailable,
    chatThread,
    reopenChat,
    settingsAvailable,
    localSettingsAvailable,
    generalSettingsOpen,
    settingsOpen,
    openSettings,
    openChat,
  }
}
