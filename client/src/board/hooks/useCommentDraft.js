import { useEffect } from 'react'
import { api } from '../../lib/api'
import { saveAuthor } from '../../lib/utils'
import { imagesPayload, useImageDraft } from '../commentImages'
import { drawing, drawingPayload } from '../drawing'
import { viewportLabel } from '../viewports'
import { plainLabel, selectorTag } from '../../../../src/capture/element-map.js'

// The new comment being written (`draft`, placed by a click in comment mode):
// saving it, the line that says where it goes, and the composer's props.
// `media`: who may attach images and draw ({ attach, draw, attachNote }),
// and `pageImage(pageId, viewport)` -> { src, native } for the phone's
// drawing sheet.
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
  media = { attach: false, draw: false, attachNote: null },
  pageImage = () => null,
}) {
  const images = useImageDraft({ enabled: media.attach })
  const drawKey = draft ? `${draft.pageId}|${draft.viewport}` : null
  // The composer's drawing lives with the draft: it starts with it, starts
  // over when the draft moves to another frame, and ends with it.
  useEffect(() => {
    if (!drawKey || !media.draw) {
      drawing.end('composer')
      return
    }
    if (drawing.get()?.owner === 'composer') drawing.moveTo(drawKey, 'composer')
    else drawing.start(drawKey, 'composer')
  }, [drawKey, media.draw])
  const { clear: clearImages } = images
  useEffect(() => {
    if (!draft) clearImages()
  }, [draft, clearImages])
  useEffect(() => () => drawing.end('composer'), [])

  const saveDraft = async () => {
    if (!draft || busy || images.reading) return
    const session = drawing.get()
    const shapes = session?.owner === 'composer' && session.key === drawKey ? session.shapes : []
    const attached = imagesPayload(images.images)
    // A drawing or an image can be the whole comment.
    if (!draft.body.trim() && !shapes.length && !attached.length) return
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
        ...(attached.length ? { images: attached } : {}),
        ...(shapes.length ? { drawing: drawingPayload(shapes) } : {}),
      })
      drawing.end('composer')
      setDraft(null)
      setLocalName(author)
      applyComment(comment)
      markSeen(comment)
      // Comment mode stays on (like Figma); the new thread opens at its pin on desktop.
      updateParams({ c: wide ? comment.id : null, filter: filter === 'all' ? 'all' : null })
    } catch (error) {
      // An image the server refused: said under the images, where it belongs.
      if (/image/.test(error.code || '')) images.setError(error.message || 'An image was not accepted.')
      else setNotice({ tone: 'bad', text: error.message || 'The comment was not saved.' })
    } finally {
      setBusy(false)
    }
  }
  // What the comment is attached to, in plain words: the picked element
  // ("Heading: Notes that keep up..."), or the spot on a screenshot.
  const draftTarget = draft
    ? draft.anchor
      ? draft.target || plainLabel(selectorTag(draft.anchor.selector), draft.anchor.text)
      : `a spot on ${targetTitle(draft.pageId)}`
    : ''
  const draftDescription = draft
    ? `${targetTitle(draft.pageId)} · ${viewportLabel(draft.viewport)} · ${draft.anchor ? draftTarget : `${Math.round(draft.x)}% across, ${Math.round(draft.y)}% down`}`
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
    media: {
      ...media,
      images,
      owner: 'composer',
      page: draft && media.draw ? pageImage(draft.pageId, draft.viewport) : null,
      pageTitle: draft ? targetTitle(draft.pageId) : '',
    },
  }
  return { draftDescription, draftTarget, composerProps }
}
