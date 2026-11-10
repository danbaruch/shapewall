import { useEffect, useRef } from 'react'
import { api } from '../../lib/api'
import { confirmHostedPasskey } from '../HostedApprovals'

// What can be done to a comment that exists: status, replies, edits,
// reactions, links, GitHub issues, sending to the agent and deleting (with
// Undo). Each puts the server's answer into the comment list at once.
export function useCommentActions({
  boardId,
  commentsQuery,
  view,
  info,
  localName,
  authorName,
  setBusy,
  setNotice,
  setToast,
  setDeletingIds,
  selectedCommentId,
  closeThread,
  wide,
  filter,
  allowed,
}) {
  const pendingDeletes = useRef(new Map())
  // Put the server's answer into the list at once (a poll in flight must not
  // bring an old state back), then refresh counts.
  const applyComment = (comment, removed = false, { counts = true } = {}) => {
    commentsQuery.setData((current) => {
      const list = Array.isArray(current?.comments) ? current.comments : []
      if (removed) return { comments: list.filter((item) => item.id !== comment.id) }
      const exists = list.some((item) => item.id === comment.id)
      return { comments: exists ? list.map((item) => (item.id === comment.id ? comment : item)) : [comment, ...list] }
    })
    if (counts) view.refetch()
  }

  const commentsUrl = `/api/boards/${encodeURIComponent(boardId)}/comments`

  const setStatus = async (comment, action) => {
    setBusy(true)
    try {
      // The name goes with it, so notifications say who resolved or reopened.
      const result = await api.post(`${commentsUrl}/${comment.id}/${action}`, { author: authorName() || undefined })
      applyComment(result.comment)
      // As in Figma, resolving closes the thread at its pin when resolved
      // threads are hidden; the phone sheet stays (it shows Reopen).
      if (wide && action === 'resolve' && filter === 'open') closeThread()
      if (action === 'resolve' && allowed('resolve')) {
        setToast({ at: Date.now(), text: `Resolved comment #${comment.id}.`, undo: () => setStatus(result.comment, 'reopen') })
      }
    } catch (error) {
      setNotice({ tone: 'bad', text: error.message || 'That did not save.' })
    } finally {
      setBusy(false)
    }
  }

  // Returns true when the reply was saved (the box then clears).
  const replyTo = async (comment, body) => {
    setBusy(true)
    try {
      const result = await api.post(`${commentsUrl}/${comment.id}/replies`, { body, author: authorName() || undefined })
      applyComment(result.comment)
      return true
    } catch (error) {
      setNotice({ tone: 'bad', text: error.message || 'That reply did not save.' })
      return false
    } finally {
      setBusy(false)
    }
  }

  // Returns true when the edit was saved.
  const editComment = async (comment, body) => {
    setBusy(true)
    try {
      const result = await api.patch(`${commentsUrl}/${comment.id}`, { body })
      applyComment(result.comment)
      return true
    } catch (error) {
      setNotice({ tone: 'bad', text: error.message || 'That edit did not save.' })
      return false
    } finally {
      setBusy(false)
    }
  }

  // Adds or takes away your emoji reaction (on the comment or a reply).
  const reactTo = async (comment, emoji, replyId = null) => {
    try {
      const result = await api.post(`${commentsUrl}/${comment.id}/reactions`, {
        emoji,
        ...(replyId ? { replyId } : {}),
        ...(info?.hosted ? {} : { author: localName || undefined }),
      })
      applyComment(result.comment, false, { counts: false })
    } catch (error) {
      setNotice({ tone: 'bad', text: error.message || 'That reaction did not save.' })
    }
  }

  // A link that opens this board on the thread.
  const copyLink = async (comment) => {
    const url = new URL(window.location.href)
    url.searchParams.set('c', String(comment.id))
    url.searchParams.delete('v')
    try {
      await navigator.clipboard.writeText(url.href)
      setNotice({ tone: 'info', text: `Copied the link to comment #${comment.id}.` })
    } catch {
      setNotice({ tone: 'info', text: `Link to comment #${comment.id}: ${url.href}` })
    }
  }

  // Opens the GitHub issue for a comment (the server holds the token).
  const githubIssue = async (comment) => {
    setBusy(true)
    try {
      const result = await api.post(`${commentsUrl}/${comment.id}/github/issue`, {})
      applyComment(result.comment)
      setNotice({ tone: 'info', text: `${result.created ? 'Opened' : 'Already has'} GitHub issue #${result.issue.number}.` })
    } catch (error) {
      setNotice({ tone: 'bad', text: error.message || 'The GitHub issue was not created.' })
    } finally {
      setBusy(false)
    }
  }

  // Delete waits a few seconds so Undo can take it back; the comment is
  // hidden at once. Leaving the page sends any waiting delete straight away.
  const forgetDelete = (id) => {
    pendingDeletes.current.delete(id)
    setDeletingIds((current) => {
      if (!current.has(id)) return current
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }
  const commitDelete = async (comment) => {
    const pending = pendingDeletes.current.get(comment.id)
    if (!pending) return
    window.clearTimeout(pending.timer)
    try {
      await api.delete(`${commentsUrl}/${comment.id}`)
      applyComment(comment, true)
    } catch (error) {
      setNotice({ tone: 'bad', text: error.message || 'That did not delete.' })
    } finally {
      forgetDelete(comment.id)
    }
  }
  const commitDeleteRef = useRef(commitDelete)
  commitDeleteRef.current = commitDelete
  useEffect(() => {
    const flush = () => {
      for (const { comment } of [...pendingDeletes.current.values()]) commitDeleteRef.current(comment)
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])
  const removeComment = async (comment) => {
    if (selectedCommentId === comment.id) closeThread()
    setDeletingIds((current) => new Set(current).add(comment.id))
    const timer = window.setTimeout(() => commitDeleteRef.current(comment), 6000)
    pendingDeletes.current.set(comment.id, { comment, timer })
    setToast({
      at: Date.now(),
      text: `Deleted comment #${comment.id}.`,
      undo: () => {
        window.clearTimeout(timer)
        forgetDelete(comment.id)
      },
    })
  }

  // Hosted boards: hand the comment to the agent (an admin approves the run with a passkey).
  // The server takes the comment only as this person saw it: `dispatchHash`
  // is read from the comment on screen at the click, before the passkey
  // prompt, so an edit made meanwhile is never sent unread.
  const sendToAgent = async (comment) => {
    const { dispatchHash } = comment
    const approve = Boolean(comment.needsRunApproval && ['admin', 'owner'].includes(info.role))
    setBusy(true)
    try {
      if (approve) await confirmHostedPasskey()
      const result = await api.post(`${commentsUrl}/${comment.id}/send-to-agent`, { dispatchHash, approve })
      applyComment(result.comment)
    } catch (error) {
      if (error.code === 'comment_changed') {
        // Nothing was sent. Show the comment as it is now.
        commentsQuery.refetch()
        setNotice({ tone: 'bad', text: 'This comment changed while you were approving it. Read it again, then send it.' })
      } else setNotice({ tone: 'bad', text: error.message })
    } finally {
      setBusy(false)
    }
  }
  return { commentsUrl, applyComment, setStatus, replyTo, editComment, reactTo, copyLink, githubIssue, removeComment, sendToAgent }
}
