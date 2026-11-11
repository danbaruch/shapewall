import { useMemo } from 'react'
import { flowEdges, globalTargets, stepMap } from '../flow'
import { journeyPages, resolvePath } from '../../../../src/journey-paths.js'

// The arrows on the canvas: links between pages (all of them, or those of
// the active page) and the journey being shown or built, plus what the
// cards need to draw the journey (step badges, pages off the path).
export function useArrows({
  targets,
  layoutEdges,
  links,
  showLinks,
  showAllLinks,
  activePage,
  builder,
  route,
  routeGraph,
  routePages,
  step,
  journey,
  targetTitle,
}) {
  const presentPages = useMemo(() => new Set(Object.keys(targets).filter((id) => !id.startsWith('variant:'))), [targets])
  // A branching draft previews its first path.
  const builderPath = useMemo(() => (builder ? resolvePath(builder.steps).steps.map((item) => item.pageId) : null), [builder])
  const shownSteps = builder ? builderPath : routePages
  const hiddenLinkTargets = useMemo(
    () => (showLinks && !showAllLinks ? globalTargets(links, presentPages) : null),
    [links, presentPages, showAllLinks, showLinks],
  )
  const journeyRoute = useMemo(
    () => (builder || !route ? null : { graph: routeGraph, path: route.steps.map((item) => item.key) }),
    [builder, route, routeGraph],
  )
  // Arrows are not tab stops (the cards are); their labels use titles, never ids.
  const edges = useMemo(
    () => [
      ...layoutEdges,
      ...flowEdges({
        links: links || {},
        showLinks,
        activePage,
        journeySteps: builder ? builderPath : null,
        journeyRoute,
        currentStep: builder ? 0 : step,
        present: presentPages,
        hideTargets: hiddenLinkTargets,
      }).map((edge) => ({
        ...edge,
        // The page a journey arrow leads to, for the chip it ends in when that page is off screen.
        ...(edge.id.startsWith('journey:') ? { data: { ...edge.data, toTitle: targetTitle(edge.target) } } : {}),
        ariaLabel: edge.id.startsWith('link:')
          ? `Link from ${targetTitle(edge.source)} to ${targetTitle(edge.target)}`
          : `Journey${edge.data?.label ? ` step ${edge.data.label}` : ''}: ${targetTitle(edge.source)} to ${targetTitle(edge.target)}`,
      })),
    ],
    [activePage, builder, builderPath, links, hiddenLinkTargets, journeyRoute, layoutEdges, presentPages, showLinks, step, targetTitle],
  )
  // Pages only on branches the path does not take stay half visible.
  const offPath = useMemo(() => {
    if (builder || !journey || !routePages) return null
    const taken = new Set(routePages)
    return new Set((journey.pages || journeyPages(journey.steps)).filter((pageId) => !taken.has(pageId)))
  }, [builder, journey, routePages])
  const journeyView = useMemo(
    () =>
      shownSteps
        ? {
            steps: stepMap(shownSteps),
            offPath,
            currentStep: builder ? null : step,
            currentPage: builder ? null : shownSteps[step - 1],
          }
        : null,
    [builder, offPath, shownSteps, step],
  )
  return { presentPages, shownSteps, hiddenLinkTargets, edges, journeyView }
}
