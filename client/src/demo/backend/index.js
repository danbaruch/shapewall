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
// events is an async iterable of [name, data] (server-sent events).
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
import { DemoError } from './util.js'

export { AGENT_INFO, DemoError } from './util.js'

// state: the saved object (fixtures.seedState). loadJson(url): reads one of
// the export's files. now(): the clock. location: { project, share } from the
// page URL (which project's board is open, a share link being opened).
export function createDemoBackend({ state, loadJson, now = () => Date.now(), location = {}, save = () => {} }) {
  const iso = (offset = 0) => new Date(now() + offset).toISOString()
  const ctx = { state, loadJson, now, location, save, iso, runs: new Map() }
  Object.assign(ctx, identity(ctx))
  Object.assign(ctx, consoleHelpers(ctx))
  Object.assign(ctx, boardData(ctx))
  Object.assign(ctx, commentHelpers(ctx))
  const { me, personaFor, shareUsableNow } = ctx

  // In this order: the board and its comments, checks, chat, the console.
  const routes = [
    ...boardRoutes(ctx),
    ...commentRoutes(ctx),
    ...checkRoutes(ctx),
    ...chatRoutes(ctx),
    ...authRoutes(ctx),
    ...workspaceRoutes(ctx),
  ]

  async function handle({ method, path, search = '', body, signal }) {
    try {
      for (const [routeMethod, pattern, fn] of routes) {
        const match = pattern.exec(path)
        if (!match || (routeMethod && routeMethod !== method)) continue
        const result = await fn({ params: match.slice(1), body, search, signal })
        if (result && result.events) return result
        save()
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
