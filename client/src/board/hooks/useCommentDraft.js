import { api } from '../../lib/api'
import { saveAuthor } from '../../lib/utils'

// The new comment being written (`draft`, placed by a click in comment mode):
// saving it, the line that says where it goes, and the composer's props.
export function useCommentDraft({
  draft,
  setDraft,
  busy,
  setBusy,
  commentsUrl,
  applyComment,
  markSeen,
  setLocalName,
  setNotice,
  updateParams,
  wide,
  filter,
  targetTitle,
  people,
  info,
}) {
  const saveDraft = async () => {
    if (!draft?.body.trim() || busy) return
    setBusy(true)
    try {
      const author = (draft.author || '').trim()
      saveAuthor(author)
      const { comment } = await api.post(commentsUrl, {
        pageId: draft.pageId,
        viewport: draft.viewport,
        x: draft.x,
        y: draft.y,
        body: draft.body,
        author,
        ...(draft.anchor ? { anchor: draft.anchor } : {}),
      })
      setDraft(null)
      setLocalName(author)
      applyComment(comment)
      markSeen(comment)
      // Comment mode stays on (like Figma); the new thread opens at its pin on desktop.
      updateParams({ c: wide ? comment.id : null, filter: filter === 'all' ? 'all' : null })
    } catch (error) {
      setNotice({ tone: 'bad', text: error.message || 'The comment was not saved.' })
    } finally {
      setBusy(false)
    }
  }
  const draftDescription = draft
    ? `${targetTitle(draft.pageId)} · ${draft.viewport} · ${draft.anchor ? `on "${draft.anchor.text || draft.anchor.selector.split(' > ').pop()}"` : `${Math.round(draft.x)}% across, ${Math.round(draft.y)}% down`}`
    : ''
  const composerProps = {
    draft,
    onChange: (patch) => setDraft((current) => (current ? { ...current, ...patch } : current)),
    onSubmit: saveDraft,
    onCancel: () => setDraft(null),
    busy,
    people,
    hosted: Boolean(info?.hosted),
    signedInAs: info?.user?.name || null,
  }
  return { draftDescription, composerProps }
}
