import { useMemo } from 'react'
import { clampStep } from '../flow'
import { journeyGraph, resolvePath } from '../../../../src/journey-paths.js'

// The open journey from the URL (`j`, `step`, `jb`, `jc`): its route through
// the forks, the pages along it and the current step. None while building one.
export function useJourneyState({ params, data, builder }) {
  const journeys = useMemo(() => (Array.isArray(data?.journeys) ? data.journeys : []), [data?.journeys])
  const journey = builder ? null : journeys.find((item) => item.id === params.get('j')) || null
  // The branch taken at each fork reached (`jb=link-expired,card-ok`); a fork
  // without a choice takes its first branch.
  const branchParam = params.get('jb') || ''
  const route = useMemo(() => (journey ? resolvePath(journey.steps, branchParam.split(',').filter(Boolean)) : null), [journey, branchParam])
  const routeGraph = useMemo(() => (journey ? journeyGraph(journey.steps) : null), [journey])
  const routePages = useMemo(() => (route ? route.steps.map((item) => item.pageId) : null), [route])
  const step = clampStep(params.get('step'), routePages?.length || 0)
  const journeyComments = Boolean(journey) && params.get('jc') === '1'
  return { journeys, journey, route, routeGraph, routePages, step, journeyComments }
}
