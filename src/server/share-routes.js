// Host-only bridge controls. Never accepts a command, token, config path or
// arbitrary endpoint. The owner capability + direct local request is required
// on reads too, and same-origin is required on every write.
import express from 'express'
import { settingsRefusal, settingsTokenOk, sameOriginWrite } from '../agent/settings-routes.js'
import { getBoard } from '../config.js'
import { readMigration, writeMigration } from '../store.js'
import { share } from '../remote/share.js'
import { remoteOrigin } from '../remote/remote.js'

export function shareRouter({ config, shared, settingsToken, env, log, shareImpl = share, beforeShare = () => {} }) {
  const router = express.Router()
  let job = null
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!settingsTokenOk(req, settingsToken)) return res.status(404).json({ error: { code: 'not_found', message: 'No such route.' } })
    if (settingsRefusal(req, { shared }) || (!['GET', 'HEAD'].includes(req.method) && !sameOriginWrite(req)))
      return res
        .status(403)
        .json({ error: { code: 'host_only', message: 'Sharing is available only on the host, through its private settings link.' } })
    next()
  })
  router.get('/status', (req, res) =>
    res.json(
      job
        ? {
            status: job.status,
            lines: job.lines,
            result: job.result,
            error: job.error,
            verificationUrl: job.verificationUrl,
            boardId: job.boardId,
          }
        : { status: 'idle', lines: [] },
    ),
  )
  router.post('/start', async (req, res, next) => {
    try {
      if (job?.status === 'running')
        return res.status(409).json({ error: { code: 'share_busy', message: 'A move is already running. Return to its progress dialog.' } })
      const origin = remoteOrigin({ remote: req.body?.remote }, {})
      const board = getBoard(config, req.body?.board)
      beforeShare(board.id)
      job = { status: 'running', lines: [], result: null, error: null, verificationUrl: `${origin}/device`, boardId: board.id }
      const current = job
      const output = (line) => {
        current.lines.push(String(line).slice(0, 1500))
        current.lines = current.lines.slice(-80)
      }
      // Avoid launching a desktop browser from the server process. The dialog
      // shows the origin's /device link and human approval code instead.
      shareImpl({ remote: origin, board: board.id, 'no-comments': req.body?.noComments === true }, output, {
        config,
        // A process-wide token has no attested destination. UI moves only
        // use credentials saved for the exact origin or a new device login.
        env: { ...env, SHAPEWALL_TOKEN: '', SHAPEWALL_REMOTE: '' },
        open: () => false,
        beforeFreeze: beforeShare,
      })
        .then((result) => {
          current.result = result
          current.status = 'done'
        })
        .catch((error) => {
          current.error = String(error.message).slice(0, 1000)
          current.status = 'failed'
          log('Share failed; the host progress dialog has the error.')
        })
      res.status(202).json({ status: 'running', verificationUrl: `${origin}/device` })
    } catch (error) {
      next(error)
    }
  })
  router.post('/local-comments', async (req, res, next) => {
    try {
      const board = getBoard(config, req.body?.board)
      if (typeof req.body?.readOnly !== 'boolean')
        return res.status(400).json({ error: { code: 'invalid_choice', message: 'Choose whether the local copy is read-only.' } })
      const marker = readMigration(config, board.id)
      if (!marker?.url || marker.pending || job?.status === 'running')
        return res.status(409).json({ error: { code: 'not_moved', message: 'Finish moving this board first.' } })
      await writeMigration(config, board.id, { ...marker, readOnly: req.body.readOnly })
      res.json({ ok: true })
    } catch (error) {
      next(error)
    }
  })
  return router
}
