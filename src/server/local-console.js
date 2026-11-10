// The local Console uses the existing board APIs and their capabilities.
// Serving its shell does not create a hosted session or grant owner access.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import express from 'express'

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"

export function mountLocalConsole(app, consoleDir, { accounts = false } = {}) {
  app.get([/^\/console(?:\/.*)?$/, '/account', '/signin', '/signup', '/_console/console.html'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Frame-Options', 'DENY')
    const nonce = randomBytes(18).toString('base64')
    res.setHeader('Content-Security-Policy', CSP.replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`))
    const file = path.join(consoleDir, 'console.html')
    if (!fs.existsSync(file)) return res.status(503).type('text').send('The Shapewall console is not built yet. Run "npm run build".')
    res.type('html').send(
      fs
        .readFileSync(file, 'utf8')
        .replace('__SW_NONCE__', nonce)
        .replace('</head>', `<meta name="shapewall-local-console">\n${accounts ? '<meta name="shapewall-local-accounts">\n' : ''}</head>`),
    )
  })
  app.use('/_console/assets', express.static(path.join(consoleDir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }))
  app.use('/_console', express.static(consoleDir, { index: false, maxAge: '1h', fallthrough: false }))
}
