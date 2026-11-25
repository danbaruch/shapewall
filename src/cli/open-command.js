// `shapewall open`: the deep link to a board, a page, a comment, a screen size
// or a before and after, printed and opened in the browser. Local boards use
// the running `shapewall serve`; --remote URL a hosted project.
//
// Links carry ids only (src/board-links.js). The browser gets the URL as one
// argument, never through a shell (src/cli/open.js).

import { loadConfig, boardViewports } from '../config.js'
import { boardLink, hostedBoardBase, localBoardBase } from '../board-links.js'
import { getComment } from '../store.js'
import { openBrowser } from './open.js'

const fail = (message) => {
  throw new Error(message)
}

// A page by id, or by its title when exactly one page has it (any case).
export function findPage(pages, wanted) {
  const value = String(wanted)
  const byId = pages.find((page) => page.id === value)
  if (byId) return byId
  const named = pages.filter((page) => String(page.title || '').toLowerCase() === value.toLowerCase())
  if (named.length === 1) return named[0]
  const list = pages
    .slice(0, 20)
    .map((page) => page.id)
    .join(', ')
  if (named.length > 1) fail(`More than one page is called "${value}": use its id (${named.map((page) => page.id).join(', ')}).`)
  return fail(`No page "${value}" on this board. Pages: ${list}${pages.length > 20 ? ', ...' : ''}`)
}

function commentFlag(value) {
  if (value === undefined) return null
  if (!/^\d+$/.test(String(value)) || Number(value) < 1) fail('--comment takes a comment number, such as --comment 12')
  return Number(value)
}

// --compare alone: the page's before and after (its history); --compare A_B
// (or A,B): two environments side by side.
function compareFlag(value, environments) {
  if (value === undefined || value === false) return null
  if (value === true) return true
  const pair = String(value).split(/[_,]/)
  if (pair.length !== 2 || pair[0] === pair[1])
    fail('--compare takes no value (before and after) or two environment ids, such as --compare staging_prod')
  if (environments) {
    const ids = environments.map((env) => env.id)
    for (const id of pair) if (!ids.includes(id)) fail(`No environment "${id}" on this board. Environments: ${ids.join(', ')}`)
  }
  return pair
}

function viewportFlag(value, names) {
  if (value === undefined) return null
  const name = String(value)
  if (name !== 'all' && names && !names.includes(name))
    fail(`No viewport "${name}" on this board. Viewports: ${[...names, 'all'].join(', ')}`)
  return name
}

// What to link to, from the flags and what the board knows.
// `pages`: [{ id, title, viewports? }]; `viewports`: names or null (unknown);
// `environments`: [{ id }] or null; `lookupComment(n)`: { pageId, viewport } or throws.
async function target(flags, { board, pages, viewports, environments, lookupComment }) {
  let page = flags.page !== undefined ? findPage(pages, flags.page) : null
  const comment = commentFlag(flags.comment)
  let viewport = viewportFlag(flags.viewport, viewports)
  const compare = compareFlag(flags.compare, environments)
  if (comment) {
    const found = await lookupComment(comment)
    // The comment's own screen size, unless one was asked for.
    viewport ||= found.viewport || null
    // Its page, when a before and after needs one.
    if (!page && compare === true) page = pages.find((item) => item.id === found.pageId) || { id: found.pageId }
  }
  if (compare === true && !page) fail('--compare without a pair shows a page before and after: add --page ID or --comment N.')
  return {
    board,
    page: page?.id || null,
    comment,
    viewport,
    compare,
    // A link to a comment shows every state, so a resolved one is visible.
    filter: comment ? 'all' : null,
  }
}

const linkOf = (base, item) =>
  boardLink({
    base,
    board: item.board,
    page: item.page ?? undefined,
    comment: item.comment ?? undefined,
    viewport: item.viewport ?? undefined,
    compare: item.compare ?? undefined,
    filter: item.filter ?? undefined,
  })

async function localTarget(flags) {
  const config = loadConfig(flags.config)
  const board = flags.board === undefined ? config.boards[0] : config.boards.find((item) => item.id === flags.board)
  if (!board) fail(`No board "${flags.board}". Boards: ${config.boards.map((item) => item.id).join(', ')}`)
  const item = await target(flags, {
    board: board.id,
    pages: board.pages,
    viewports: Object.keys(boardViewports(config, board)),
    environments: board.environments || null,
    lookupComment: (n) => {
      try {
        return getComment(config, board.id, n)
      } catch {
        return fail(`No comment #${n} on board "${board.id}".`)
      }
    },
  })
  const base = localBoardBase(config)
  return { item, base: base.url, running: base.running }
}

async function remoteTarget(flags) {
  const { createRemote, remoteSettings } = await import('../remote/remote.js')
  const remote = createRemote(remoteSettings(flags))
  const project = await remote.project()
  const boards = (project.boards || []).map((row) => row.id)
  if (!boards.length) fail('Nothing is pushed to this project yet: run shapewall push --remote first.')
  const board = flags.board === undefined ? boards[0] : boards.find((id) => id === flags.board)
  if (!board) fail(`No board "${flags.board}" in this project. Boards: ${boards.join(', ')}`)
  const needsPages = flags.page !== undefined
  const pages = needsPages ? (await remote.pages(board)).pages || [] : []
  const viewports = needsPages ? [...new Set(pages.flatMap((page) => page.viewports || []))] : null
  // A hosted board has one environment: there is nothing to put side by side.
  if (flags.compare !== undefined && flags.compare !== true)
    fail('A hosted board has one environment: use --compare alone for before and after.')
  const item = await target(flags, {
    board,
    pages,
    viewports: viewports?.length ? viewports : null,
    environments: null,
    lookupComment: async (n) => {
      try {
        const answer = await remote.comment(board, n, { guests: Boolean(flags['include-guests']) })
        // The token API's comment: { page: { id }, variant: { pageId }, viewport: { name } }.
        const found = answer?.comment || {}
        return { pageId: found.page?.id || found.variant?.pageId || null, viewport: found.viewport?.name || null }
      } catch (error) {
        if (error?.status === 404) return fail(`No comment #${n} on board "${board}" (a share link guest's needs --include-guests).`)
        throw error
      }
    },
  })
  return { item, base: hostedBoardBase(remote.origin, project.workspace.id, project.project.id), running: true }
}

// Exit code 0 whenever a link was made, even for a local board no server is
// running for: the link is right, it only needs `shapewall serve`.
export async function openCommand(flags, out, { open = openBrowser } = {}) {
  const remote = flags.remote !== undefined
  const { item, base, running } = remote ? await remoteTarget(flags) : await localTarget(flags)
  const url = linkOf(base, item)
  if (flags.json) {
    out(
      JSON.stringify({
        url,
        board: item.board,
        page: item.page,
        comment: item.comment,
        viewport: item.viewport,
        compare: Array.isArray(item.compare) ? item.compare.join('_') : item.compare || null,
        running: running !== false,
      }),
    )
    return 0
  }
  out(url)
  if (running === false) {
    out('No board is running for this project: start it with shapewall serve, then open the link.')
    return 0
  }
  if (!flags.print) open(url, out)
  return 0
}
