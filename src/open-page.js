// One-use open links that never put their nonce on a command line.
//
// `shapewall serve --open` (and `shapewall agent settings --open`) hand the
// browser a one-time way in. Its nonce must not go in the opener's argv
// (xdg-open, open, explorer.exe): any other user of this machine can read
// every process's command line (/proc/<pid>/cmdline, ps) and use it first.
// It must not be printed either (logs, scrollback).
//
// So the nonce goes into a 0600 page in the project's .shapewall folder,
// open-<id>.html, that posts it to <origin>/open; the browser is opened (or
// told) on that file's path. The page is removed once its nonce is tried,
// when it expires, and at stop; its nonce lives only in the server's memory,
// so a page a stopped server left behind is dead, and the next server for
// the project removes it when it starts. POST /open is the only way to use a
// nonce, and its answer hands the settings token to the tab without putting
// it in any URL (sendTokenHandoff), so it never lands in browser history.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { PROXY_HEADERS, localRequest } from './agent/settings-routes.js'

// open-<pid>-<id>.html; open-<id>.html from 1.4.1.
const PAGE_RE = /^open-(?:([1-9][0-9]{0,9})-)?[a-f0-9]{16}\.html$/
const NONCE_RE = /^[A-Za-z0-9_-]{32}$/
const MAX_WAITING = 16

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

// The page the browser is opened on: it posts the nonce to `action`.
const openPage = (action, nonce) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Shapewall: opening</title></head>
<body><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
<p>Opening Shapewall. <button type="submit">Open</button></p></form>
<script>document.forms[0].submit()</script></body></html>
`

// The key the board keeps the settings token under for its tab
// (client/src/lib/api.js TOKEN_KEY).
export const SETTINGS_TOKEN_KEY = 'shapewall-settings-token'

// The answer to a redeemed POST /open: a page that puts the settings token in
// this tab's sessionStorage, where the board reads it, then replaces itself
// with `target`. The token is in this no-store page only, never in a URL or
// fragment, so browser history never records it. The script runs under a
// nonce of this response's own CSP.
export function sendTokenHandoff(res, { token, target }) {
  const nonce = randomBytes(16).toString('base64')
  const data = JSON.stringify({ key: SETTINGS_TOKEN_KEY, token, target }).replace(/</g, '\\u003c')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  )
  res.status(200).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Shapewall: opening</title></head>
<body><p>Opening Shapewall.</p><noscript><p>Turn on JavaScript, or open the private owner link that shapewall serve printed.</p></noscript>
<script nonce="${nonce}">const d = ${data}; try { sessionStorage.setItem(d.key, d.token) } catch {} location.replace(d.target)</script></body></html>
`)
}

// A request from this machine, straight to this server (no proxy headers), to
// a loopback host name. The form is posted from a file:// page, whose Origin
// is "null"; the nonce, not the origin, is what proves who sent it.
export function localOpenRequest(req) {
  if (PROXY_HEADERS.some((name) => req.headers?.[name] !== undefined)) return false
  const origin = req.headers?.origin
  if (origin === undefined || origin === 'null') return localRequest({ socket: req.socket, headers: { ...req.headers, origin: undefined } })
  return localRequest(req)
}

// dir: the folder the pages go in (made 0700 when missing). ttlMs: how long a
// page works; keepMs: how long when no browser could be opened for it and its
// path is printed instead. now: a clock in ms.
export function createOpenPages({ dir, ttlMs, keepMs = ttlMs, now = () => Date.now() }) {
  const waiting = new Map() // nonce -> { file, expires, timer }
  const drop = (nonce) => {
    const entry = waiting.get(nonce)
    waiting.delete(nonce)
    if (!entry) return null
    clearTimeout(entry.timer)
    fs.rmSync(entry.file, { force: true })
    return entry
  }
  const schedule = (nonce, entry, ms) => {
    clearTimeout(entry.timer)
    entry.expires = now() + ms
    entry.timer = setTimeout(() => drop(nonce), ms)
    entry.timer.unref?.()
  }
  // Pages a stopped server left behind: those of a process that is gone, and
  // any older than a page can work (a newer page of a live process may belong
  // to another server for this project, such as settings --open beside serve).
  const alive = (pid) => {
    if (pid === process.pid) return true
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }
  const leftovers = () => {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const match = PAGE_RE.exec(name)
      if (!match) continue
      const file = path.join(dir, name)
      try {
        const stale = (match[1] && !alive(Number(match[1]))) || now() - fs.lstatSync(file).mtimeMs > keepMs
        if (stale) fs.rmSync(file, { force: true })
      } catch {
        /* gone already */
      }
    }
  }
  // At start too, not only when a page is made: plain serve sweeps them as well.
  leftovers()
  return {
    // A new page that posts a new nonce to `action` (an absolute http(s) URL).
    // Returns its file:// URL, which holds no secret.
    mint(action) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      leftovers()
      // Never more than a handful waiting: the oldest goes first.
      while (waiting.size >= MAX_WAITING) drop(waiting.keys().next().value)
      const nonce = randomBytes(24).toString('base64url')
      const file = path.join(dir, `open-${process.pid}-${randomBytes(8).toString('hex')}.html`)
      fs.writeFileSync(file, openPage(action, nonce), { mode: 0o600, flag: 'wx' })
      const entry = { file }
      waiting.set(nonce, entry)
      schedule(nonce, entry, ttlMs)
      return pathToFileURL(file).href
    },
    // The page at this file:// URL (from mint) gets keepMs from now.
    keep(url) {
      for (const [nonce, entry] of waiting) if (pathToFileURL(entry.file).href === url) schedule(nonce, entry, keepMs)
    },
    // Whether `nonce` is a waiting, unexpired one. One try: it is gone either way.
    redeem(nonce) {
      const value = String(nonce || '')
      if (!NONCE_RE.test(value)) return false
      const entry = drop(value)
      return Boolean(entry && entry.expires >= now())
    },
    close() {
      for (const nonce of [...waiting.keys()]) drop(nonce)
    },
  }
}
