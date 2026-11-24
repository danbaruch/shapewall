import { useMemo } from 'react'
import { narrowComments } from '../flow'
import { journeyPages } from '../../../../src/journey-paths.js'

// The comments to show: narrowed by search, state and mention, then by the
// Open/Resolved filter and the journey; their pins by card; the counts.
export function useCommentLists({ comments, query, stateFilter, mentionFilter, titleOfPage, filter, journey, journeyComments }) {
  const narrowedComments = useMemo(
    () => narrowComments(comments, { query, state: stateFilter, mention: mentionFilter, titleOf: titleOfPage }),
    [comments, mentionFilter, query, stateFilter, titleOfPage],
  )
  const visibleComments = useMemo(() => {
    const inJourney = journeyComments ? new Set(journey.pages || journeyPages(journey.steps)) : null
    return narrowedComments.filter(
      (comment) => (filter === 'all' || comment.status === filter) && (!inJourney || inJourney.has(comment.pageId)),
    )
  }, [narrowedComments, filter, journey, journeyComments])
  const pinsByTarget = useMemo(() => {
    const map = new Map()
    for (const comment of visibleComments) {
      const key = `${comment.pageId}|${comment.viewport}`
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(comment)
    }
    return map
  }, [visibleComments])
  const counts = {
    open: narrowedComments.filter((item) => item.status === 'open').length,
    resolved: narrowedComments.filter((item) => item.status === 'resolved').length,
  }
  return { narrowedComments, visibleComments, pinsByTarget, counts }
}
