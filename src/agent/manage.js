// A temporary host-only settings surface. It has no board routes, account
// exceptions, notification worker, serve-state file or project registration.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { agentRouter } from './routes.js'
import { localRequest, newSettingsToken } from './settings-routes.js'

const CLIENT = fileURLToPath(new URL('../../dist/client/', import.meta.url))
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'"

export function createAgentManagement({ config, env = process.env, token = newSettingsToken(), clientDir = CLIENT, agentLimits = {} }) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', false)
  const agents = agentRouter({ config, env, settingsToken: token, limits: agentLimits })
  const links = new Map()
  const fail = (res, status) =>
    res.status(status).json({
      error: { code: status === 404 ? 'not_found' : 'host_only', message: 'Use the private agent settings link on this computer.' },
    })
  let closing = false
  app.use((req, res, next) => {
    if (closing) return fail(res, 503)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Security-Policy', CSP)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    if (!localRequest(req)) return fail(res, 403)
    next()
  })
  app.get('/open/:nonce', (req, res) => {
    const expires = links.get(req.params.nonce)
    links.delete(req.params.nonce)
    if (!expires || expires < Date.now()) return fail(res, 404)
    res.redirect(303, `/#settings-token=${token}`)
  })
  app.use('/api', (req, res, next) => (/^\/agent\/settings(?:\/|$)/.test(req.path) ? next() : fail(res, 404)))
  app.use('/api/agent', agents)
  app.use('/api', (req, res) => fail(res, 404))
  app.use('/assets', express.static(path.join(clientDir, 'assets'), { index: false, dotfiles: 'deny' }))
  // Sent relative to a root: an absolute path is refused when any folder in
  // it starts with a dot, which is where installs live (~/.local, .pnpm).
  for (const name of ['theme-boot.js', 'favicon.svg']) app.get(`/${name}`, (req, res) => res.sendFile(name, { root: clientDir }))
  app.get('/', (req, res) => {
    const html = fs
      .readFileSync(path.join(clientDir, 'index.html'), 'utf8')
      .replace('<head>', '<head><meta name="shapewall-agent-settings" content="true">')
      .replace(/<link\b[^>]*rel="(?:manifest|apple-touch-icon)"[^>]*>/g, '')
    res.type('html').send(html)
  })
  app.use((req, res) => fail(res, 404))
  app.locals.openLink = () => {
    const nonce = randomBytes(24).toString('base64url')
    links.clear()
    links.set(nonce, Date.now() + 60000)
    return `/open/${nonce}`
  }
  let stopped
  app.locals.close = () => {
    closing = true
    links.clear()
    stopped ||= agents.close()
    return stopped
  }
  return { app, token }
}

export async function startAgentManagement({ config, env = process.env, port = 0, out = () => {} }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Settings port must be 0 to 65535.')
  const { app, token } = createAgentManagement({ config, env })
  const server = app.listen(port, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const url = `http://127.0.0.1:${server.address().port}`
  out(`Private agent settings (this computer only; keep it to yourself): ${url}/#settings-token=${token}`)
  out('This temporary server has no board, capture or chat routes. Stop it with Ctrl-C when finished.')
  server.once('close', () => app.locals.close())
  return {
    app,
    server,
    url,
    close: async () => {
      const stopped = app.locals.close()
      server.closeAllConnections()
      await Promise.all([stopped, new Promise((resolve) => server.close(resolve))])
    },
  }
}
