import { useMemo } from 'react'

// Stepping through threads from the open one. The list is the visible one,
// with the open thread in it even when the filter hides it.
export function useThreadNav({ selectedComment, visibleComments, focusComment, mode, viewports, modes }) {
  // The list (with the open thread, when the filter hides it): the thread's
  // arrows step through it.
  const threadList = useMemo(
    () =>
      selectedComment && !visibleComments.some((comment) => comment.id === selectedComment.id)
        ? [selectedComment, ...visibleComments]
        : visibleComments,
    [selectedComment, visibleComments],
  )
  const threadIndex = selectedComment ? threadList.findIndex((comment) => comment.id === selectedComment.id) : -1
  const stepThread = (delta) => {
    if (threadList.length < 2 || threadIndex < 0) return
    focusComment(threadList[(threadIndex + delta + threadList.length) % threadList.length])
  }
  // "switches to Phone" when the previous or next thread is on another viewport.
  const neighborNote = (delta) => {
    if (threadList.length < 2 || threadIndex < 0 || mode === 'all') return null
    const other = threadList[(threadIndex + delta + threadList.length) % threadList.length]
    if (other.viewport === mode || !viewports[other.viewport]) return null
    return `switches to ${modes.find((item) => item.id === other.viewport)?.label || other.viewport}`
  }
  return { threadList, threadIndex, stepThread, neighborNote }
}
