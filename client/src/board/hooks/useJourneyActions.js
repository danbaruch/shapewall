import { useCallback, useEffect, useRef } from 'react'
import { api } from '../../lib/api'
import { clampStep } from '../flow'
import { chooseBranch, journeyPages } from '../../../../src/journey-paths.js'
import { useJourneyKeys } from './useShortcuts'
import { motionDuration } from '../../lib/motion'

// Opening, stepping through and leaving a journey (each step flies to its
// card), and building, saving or deleting one.
export function useJourneyActions({
  boardId,
  view,
  updateParams,
  clearFocus,
  setCommentMode,
  journey,
  route,
  routePages,
  step,
  builder,
  setBuilder,
  busy,
  setBusy,
  setNotice,
  flow,
  targets,
  nodesReady,
  mode,
  comparePair,
  setSettledZoom,
}) {
  const openJourney = useCallback(
    (id) => {
      clearFocus()
      updateParams({ j: id || null, step: id ? 1 : null, jc: null, jb: null })
    },
    [clearFocus, updateParams],
  )
  const closeJourney = useCallback(() => updateParams({ j: null, step: null, jc: null, jb: null }), [updateParams])
  const goStep = useCallback(
    (value) => {
      if (routePages) updateParams({ step: clampStep(value, routePages.length) })
    },
    [routePages, updateParams],
  )
  // Picking a branch at a fork keeps the choices before it; later forks
  // start again from their first branch.
  const chooseJourneyBranch = useCallback(
    (ordinal, branchId) => {
      if (route) updateParams({ jb: chooseBranch(route, ordinal, branchId).join(',') })
    },
    [route, updateParams],
  )
  // Each step change flies to its card (not on every poll of the board).
  const zoomedStep = useRef(null)
  useEffect(() => {
    if (!journey || !nodesReady || builder) {
      if (!journey) zoomedStep.current = null
      return
    }
    const pageId = routePages[step - 1]
    const key = `${journey.id}:${step}:${pageId}:${mode}:${comparePair}`
    if (zoomedStep.current === key) return
    const target = targets[pageId]
    if (!target) return
    zoomedStep.current = key
    setSettledZoom(null)
    // Room above the card for its step badges.
    flow.fitBounds(
      { x: target.x, y: target.y - 48, width: target.w, height: target.h + 48 },
      { padding: 0.18, duration: motionDuration(450) },
    )
  }, [builder, comparePair, flow, journey, targets, mode, nodesReady, routePages, setSettledZoom, step])
  useJourneyKeys({ journey, builder, goStep, step, closeJourney })

  const startBuilder = useCallback(
    (from = null) => {
      setCommentMode(false)
      clearFocus()
      setBuilder(
        from
          ? { id: from.id, name: from.name, steps: structuredClone(from.steps), into: null }
          : { id: null, name: '', steps: [], into: null },
      )
    },
    [clearFocus, setBuilder, setCommentMode],
  )
  // A click adds the page as the next step: of the branch being filled
  // (`into`: { fork, branch } indexes), else of the main line.
  const addBuilderStep = useCallback(
    (pageId) => {
      setBuilder((current) => {
        if (!current || journeyPages(current.steps).length >= 50) return current
        const steps = structuredClone(current.steps)
        const fork = current.into ? steps[current.into.fork] : null
        const list = fork?.branches?.[current.into.branch]?.steps || steps
        if (list[list.length - 1] === pageId) return current
        list.push(pageId)
        return { ...current, steps }
      })
    },
    [setBuilder],
  )
  const journeysUrl = `/api/boards/${encodeURIComponent(boardId)}/journeys`
  const saveBuilder = async () => {
    if (!builder || busy) return
    setBusy(true)
    try {
      const body = { name: builder.name, steps: builder.steps }
      // (`into` is the builder's cursor, not part of the journey.)
      const result = builder.id
        ? await api.patch(`${journeysUrl}/${encodeURIComponent(builder.id)}`, body)
        : await api.post(journeysUrl, body)
      await view.refetch()
      setBuilder(null)
      zoomedStep.current = null
      openJourney(result.journey.id)
    } catch (error) {
      setNotice({ tone: 'bad', text: error.message || 'The journey was not saved.' })
    } finally {
      setBusy(false)
    }
  }
  const removeJourney = async () => {
    if (!journey || busy) return
    setBusy(true)
    try {
      await api.delete(`${journeysUrl}/${encodeURIComponent(journey.id)}`)
      closeJourney()
      view.refetch()
    } catch (error) {
      setNotice({ tone: 'bad', text: error.message || 'The journey was not deleted.' })
    } finally {
      setBusy(false)
    }
  }
  return { openJourney, closeJourney, goStep, chooseJourneyBranch, startBuilder, addBuilderStep, saveBuilder, removeJourney }
}
