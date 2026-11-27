// A board's journeys (src/hosted/board-routes.js), for every board router
// (members, share link guests, public projects). Read only: on a hosted
// board journeys come from the pushed config.
import { listJourneys } from '../journeys.js'
import { fail } from './http.js'

export function mountJourneyRoutes(router, { withBoard }) {
  router.get(
    '/boards/:bid/journeys',
    withBoard((req, res, ctx) => res.json({ journeys: listJourneys(ctx.config, ctx.board) })),
  )
  router.all('/boards/:bid/journeys{/*rest}', (req, res) =>
    fail(res, 403, 'hosted_journeys', 'Journeys come from your config on a hosted board; edit them there and push again.'),
  )
}
