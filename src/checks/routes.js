import express from 'express'
import { getBoard } from '../config.js'
import { checksView, readReport } from './store.js'
import { latestSeoReports } from './seo-analysis.js'
import { readSnapshot } from './seo-snapshot.js'

// Mount behind the same local board capability guard. This router never
// runs a browser or fetches a target. Hosted routes require member access;
// share and public routes must not mount this private diagnostic API.
export function checksRouter(getConfig) {
  const router = express.Router()
  router.get('/api/boards/:boardId/checks', (req, res) => {
    try {
      res.set('Cache-Control', 'no-store').json(checksView(getConfig(), req.params.boardId, req.query.env || null))
    } catch {
      res.status(404).json({ error: { code: 'not_found', message: 'Board or environment not found.' } })
    }
  })
  // Local search previews for the SEO view: one per page, for the report its
  // row uses. They hold page text and URLs, so this is never mounted on
  // hosted, share or public routes and previews are never exported.
  router.get('/api/boards/:boardId/checks/seo', (req, res) => {
    try {
      const config = getConfig()
      const board = getBoard(config, req.params.boardId)
      const view = checksView(config, board.id, req.query.env || null)
      const snapshots = {}
      const reports = latestSeoReports(
        view.views,
        board.pages.map((p) => p.id),
      )
      for (const report of reports.values()) {
        const snapshot = readSnapshot(config, board.id, report.id)
        if (snapshot) snapshots[report.id] = snapshot
      }
      res.set('Cache-Control', 'no-store').json({
        schemaVersion: 1,
        environment: view.environment,
        privatePages: board.pages.filter((p) => p.seo?.indexable === false).map((p) => p.id),
        snapshots,
      })
    } catch {
      res.status(404).json({ error: { code: 'not_found', message: 'Board or environment not found.' } })
    }
  })
  router.get('/api/boards/:boardId/checks/:id', (req, res) => {
    const report = readReport(getConfig(), req.params.boardId, req.params.id)
    if (!report) return res.status(404).json({ error: { code: 'not_found', message: 'Check report not found.' } })
    res.set('Cache-Control', 'no-store').json({ report })
  })
  return router
}
