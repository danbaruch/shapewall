// Which answer may offer Undo (routes.js, and the demo backend by the same
// rules): only the latest change in the thread, the newest answer whose turn
// changed something and was not undone yet. An older one (a later answer
// changed things after it) offers none, so changes come off newest first.
// Earlier versions are never the latest: Regenerate keeps them inside the
// answer (`versions`), an edit in the thread's branches.

export const LATER_CHANGE = 'a later answer changed things after this one'

export const latestChange = (messages) =>
  messages.findLast((item) => item.role === 'assistant' && item.summary && !item.summary.undone)?.id ?? null

// `messages` with each summary's `undo.available` settled: `canUndo(message)`
// says whether this process can still undo it (an undo record, a branch).
// `all`: the whole thread, when `messages` is only part of it.
export function withUndoAvailability(messages, canUndo, all = messages) {
  const latest = latestChange(all)
  return messages.map((message) => {
    const undo = message.summary?.undo
    if (!undo) return message
    const possible = !message.summary.undone && canUndo(message)
    const available = message.id === latest && possible
    const reason = possible && message.id !== latest ? LATER_CHANGE : undo.reason
    return { ...message, summary: { ...message.summary, undo: { ...undo, available, ...(reason ? { reason } : {}) } } }
  })
}
