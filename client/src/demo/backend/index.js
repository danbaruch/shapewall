// The public demo's backend, in the browser: it answers the board API, the
// hosted console API and the chat API the way `shapewall hosted` does, from
// the fixtures (fixtures.js) and the export's files, and keeps every change
// in one state object the caller saves (localStorage). Nothing here talks to
// a server. Who may do what comes from the server's own rules
// (src/hosted/permissions.js, guest-view.js), so View as behaves exactly like
// the real roles; test/demo-backend.test.js checks it against the server.
//
// handle({ method, path, search, body, signal }) resolves to
// { status, json } or, for a chat message, { status: 200, events } where
// events is an async iterable of [name, data] (server-sent events), or, for
// an export, { status: 200, file: { name, type, text } } (a download).
//
// The console's Usage and Activity pages have their own part (usage/routes.js:
// a fictional history and the queries over it), loaded when one of them first
// asks, so the board and the rest of the console never load it.
//
// Each part gets one shared ctx: the inputs below, then the helpers of the
// parts before it (identity, console helpers, board data, comment helpers).

import { identity } from './identity.js'
import { consoleHelpers } from './console-helpers.js'
import { authRoutes } from './routes-auth.js'
import { workspaceRoutes } from './routes-workspace.js'
import { boardData } from './board-data.js'
import { commentHelpers, commentRoutes } from './comments.js'
import { boardRoutes, checkRoutes } from './board-routes.js'
import { chatRoutes } from './chat.js'
import { agentRoutes } from './routes-agents.js'
import { batchRoutes } from './batch.js'
import { DemoError } from './util.js'

export { AGENT_INFO, DemoError } from './util.js'

// What the Usage and Activity pages ask for (src/hosted/usage-routes.js).
const USAGE_PATHS =
  /^\/api\/workspaces\/[a-z0-9_]+\/(usage(\/.*)?|views(\/[a-z0-9_]+)?|activity(\/(filters|export))?|people\/[a-z0-9_]+|agents\/[a-z0-9_]+\/profile|access-review(\/export)?)$/

// state: the saved object (fixtures.seedState). loadJson(url): reads one of
// the export's files. now(): the clock. location: { project, share } from the
// page URL (which project's board is open, a share link being opened).
// onBatch(boardId): a board's batch of fixes moved (install.js tells the views).
// zoneOffset: the viewer's time zone, in minutes ahead of UTC (the fictional
// usage history keeps the viewer's days and working hours).
export function createDemoBackend({
  state,
  loadJson,
  now = () => Date.now(),
  location = {},
  save = () => {},
  onBatch = () => {},
  zoneOffset = 0,
}) {
  const iso = (offset = 0) => new Date(now() + offset).toISOString()
  const ctx = { state, loadJson, now, location, save, iso, onBatch, zoneOffset, runs: new Map() }
  Object.assign(ctx, identity(ctx))
  Object.assign(ctx, consoleHelpers(ctx))
  Object.assign(ctx, boardData(ctx))
  Object.assign(ctx, commentHelpers(ctx))
  const { me, personaFor, shareUsableNow } = ctx

  // In this order: the board and its comments, checks, chat, the Agents page, the console.
  const routes = [
    ...boardRoutes(ctx),
    ...commentRoutes(ctx),
    ...checkRoutes(ctx),
    ...chatRoutes(ctx),
    ...agentRoutes(ctx),
    ...batchRoutes(ctx),
    ...authRoutes(ctx),
    ...workspaceRoutes(ctx),
    // Usage and Activity, loaded on first use.
    [null, USAGE_PATHS, async (request) => (await usagePart())(request)],
  ]
  let usageLoading = null
  const usagePart = () => (usageLoading ||= import('../usage/routes.js').then((part) => part.usageRoutes(ctx)))
  // The audit log as the console reads it: the fictional history and the
  // demo's own entries as one list, the same one the Activity page shows.
  ctx.auditLog = async (ws) => (await usagePart()).auditLog(ws)

  // One route called from inside the backend (a batch starts each fix through
  // the Fix with agent route): its result as is, a DemoError thrown.
  ctx.route = async (method, path, body) => {
    for (const [routeMethod, pattern, fn] of routes) {
      const match = pattern.exec(path)
      if (match && (!routeMethod || routeMethod === method)) return fn({ params: match.slice(1), body, search: '', method, path })
    }
    throw new DemoError(404, 'not_found', 'No such API route.')
  }

  async function handle({ method, path, search = '', body, signal }) {
    try {
      for (const [routeMethod, pattern, fn] of routes) {
        const match = pattern.exec(path)
        if (!match || (routeMethod && routeMethod !== method)) continue
        const result = await fn({ params: match.slice(1), body, search, signal, method, path })
        if (result && result.events) return result
        save()
        if (result && result.file) return { status: 200, file: result.file }
        if (result && typeof result.status === 'number' && 'json' in result) return result
        return { status: 200, json: result }
      }
      return { status: 404, json: { error: { code: 'not_found', message: 'No such API route.' } } }
    } catch (error) {
      if (error instanceof DemoError) return { status: error.status, json: { error: { code: error.code, message: error.message } } }
      throw error
    }
  }

  return {
    handle,
    state,
    me,
    personaFor,
    // Whether a share link opens now, and if not why: 'ok', 'unknown',
    // 'revoked', 'expired' or 'off' (share links turned off, or its creator
    // may no longer share), with the time it was revoked or expired.
    shareStatus(id) {
      const share = state.shares.find((item) => item.id === id)
      if (!share) return { status: 'unknown', at: null }
      if (share.revokedAt) return { status: 'revoked', at: share.revokedAt }
      if (share.expiresAt <= iso()) return { status: 'expired', at: share.expiresAt }
      return shareUsableNow(share) ? { status: 'ok', at: null } : { status: 'off', at: null }
    },
    // The bridge for View as and Reset (install.js).
    setViewAs(role, { shareId } = {}) {
      state.viewAs = role
      if (shareId !== undefined) state.guestShareId = shareId
      save()
    },
  }
}
