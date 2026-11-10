// The board API's data: which project the board shows and as whom, the
// export's views (moved onto the state's clock), and comments as people see them.

import { GUEST_SHARE, guestView } from '../../../../src/hosted/guest-view.js'
import { commentMentions, handleFor } from '../../../../src/mentions.js'
import { publicReactions } from '../../../../src/reactions.js'
import { checkSteps, isBranching, journeyPages, journeyPaths, pruneSteps, resolvePath } from '../../../../src/journey-paths.js'
import { EXPORT_AGENT, EXPORT_AUTHORS, websiteComments } from '../fixtures.js'
import { fail } from './util.js'

export function boardData(ctx) {
  const { state, loadJson, now, location, roleOf, me, guestShare, shareUsableNow } = ctx

  // ---- The board API (the project in the page URL, or the guest's link) ----

  // Which project the board shows, and as whom.
  function boardAccess() {
    if (state.viewAs === 'guest') {
      const share = guestShare()
      if (!shareUsableNow(share)) fail(401, 'share_ended', 'This share link has ended or needs to be opened again.')
      const project = state.projects.find((item) => item.id === share.projectId) || fail(401, 'share_ended', 'This share link has ended.')
      return { project, role: 'guest', share, user: null }
    }
    const user = me() || fail(401, 'signed_out', 'Sign in first.')
    const wanted = location.project || null
    const mine = state.projects.filter((item) => roleOf(user.id, item.workspaceId))
    const project = (wanted ? mine.find((item) => item.id === wanted) : mine.find((item) => item.boards.length)) || mine[0]
    if (!project) fail(404, 'unknown_project', 'No such project.')
    return { project, role: roleOf(user.id, project.workspaceId), share: null, user }
  }

  async function exportView(folder) {
    if (!exportViews.has(folder)) {
      const loading = Promise.resolve()
        .then(() => loadJson(`data/boards/${folder}.json`))
        .then(rebase)
      // A failed load is not kept: the next request tries again.
      loading.catch(() => {
        if (exportViews.get(folder) === loading) exportViews.delete(folder)
      })
      exportViews.set(folder, loading)
    }
    return structuredClone(await exportViews.get(folder))
  }

  // The export's times are before a fixed moment (location.fixturesAt). The
  // state was seeded at some real moment, with its own times relative to
  // that (fixtures.js): the export's times move by the same amount
  // (state.timeShift), so captures, comments, invites and the audit log all
  // read from one clock and age together. A visitor's own changes keep
  // their real times.
  const fixturesTime = Date.parse(location.fixturesAt || '')
  const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/
  function rebase(value) {
    const shift = Number(state.timeShift) || 0
    if (!shift || !Number.isFinite(fixturesTime)) return value
    const walk = (item) => {
      if (typeof item === 'string') {
        if (!ISO_TIME.test(item)) return item
        const time = Date.parse(item)
        return time <= fixturesTime ? new Date(time + shift).toISOString() : item
      }
      if (Array.isArray(item)) return item.map(walk)
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]))
      return item
    }
    return walk(value)
  }
  const exportViews = new Map()

  // A board's view: the export's, or part of it for a board made from it.
  async function boardViewOf(project, boardId) {
    const board = project.boards.find((item) => item.id === boardId) || fail(404, 'unknown_board', 'No such board.')
    const view = await exportView(board.folder)
    view.board.id = board.id
    if (board.title) view.board.title = board.title
    if (board.groups) {
      const keep = new Set(view.board.pages.filter((page) => board.groups.includes(page.group)).map((page) => page.id))
      view.board.groups = view.board.groups.filter((group) => board.groups.includes(group))
      view.board.pages = view.board.pages.filter((page) => keep.has(page.id))
      const only = (object) => Object.fromEntries(Object.entries(object || {}).filter(([pageId]) => keep.has(pageId)))
      if (view.manifest?.pages) view.manifest.pages = only(view.manifest.pages)
      view.captures = only(view.captures)
      view.versions = only(view.versions)
      view.links = Object.fromEntries(Object.entries(only(view.links)).map(([pageId, list]) => [pageId, list.filter((id) => keep.has(id))]))
      view.journeys = (view.journeys || []).map((journey) => journeyWithin(journey, keep)).filter(Boolean)
      view.variants = (view.variants || []).filter((variant) => keep.has(variant.pageId))
      // One environment: the second project has no compare data of its own.
      view.environments = (view.environments || []).slice(0, 1)
    }
    view.capture = { running: false, state: 'idle', startedAt: null, finishedAt: null, done: null, total: null, failed: null, error: null }
    view.pushedAt = board.pushedAt
    return view
  }

  // A journey cut down to the pages a board keeps, the way the server reads
  // a stored journey (src/journeys.js storedSteps + withPaths): steps on
  // pages that left are dropped, a fork that no longer holds falls back to
  // its first path, and fewer than two steps left means no journey.
  function journeyWithin(journey, keep) {
    let steps = pruneSteps(journey.steps, keep)
    if (isBranching(steps) && !checkSteps(steps, keep, 'steps', [])) steps = resolvePath(steps).steps.map((step) => step.pageId)
    if (resolvePath(steps).steps.length < 2) return null
    return { ...journey, steps, branching: isBranching(steps), pages: journeyPages(steps), paths: journeyPaths(steps) }
  }

  // The stored comments of a board, seeded from the export on first use.
  async function commentsOf(project, boardId) {
    const key = `${project.id}/${boardId}`
    if (!state.comments[key]) {
      const board = project.boards.find((item) => item.id === boardId) || fail(404, 'unknown_board', 'No such board.')
      let list
      if (board.groups) {
        const view = await boardViewOf(project, boardId)
        list = websiteComments(view.board.pages, Date.parse(state.seededAt) || now())
      } else {
        const data = rebase(await loadJson(`data/boards/${board.folder}/comments.json`))
        list = (Array.isArray(data?.comments) ? data.comments : []).map(fromExport)
      }
      state.comments[key] = { nextId: Math.max(0, ...list.map((item) => item.id)) + 1, list }
    }
    return state.comments[key]
  }
  // An exported comment as a hosted one: people are accounts, the coding
  // agent is a token.
  const handleOf = (name) => EXPORT_AUTHORS[name] || null
  // Reactions by export names become reactions by those accounts.
  const reactionsFromExport = (list) =>
    (Array.isArray(list) ? list : []).map((entry) => ({
      emoji: entry.emoji,
      by: (entry.by || []).map((person) => {
        const handle = handleOf(person.name)
        const user = handle ? state.users.find((item) => item.handle === handle) : null
        return user ? { name: user.displayName, handle: user.handle, user: user.id } : { name: person.name }
      }),
    }))
  function fromExport(comment) {
    const handle = handleOf(comment.author)
    const found = handle ? state.users.find((item) => item.handle === handle) : null
    return {
      ...comment,
      reactions: reactionsFromExport(comment.reactions),
      author: found ? found.displayName : comment.author,
      ...(found ? { authorHandle: found.handle, authorUserId: found.id } : {}),
      ...(comment.author === EXPORT_AGENT ? { authorAgent: true } : {}),
      replies: (comment.replies || []).map((reply) => {
        const replyHandle = handleOf(reply.author)
        const replier = replyHandle ? state.users.find((item) => item.handle === replyHandle) : null
        return {
          ...reply,
          reactions: reactionsFromExport(reply.reactions),
          author: replier ? replier.displayName : reply.author,
          ...(replier ? { handle: replier.handle } : {}),
          ...(reply.author === EXPORT_AGENT ? { agent: true } : {}),
        }
      }),
    }
  }

  // Each person has one handle; "@jo-park" (what Jo Park's name makes) is
  // Jo's alias, so mentions, the mention filter and notifications use "jo".
  function canonicalMentions(list) {
    const aliases = new Map()
    for (const user of state.users) {
      const derived = handleFor(user.displayName)
      if (derived && derived !== user.handle && !state.users.some((other) => other.handle === derived)) aliases.set(derived, user.handle)
    }
    const out = []
    for (const handle of list) {
      const value = aliases.get(handle) || handle
      if (!out.includes(value)) out.push(value)
    }
    return out
  }

  // Who a comment mentions (what a guest wrote mentions nobody).
  const mentionsOf = (comment) =>
    canonicalMentions(
      commentMentions({
        body: comment.authorGuest ? '' : comment.body,
        replies: (comment.replies || []).filter((reply) => !reply.guest),
      }),
    )

  // What the asker sees of a comment: members everything but the internal
  // fields; guests the server's guest view.
  function shown(comment, access) {
    const rest = { ...comment }
    delete rest.authorUserId
    delete rest.shareId
    const replies = (comment.replies || []).map((reply) => {
      const copy = { ...reply, reactions: publicReactions(reply.reactions) }
      delete copy.shareId
      return copy
    })
    const visible = {
      ...rest,
      replies,
      reactions: publicReactions(comment.reactions),
      editedAt: comment.editedAt || null,
      reopenCount: Number(comment.reopenCount) || 0,
      reopenedAt: comment.reopenedAt || null,
      mentions: mentionsOf(comment),
    }
    if (access.role !== 'guest') return visible
    return guestView(
      {
        ...visible,
        [GUEST_SHARE]: { comment: comment.shareId || null, replies: (comment.replies || []).map((reply) => reply.shareId || null) },
      },
      access.share.id,
    )
  }

  const counts = (list) => {
    const result = {}
    for (const comment of list) {
      result[comment.pageId] = result[comment.pageId] || { open: 0, resolved: 0 }
      result[comment.pageId][comment.status] = (result[comment.pageId][comment.status] || 0) + 1
    }
    return result
  }

  return { boardAccess, rebase, boardViewOf, commentsOf, mentionsOf, shown, counts }
}
