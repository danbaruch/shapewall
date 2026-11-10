// The hosted app's pages (src/hosted/app.js): the console (a React app
// built into dist/console) and the board client for members, public
// projects and share link guests.

import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { assetHeaders } from '../server/app.js'
import { ID_PATTERNS, randomToken } from './crypto.js'
import { createProjectStore } from './projects.js'
import { readPublic } from './public.js'
import { readGuest } from './shares.js'
import { roleIn, tenant } from './tenancy.js'
import { TURNSTILE_ORIGIN } from './turnstile.js'

const CONSOLE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"

// The service worker served under each board path (see below).
const removeWorker = (req, res) => {
  res.setHeader('Cache-Control', 'no-cache')
  res
    .type('js')
    .send(
      "self.addEventListener('install', () => self.skipWaiting())\nself.addEventListener('activate', () => self.registration.unregister())\n",
    )
}

export function mountPages(app, { db, dataDir, consoleDir, clientDir, turnstile, sessionOf, BOARD_PAGE_CSP, deps }) {
  // ---- Pages: the console and the board client ----
  // The console page gets a fresh nonce per response: the only inline thing
  // it allows is a <style> element that the dialog's scroll lock adds with
  // that nonce. Scripts come from 'self' only.
  const consoleFile = path.join(consoleDir, 'console.html')
  const consoleHtml = fs.existsSync(consoleFile) ? fs.readFileSync(consoleFile, 'utf8') : null
  const sendConsole = (req, res, status = 200) => {
    if (!consoleHtml) return res.status(status).type('text').send('The Shapewall console is not built yet. Run "npm run build".')
    res.status(status)
    const nonce = randomToken(18)
    let csp = CONSOLE_CSP.replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`)
    // The bot check's widget, only on a server that has one.
    if (turnstile)
      csp = csp
        .replace("script-src 'self'", `script-src 'self' ${TURNSTILE_ORIGIN}`)
        .replace("frame-src 'none'", `frame-src ${TURNSTILE_ORIGIN}`)
    res.setHeader('Content-Security-Policy', csp)
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cache-Control', 'no-store')
    res.type('html').send(consoleHtml.replace('__SW_NONCE__', nonce))
  }
  app.use('/_console/assets', express.static(path.join(consoleDir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }))
  app.use('/_console', express.static(consoleDir, { index: false, maxAge: '1h', fallthrough: false }))
  for (const route of [
    '/',
    '/signin',
    '/signup',
    '/account',
    '/invite',
    '/share',
    '/device',
    '/rebind',
    '/moving',
    '/w/:ws',
    '/w/:ws/:section',
    '/w/:ws/projects/:pid',
  ])
    app.get(route, (req, res) => sendConsole(req, res))

  const clientBuilt = fs.existsSync(path.join(clientDir, 'index.html'))
  // The client's own files under each project path; they hold no data.
  // The board's offline service worker caches the app shell; hosted boards
  // sit behind a session, so this one only removes itself.
  app.get('/w/:ws/p/:pid/index.html', (req, res) => res.redirect(302, './'))
  app.get('/w/:ws/p/:pid/sw.js', removeWorker)
  if (clientBuilt) {
    app.use(
      '/w/:ws/p/:pid/assets',
      express.static(path.join(clientDir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false, setHeaders: assetHeaders }),
    )
    app.use('/w/:ws/p/:pid', express.static(clientDir, { index: false, maxAge: '1h' }))
  }
  // Routing is not strict about the trailing slash, but the client's
  // relative API paths need it.
  app.get('/w/:ws/p/:pid', (req, res) => {
    if (!req.path.endsWith('/')) {
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''
      return res.redirect(302, `/w/${encodeURIComponent(req.params.ws)}/p/${encodeURIComponent(req.params.pid)}/${query}`)
    }
    const current = sessionOf(req)
    if (!current) return res.redirect(302, `/signin?next=${encodeURIComponent(req.originalUrl)}`)
    const ws = req.params.ws
    const role = ID_PATTERNS.workspace.test(ws) ? roleIn(db, current.user.id, ws) : null
    const project = role ? createProjectStore(tenant(db, ws), { db, dataDir }).get(req.params.pid) : null
    // No access (removed, never a member, or no such board): the console's
    // own page says so, with a way to sign in as someone else. Still a 404.
    if (!project) return sendConsole(req, res, 404)
    if (!clientBuilt) return res.type('text').send('The Shapewall client is not built yet. Run "npm run build".')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()')
    res.setHeader('Content-Security-Policy', BOARD_PAGE_CSP)
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile('index.html', { root: clientDir })
  })

  // A public project's board: the same client on the view-only API. No
  // cookie is read here; an unknown or switched-off id is a plain 404.
  app.get('/p/:pubid/index.html', (req, res) => res.redirect(302, './'))
  app.get('/p/:pubid/sw.js', removeWorker)
  if (clientBuilt) {
    app.use(
      '/p/:pubid/assets',
      express.static(path.join(clientDir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false, setHeaders: assetHeaders }),
    )
    app.use('/p/:pubid', express.static(clientDir, { index: false, maxAge: '1h' }))
  }
  app.get('/p/:pubid', (req, res) => {
    if (!req.path.endsWith('/')) return res.redirect(302, `/p/${encodeURIComponent(req.params.pubid)}/`)
    if (!readPublic(req, db)) return res.status(404).type('text').send('Not found')
    if (!clientBuilt) return res.type('text').send('The Shapewall client is not built yet. Run "npm run build".')
    res.setHeader('Content-Security-Policy', BOARD_PAGE_CSP)
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile('index.html', { root: clientDir })
  })

  // A share link's board: the same client, for a guest with the cookie that
  // /api/shares/open set for this path. Without it, back to the share page.
  app.get('/s/:sid/index.html', (req, res) => res.redirect(302, './'))
  app.get('/s/:sid/sw.js', removeWorker)
  if (clientBuilt) {
    app.use(
      '/s/:sid/assets',
      express.static(path.join(clientDir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false, setHeaders: assetHeaders }),
    )
    app.use('/s/:sid', express.static(clientDir, { index: false, maxAge: '1h' }))
  }
  app.get('/s/:sid', (req, res) => {
    if (!req.path.endsWith('/')) return res.redirect(302, `/s/${encodeURIComponent(req.params.sid)}/`)
    if (!readGuest(req, deps)) return res.redirect(302, '/share?ended=1')
    if (!clientBuilt) return res.type('text').send('The Shapewall client is not built yet. Run "npm run build".')
    res.setHeader('Content-Security-Policy', BOARD_PAGE_CSP)
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile('index.html', { root: clientDir })
  })
}
