// Comparing a board's environments (src/hosted/board-routes.js), for every
// board router: the same routes and answers as a local board's
// (src/server/app.js), on the hosted board folder's shared layout
// (envs/<id>/captures/, diffs/<a>_<b>/, src/store.js).
//
//   GET boards/:bid/envs/:env/:file          another environment's screenshot
//   GET boards/:bid/diffs/:pair/:file        a cached diff mask (<a>_<b>)
//   GET boards/:bid/env-elements/:env/:file  another environment's element map
//   GET boards/:bid/compare?a=&b=            changed share per page and viewport
//
// Only the solo engine keeps more than one environment (src/hosted/push.js
// cleanDefinition): a team server's board has one, `default`, so its compare
// has nothing to compare and answers 404, and its env routes serve nothing
// the captures routes do not.
import { compareEnvironments } from '../diff.js'
import { captureFailures, captureFiles, resolveFile } from '../store.js'
import { sendPng } from './board-context.js'
import { fail } from './http.js'

export function mountCompareRoutes(router, { withBoard }) {
  router.get(
    '/boards/:bid/envs/:env/:file',
    withBoard((req, res, ctx) => {
      const name = req.params.file
      const file = name.endsWith('.png') ? resolveFile(ctx.config, ctx.board.id, `env:${req.params.env}`, name) : null
      if (!file) return fail(res, 404, 'not_found', 'No such image.')
      sendPng(res, file, Boolean(req.query.v))
    }),
  )
  router.get(
    '/boards/:bid/diffs/:pair/:file',
    withBoard((req, res, ctx) => {
      const name = req.params.file
      const file = name.endsWith('.png') ? resolveFile(ctx.config, ctx.board.id, `diff:${req.params.pair}`, name) : null
      if (!file) return fail(res, 404, 'not_found', 'No such image.')
      sendPng(res, file, Boolean(req.query.v))
    }),
  )
  // Another environment's element map, for a comment placed on its side of a compare card.
  router.get(
    '/boards/:bid/env-elements/:env/:file',
    withBoard((req, res, ctx) => {
      const name = req.params.file
      const file = name.endsWith('.elements.json') ? resolveFile(ctx.config, ctx.board.id, `env:${req.params.env}`, name) : null
      if (!file) return fail(res, 404, 'not_found', 'No such element map.')
      res.setHeader('Cache-Control', req.query.v ? 'private, max-age=604800, immutable' : 'private, no-cache')
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      res.type('json').sendFile(file, { dotfiles: 'allow' })
    }),
  )
  // Diffs are computed once per pair of captures and cached (src/diff.js).
  router.get(
    '/boards/:bid/compare',
    withBoard(async (req, res, ctx) => {
      // Pixel diffs are heavy: another site must not start them (an <img>
      // pointed at the board). The board sends same-origin; a typed URL none.
      if (!['same-origin', 'none', undefined].includes(req.headers['sec-fetch-site']))
        return fail(res, 403, 'cross_site', 'Open this from the board itself, not from another site.')
      const board = ctx.board
      const ids = board.environments.map((env) => env.id)
      if (ids.length < 2) return fail(res, 404, 'not_found', 'This board has one environment: there is nothing to compare.')
      const a = String(req.query.a || '')
      const b = String(req.query.b || '')
      if (!ids.includes(a) || !ids.includes(b) || a === b)
        return fail(res, 400, 'invalid_environments', `Pick two different environments of ${ids.join(', ')}.`)
      const result = await compareEnvironments(ctx.config, board, a, b)
      res.json({
        ...result,
        files: {
          [a]: captureFiles(ctx.config, board, a, { current: true }),
          [b]: captureFiles(ctx.config, board, b, { current: true }),
        },
        // Why a frame has no picture: "HTTP 404" says more than "not captured".
        failures: { [a]: captureFailures(ctx.config, board, a), [b]: captureFailures(ctx.config, board, b) },
      })
    }),
  )
}
