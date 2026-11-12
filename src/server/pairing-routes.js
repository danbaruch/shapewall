import express from 'express'
import { Devices, DEVICE_IDLE_MS } from './devices.js'
import { localRequest, sameOriginWrite, settingsTokenOk } from '../agent/settings-routes.js'

const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } })
export function cookieValue(req, name) {
  const values = String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
  return values.length === 1 ? values[0].slice(name.length + 1) : null
}
const loopback = (address) =>
  address === '::1' || /^127\.\d+\.\d+\.\d+$/.test(address || '') || /^::ffff:127\.\d+\.\d+\.\d+$/.test(address || '')
// The board's owner, arriving from another of their tailnet devices. The
// Tailscale-User-Login header alone proves nothing: any program on this
// machine (an agent whose command waits for approval included) can send it
// to the loopback port. It counts only on a request the identity proof let
// through (src/tailnet-proof.js: the serve entry's secret, a connection
// owned by tailscaled, tailscaled's own whois; `tailscale.gate`, made in
// src/server/tailscale.js and asked for every request in src/server/app.js).
// No gate (the proof is not possible here), no identity: such devices pair.
export function ownerIdentity(req, tailscale) {
  if (!tailscale?.ownerLogin || !tailscale.host || tailscale.noIdentity || !tailscale.gate) return false
  if (!loopback(req.socket?.remoteAddress)) return false
  const host = String(req.headers.host || '')
    .toLowerCase()
    .replace(/:\d+$/, '')
  return host === tailscale.host && tailscale.gate.identityOf(req)?.login === String(tailscale.ownerLogin).toLowerCase()
}

// Before every board API and file route: there is one owner, never anonymous guests.
export function remoteAccess({
  config,
  env,
  token,
  tailscale = null,
  noRemoteChat = false,
  approveOnHost = false,
  log = () => {},
  devices = new Devices(config.dir, { env }),
}) {
  const router = express.Router()
  const secure = (req) =>
    Boolean(
      req.socket.encrypted ||
      (tailscale &&
        loopback(req.socket.remoteAddress) &&
        String(req.headers.host || '')
          .toLowerCase()
          .replace(/:\d+$/, '') === tailscale.host),
    )
  const cookie = (req, res, name, value, maxAge) =>
    res.append(
      'Set-Cookie',
      `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAge / 1000)}${secure(req) ? '; Secure' : ''}`,
    )
  const protectedWrite = (req, res, next) => {
    if (!req.is('application/json')) return fail(res, 415, 'json_required', 'Send JSON (Content-Type: application/json).')
    if (!sameOriginWrite(req)) return fail(res, 403, 'bad_origin', 'Use the pairing page on this server.')
    next()
  }
  const host = (req, res, next) => {
    if (req.shapewallAccess.kind === 'nobody') return fail(res, 401, 'pairing_required', 'Pair this device first.')
    if (!localRequest(req) || !settingsTokenOk(req, token))
      return fail(res, 403, 'host_only', 'Change this on the computer running Shapewall (use the settings link from its terminal).')
    if (req.method !== 'GET' && !sameOriginWrite(req)) return fail(res, 403, 'bad_origin', 'Use the board page on this computer.')
    next()
  }
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    const device = devices.authenticate(cookieValue(req, devices.cookie))
    req.shapewallAccess = localRequest(req)
      ? { kind: 'host', name: 'Host computer' }
      : device
        ? { kind: 'device', ...device }
        : ownerIdentity(req, tailscale)
          ? { kind: 'identity', name: 'Owner via Tailscale' }
          : { kind: 'nobody' }
    if (device)
      cookie(
        req,
        res,
        devices.cookie,
        cookieValue(req, devices.cookie),
        Math.min(DEVICE_IDLE_MS, device.createdAt + 90 * 86400000 - Date.now()),
      )
    next()
  })
  router.get('/api/pairing', (req, res) => {
    const pairing = devices.poll(cookieValue(req, devices.pairCookie))
    if (pairing.state === 'approved') cookie(req, res, devices.cookie, cookieValue(req, devices.pairCookie), DEVICE_IDLE_MS)
    res.json({
      enabled: true,
      secure: secure(req),
      access: req.shapewallAccess.kind,
      pairing,
      // This browser is on the computer that runs Shapewall and came in through its tailnet name:
      // the tailnet identity is never taken from here (src/tailnet-proof.js).
      ownMachine: Boolean(tailscale?.gate?.ownMachine?.(req)),
    })
  })
  router.post('/api/pairing', protectedWrite, express.json({ limit: '2kb' }), (req, res) => {
    try {
      const item = devices.request({
        name: req.body?.name,
        ip: req.socket.remoteAddress,
        browser: req.headers['user-agent'],
        previous: cookieValue(req, devices.pairCookie),
      })
      cookie(req, res, devices.pairCookie, item.token, 5 * 60000)
      log(
        `${item.name} (${item.browser}, ${item.ip}) wants to pair: code ${item.code.slice(0, 4)}-${item.code.slice(4)}. Approve with: shapewall devices approve ${item.code}`,
      )
      res.status(201).json({ state: item.state, code: item.code, name: item.name, expiresAt: item.expiresAt })
    } catch (error) {
      fail(
        res,
        error.status || 500,
        'pairing_failed',
        error.status ? error.message : 'Pairing could not be saved. Check the host terminal.',
      )
    }
  })
  router.get('/api/devices', host, (req, res) => res.json(devices.list()))
  router.post('/api/devices/:code/:decision', host, protectedWrite, express.json({ limit: '2kb' }), (req, res) => {
    if (!['approve', 'deny'].includes(req.params.decision)) return fail(res, 404, 'not_found', 'No such action.')
    try {
      res.json(devices.decide(req.params.code, req.params.decision === 'approve'))
    } catch (error) {
      fail(res, error.status || 500, 'pairing_failed', error.status ? error.message : 'Pairing could not be saved.')
    }
  })
  router.delete('/api/devices/:id', (req, res) => {
    if (req.shapewallAccess.kind === 'nobody') return fail(res, 401, 'pairing_required', 'Pair this device first.')
    if (!sameOriginWrite(req)) return fail(res, 403, 'bad_origin', 'Use the board page itself.')
    const own = req.shapewallAccess.kind === 'device' && req.params.id === req.shapewallAccess.id
    if (!own && !(localRequest(req) && settingsTokenOk(req, token)))
      return fail(res, 403, 'host_only', 'You may revoke only this device; manage other devices on the host computer.')
    const revoked = devices.revoke(req.params.id)
    if (own) cookie(req, res, devices.cookie, '', 0)
    res.json({ revoked })
  })
  router.use((req, res, next) => {
    const access = req.shapewallAccess
    // Express routes are case-insensitive by default; authorization must be too.
    const route = req.path.toLowerCase()
    // Answering an agent's request to run a command or edit a file: the
    // settings token from the host's own terminal, whatever the request
    // looks like, unless it is the owner by proven tailnet identity or a
    // device the owner paired (its own cookie, approved on the host). A
    // local program cannot approve its own command by dressing a request up
    // as coming from somewhere else.
    if (/\/permissions\//.test(route) && !['identity', 'device'].includes(access.kind) && !settingsTokenOk(req, token))
      return fail(res, 403, 'host_only', 'Use the settings link on the host computer to approve commands.')
    if (access.kind === 'nobody') {
      if (route.startsWith('/api/')) return fail(res, 401, 'pairing_required', 'Pair this device on the computer running Shapewall.')
      // Only the application shell and public static assets. Captures and data never pass this gate.
      if (!(
        route === '/' ||
        route === '/index.html' ||
        route.startsWith('/assets/') ||
        route.startsWith('/icons/') ||
        route === '/theme-boot.js' ||
        route === '/favicon.svg' ||
        /^\/(?:sw\.js|manifest\.webmanifest|icon(?:-[a-z0-9]+)?\.(?:svg|png)|favicon\.ico)$/.test(route)
      ))
        return fail(res, 401, 'pairing_required', 'Pair this device first.')
    } else if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!sameOriginWrite(req)) return fail(res, 403, 'bad_origin', 'Use the board page itself.')
    }
    if (access.kind !== 'host' && route.startsWith('/api/agent/')) {
      if (noRemoteChat && !route.startsWith('/api/agent/settings'))
        return fail(res, 403, 'remote_chat_disabled', 'Chat from other devices is off (--no-remote-chat).')
      if (approveOnHost && /\/permissions\//.test(route))
        return fail(res, 403, 'host_approval_required', 'Approve this command on the computer running Shapewall.')
    }
    next()
  })
  return router
}
