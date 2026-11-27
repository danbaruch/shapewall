// A board's check reports (src/hosted/board-routes.js): the members' board
// API and, when the link includes checks, a share link's guests. Never on a
// public project's routes. Hosted boards only read the reports a push
// brought; they never run checks.
import { checksView, readReport } from '../checks/store.js'
import { HttpError, fail } from './http.js'

// The environment a request asks for (?env=), or null for the board's own.
function environmentOf(req, ctx) {
  const requested = typeof req.query.env === 'string' ? req.query.env : null
  if (requested && !(ctx.config.checksEnvironments || ctx.board.environments).some((env) => env.id === requested))
    throw new HttpError(404, 'not_found', 'No checks for this environment.')
  return requested
}

export function mountCheckRoutes(router, { handle, boardContext, guest = false }) {
  router.get(
    '/boards/:bid/checks',
    handle((req, res) => {
      if (guest && !req.guest.includeChecks) return fail(res, 404, 'not_found', 'Check report not found.')
      const ctx = boardContext(req.t, req.project, req.params.bid)
      res.json(checksView(ctx.config, ctx.board.id, environmentOf(req, ctx), { imported: true }))
    }),
  )
  // The SEO tab's search previews: they hold page text and URLs, so they stay
  // on the installation that ran the checks and a push never brings them
  // (src/checks/seo-snapshot.js). A hosted board answers with none, in the
  // local route's shape (src/checks/routes.js), so the tab shows the pushed
  // reports' issues instead of a 404 on every board load with checks open.
  router.get(
    '/boards/:bid/checks/seo',
    handle((req, res) => {
      if (guest && !req.guest.includeChecks) return fail(res, 404, 'not_found', 'Check report not found.')
      const ctx = boardContext(req.t, req.project, req.params.bid)
      const view = checksView(ctx.config, ctx.board.id, environmentOf(req, ctx), { imported: true })
      res.json({ schemaVersion: 1, environment: view.environment, privatePages: [], snapshots: {} })
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
