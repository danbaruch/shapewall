// A board's check reports (src/hosted/board-routes.js): the members' board
// API and, when the link includes checks, a share link's guests. Never on a
// public project's routes. Hosted boards only read the reports a push
// brought; they never run checks.
import { checksView, readReport } from '../checks/store.js'
import { fail } from './http.js'

export function mountCheckRoutes(router, { handle, boardContext, guest = false }) {
  router.get(
    '/boards/:bid/checks',
    handle((req, res) => {
      if (guest && !req.guest.includeChecks) return fail(res, 404, 'not_found', 'Check report not found.')
      const ctx = boardContext(req.t, req.project, req.params.bid)
      const requested = typeof req.query.env === 'string' ? req.query.env : null
      if (requested && !(ctx.config.checksEnvironments || ctx.board.environments).some((env) => env.id === requested))
        return fail(res, 404, 'not_found', 'No checks for this environment.')
      res.json(checksView(ctx.config, ctx.board.id, requested, { imported: true }))
    }),
  )
  router.get(
    '/boards/:bid/checks/:id',
    handle((req, res) => {
      if (guest && !req.guest.includeChecks) return fail(res, 404, 'not_found', 'Check report not found.')
      const ctx = boardContext(req.t, req.project, req.params.bid)
      const report = readReport(ctx.config, ctx.board.id, req.params.id)
      if (!report) return fail(res, 404, 'not_found', 'Check report not found.')
      res.json({ report })
    }),
  )
}
