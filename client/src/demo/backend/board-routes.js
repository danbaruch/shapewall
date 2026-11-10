// The board API's own routes (info, boards, journeys, compare and what a
// hosted board refuses), and the checks report.

import { demoChecks, demoSeo } from '../checks.js'
import { boardPermissions, guestPermissions, roleAtLeast } from '../../../../src/hosted/permissions.js'
import { demoAvatarUrl } from '../avatar.js'
import { AGENT_INFO, fail } from './util.js'

export function boardRoutes(ctx) {
  const { state, loadJson, iso, boardAccess, rebase, boardViewOf, commentsOf, counts, chatAllowed } = ctx
  return [
    [
      'GET',
      /^\/api\/info$/,
      () => {
        const access = boardAccess()
        const workspace = state.workspaces.find((item) => item.id === access.project.workspaceId)
        if (access.role === 'guest') {
          const share = access.share
          share.opens += 1
          share.lastUsedAt = iso()
          return {
            title: access.project.name,
            readOnly: share.mode !== 'comment',
            allowCapture: false,
            hosted: true,
            guest: true,
            demo: true,
            checksAvailable: share.includeChecks === true,
            user: { name: state.guestName && state.guestName !== 'Guest' ? `${state.guestName} (guest)` : 'Guest', handle: null },
            role: 'guest',
            permissions: guestPermissions(share.mode),
            shareExpiresAt: share.expiresAt,
            fixturesAt: null,
          }
        }
        return {
          title: access.project.name,
          readOnly: !roleAtLeast(access.role, 'member'),
          allowCapture: false,
          hosted: true,
          demo: true,
          checksAvailable: true,
          user: { name: access.user.displayName, handle: access.user.handle, avatarUrl: demoAvatarUrl(state, access.user.id) },
          role: access.role,
          permissions: boardPermissions(access.role),
          workspace: { id: workspace.id, name: workspace.name },
          project: {
            id: access.project.id,
            name: access.project.name,
            url: `console.html#/w/${workspace.id}/projects/${access.project.id}`,
          },
          consoleUrl: `console.html#/w/${workspace.id}`,
          ...(chatAllowed(access) ? { agent: AGENT_INFO } : {}),
          fixturesAt: null,
        }
      },
    ],
    [
      'GET',
      /^\/api\/boards$/,
      async () => {
        const access = boardAccess()
        const boards = []
        for (const board of access.project.boards) {
          const view = await boardViewOf(access.project, board.id)
          boards.push({ id: board.id, title: view.board.title, pageCount: view.board.pages.length })
        }
        return { boards }
      },
    ],
    [
      'GET',
      /^\/api\/boards\/([a-z0-9-]+)$/,
      async ({ params }) => {
        const access = boardAccess()
        const view = await boardViewOf(access.project, params[0])
        view.commentCounts = counts((await commentsOf(access.project, params[0])).list)
        return view
      },
    ],
    [
      'GET',
      /^\/api\/boards\/([a-z0-9-]+)\/journeys$/,
      async ({ params }) => {
        const access = boardAccess()
        return { journeys: (await boardViewOf(access.project, params[0])).journeys }
      },
    ],
    [
      'GET',
      /^\/api\/boards\/([a-z0-9-]+)\/compare$/,
      async ({ params, search }) => {
        const access = boardAccess()
        const board = access.project.boards.find((item) => item.id === params[0]) || fail(404, 'unknown_board', 'No such board.')
        if (board.groups) fail(404, 'not_found', 'This board has one environment.')
        const query = new URLSearchParams(search || '')
        const [a, b] = [query.get('a') || '', query.get('b') || '']
        if (!/^[a-z0-9-]+$/.test(a) || !/^[a-z0-9-]+$/.test(b)) fail(400, 'invalid_pair', 'a and b: environment ids.')
        return rebase(await loadJson(`data/boards/${board.folder}/compare/${a}_${b}.json`))
      },
    ],
    [
      null,
      /^\/api\/boards\/[a-z0-9-]+\/journeys(\/.*)?$/,
      () => fail(403, 'hosted_journeys', 'Journeys come from your config on a hosted board; edit them there and push again.'),
    ],
    [null, /^\/api\/boards\/[a-z0-9-]+\/capture$/, () => fail(403, 'capture_disabled', 'Hosted boards are updated with shapewall push.')],
  ]
}

export function checkRoutes(ctx) {
  const { state, now, boardAccess, boardViewOf } = ctx
  return [
    [
      'GET',
      /^\/api\/boards\/([a-z0-9-]+)\/checks\/seo$/,
      async ({ params, search }) => {
        const access = boardAccess()
        if (access.role === 'guest' && access.share.includeChecks !== true) fail(404, 'not_found', 'Check report not found.')
        const view = await boardViewOf(access.project, params[0])
        const checks = demoChecks(view, { environment: new URLSearchParams(search).get('env'), now: Date.parse(state.seededAt) || now() })
        if (!checks) fail(404, 'not_found', 'No checks for this environment.')
        // Fictional previews, as a local installation would show them.
        return demoSeo(view, checks)
      },
    ],
    [
      'GET',
      /^\/api\/boards\/([a-z0-9-]+)\/checks(?:\/(check-[a-f0-9-]+))?$/,
      async ({ params, search }) => {
        const access = boardAccess()
        if (access.role === 'guest' && access.share.includeChecks !== true) fail(404, 'not_found', 'Check report not found.')
        const view = await boardViewOf(access.project, params[0])
        const checks = demoChecks(view, { environment: new URLSearchParams(search).get('env'), now: Date.parse(state.seededAt) || now() })
        if (!checks) fail(404, 'not_found', 'No checks for this environment.')
        if (!params[1]) return checks
        const report = checks.views.flatMap((v) => v.runs.flatMap((r) => r.history)).find((r) => r.id === params[1])
        if (!report) fail(404, 'not_found', 'Check report not found.')
        return { report }
      },
    ],
  ]
}
