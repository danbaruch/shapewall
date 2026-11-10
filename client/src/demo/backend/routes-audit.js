// The console's review routes: agent feedback and the audit log.

import { exportDocument, reviewQuery, summarizeRatings } from '../../../../src/agent/ratings-core.js'
import { AUDIT_PAGE, AUDIT_PAGE_MAX, fail } from './util.js'

export function auditRoutes(ctx) {
  const { state, userById, inWorkspace, actorOf, targetLabel, now } = ctx

  return [
    // Agent feedback: ratings on chat answers across the workspace's boards,
    // for admins and owners (they quote questions and answers).
    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/agent-feedback(\/export)?$/,
      ({ params, search }) => {
        inWorkspace(params[0], 'audit')
        const query = reviewQuery(new URLSearchParams(search || ''))
        const boards = state.projects
          .filter((project) => project.workspaceId === params[0])
          .flatMap((project) => project.boards.map((board) => ({ project, board })))
        const entries = boards.flatMap(({ project, board }) =>
          (state.ratings?.[project.id + '/' + board.id] || []).map((item) => ({
            ...item,
            boardId: project.id + '/' + board.id,
            boardTitle: project.name,
          })),
        )
        if (params[1]) return exportDocument(entries, new Date(now()))
        return {
          ...summarizeRatings(
            entries.filter((item) => !query.board || item.boardId === query.board),
            { ...query, now: now() },
          ),
          boards: boards.map(({ project, board }) => ({ id: project.id + '/' + board.id, title: project.name })),
        }
      },
    ],
    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/audit$/,
      ({ params, search }) => {
        inWorkspace(params[0], 'audit')
        const query = new URLSearchParams(search || '')
        let entries = state.audit.filter((item) => item.workspaceId === params[0])
        const before = Number(query.get('before'))
        if (Number.isSafeInteger(before) && before > 0) entries = entries.filter((item) => item.id < before)
        const actor = query.get('actor')
        if (actor) {
          const [kind, id] = actor.split(':')
          const key = { user: 'userId', token: 'tokenId', share: 'shareId' }[kind]
          if (!key || !/^[a-z]{2}_[a-f0-9]{24}$/.test(id || '')) fail(400, 'invalid_actor', 'actor: user:<id>, token:<id> or share:<id>.')
          entries = entries.filter((item) => item[key] === id)
        }
        if (query.get('action')) entries = entries.filter((item) => item.action === query.get('action'))
        if (query.get('from')) entries = entries.filter((item) => item.at >= query.get('from'))
        if (query.get('to')) entries = entries.filter((item) => item.at < query.get('to'))
        const needle = (query.get('q') || '').trim().toLowerCase()
        if (needle) {
          entries = entries.filter((item) => {
            const actor = actorOf(item)
            const text = [
              item.action.replace(/_/g, ' '),
              item.target,
              item.ip,
              JSON.stringify(item.detail || {}),
              actor.label,
              actor.handle,
              actor.link,
              targetLabel(item.target),
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
            return text.includes(needle)
          })
        }
        const limit = Math.min(Math.max(Number.parseInt(query.get('limit'), 10) || AUDIT_PAGE, 1), AUDIT_PAGE_MAX)
        const sorted = entries.sort((a, b) => b.id - a.id)
        const page = sorted.slice(0, limit)
        return {
          entries: page.map((item) => ({
            id: item.id,
            action: item.action,
            target: item.target,
            targetLabel: targetLabel(item.target),
            at: item.at,
            ip: item.ip,
            user: userById(item.userId)?.handle || null,
            tokenId: item.tokenId,
            actor: actorOf(item),
            detail: item.detail || {},
          })),
          next: sorted.length > limit ? page[page.length - 1].id : null,
        }
      },
    ],
    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/audit\/filters$/,
      ({ params }) => {
        inWorkspace(params[0], 'audit')
        const entries = state.audit.filter((item) => item.workspaceId === params[0])
        const counts = new Map()
        for (const item of entries) {
          const key = `${item.userId}|${item.tokenId}|${item.shareId}`
          counts.set(key, { item, n: (counts.get(key)?.n || 0) + 1 })
        }
        return {
          actors: [...counts.values()]
            .sort((a, b) => b.n - a.n)
            .map(({ item }) => actorOf(item))
            .filter((actor) => actor.type !== 'system'),
          actions: [...new Set(entries.map((item) => item.action))].sort(),
        }
      },
    ],
  ]
}
