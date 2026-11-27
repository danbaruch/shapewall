// Comparing a board's environments (src/hosted/board-routes.js), for every
// board router. Not on hosted boards yet: a push keeps one environment.
import { fail } from './http.js'

export function mountCompareRoutes(router) {
  router.get('/boards/:bid/compare', (req, res) => fail(res, 404, 'not_found', 'Compare is not on hosted boards yet.'))
}
