// `shapewall mcp --remote`: the MCP server (stdio) for a hosted board. Same
// tools as the local one (src/mcp.js), going through the token API. Tools
// that write are listed only when the token has the scope for them
// (add_comment and reply_to_comment: "reply").
//
// recapture_pages is offered only when the server is started in a project
// folder (a shapewall.config.json, or --config FILE), without --read-only or
// --no-capture, and the token has the "push" scope. The hosted server never
// captures: the tool captures the pages on this machine, the same way the
// local tool does, then pushes only those pages' new captures to the hosted
// board (a page push, src/hosted/push.js), so pages another machine pushed
// meanwhile are never put back. Only a board whose id is in the config is
// pushed. The server built for a hosted board's
// own MCP endpoint (src/hosted/mcp-http.js) has no config, so never offers it.

import fs from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'
import { parseElementMap } from '../capture/element-map.js'
import { SELECTORS_MAX, selectorPin, selectorsOnMap } from '../comments-cli.js'
import { remoteBoardRef, untrustedJson } from '../feedback.js'
import { sniffImage } from '../image-sniff.js'
import { cropArg, pageCaptureDescription, pageCaptureResult } from '../page-capture.js'
import { cropAround } from '../png.js'
import { AGENT_STATUSES, STORED_AGENT_STATUSES, readManifest } from '../store.js'
import { boardLink, hostedBoardBase } from '../board-links.js'
import { ambiguousPage, authorFilter, filterArgs, narrowComments, pageByName, statedFilters, timeRange } from '../comment-filters.js'
import {
  captureHistory,
  COMPARE_MAX_PIXELS,
  compareDescription,
  compareImages,
  compareResult,
  pickPair,
  versionArg,
} from '../compare-captures.js'
import { mcpInstructions } from '../mcp-instructions.js'
import { createIssue, engineGithubStore, githubSettings, linkPull } from '../github.js'
import { pushPages } from './cli.js'
import { REMOTE_HEARTBEAT_MS } from './remote-watch.js'
import { terminalSafe } from './terminal.js'

// How long `mcp --remote` keeps one comment's claim alive without the agent
// finishing it (docs/hosted.md, "A claim has a heartbeat").
export const MAX_HOLD_MS = 60 * 60_000

const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
// A refusal from the server says what it is: "invalid_transition: A resolved
// comment cannot ..." (as the error code an agent can act on, then the message).
const tool = (handler) => async (args) => {
  try {
    return await handler(args || {})
  } catch (error) {
    const code = typeof error?.code === 'string' && error.status >= 400 && error.status < 500 ? `${error.code}: ` : ''
    return { content: [{ type: 'text', text: `${code}${error.message || String(error)}` }], isError: true }
  }
}

// Page ids of a hosted journey: every page on any branch (pages), else the
// steps flattened through forks, for a server that sends no pages.
export function remoteJourneyPages(journey) {
  if (Array.isArray(journey?.pages)) return new Set(journey.pages)
  const ids = new Set()
  const walk = (steps) => {
    for (const step of steps || []) {
      if (typeof step === 'string') ids.add(step)
      else if (step && Array.isArray(step.branches)) for (const branch of step.branches) walk(branch.steps)
    }
  }
  walk(journey?.steps)
  return ids
}

// The media types get_comment hands the model, by what the bytes are.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

// createRemoteMcpServer({ remote }) returns an McpServer (not connected).
// config: the local project (loadConfig), for recapture_pages; allowCapture:
// false drops that tool (--no-capture). capture and push are the capture run
// and the board upload (tests stub them); log gets their progress lines.
// board (--board): the board a tool works on when it names none (default:
// the first pushed one).
export async function createRemoteMcpServer({
  remote,
  readOnly = false,
  board: defaultBoard = null,
  heartbeatMs = REMOTE_HEARTBEAT_MS,
  maxHoldMs = MAX_HOLD_MS,
  config = null,
  allowCapture = true,
  capture = null,
  push = null,
  // `shapewall mcp` in a project whose solo engine runs (src/cli/engine-mode.js): add_comment and
  // reply_to_comment take the 1.x `author` argument (src/mcp.js), the label of the agent's text there.
  localAuthor = false,
  log = () => {},
  // The hosted server's own /mcp endpoint (src/hosted/mcp-http.js): it never
  // captures, so its instructions point at `mcp --remote` for the hand-in.
  hostedEndpoint = false,
  // How compare_captures decodes: { maxPixels, fit, run } from the hosted
  // endpoint (src/hosted/mcp-http.js: worker threads, one compare per
  // token); null decodes here, as `mcp --remote` on a person's machine does.
  compare = null,
  // The clock "today" is read from (tests set it).
  now = () => Date.now(),
  // For the GitHub tools on the solo engine (localAuthor): the GitHub token is read here (GITHUB_TOKEN), never sent to the engine.
  env = process.env,
  fetchImpl = undefined,
}) {
  const project = await remote.project()
  const scopes = new Set(project.token.scopes.flatMap((scope) => (scope === 'comment' ? ['reply', 'status'] : [scope])))
  if (!scopes.has('read')) throw new Error('The token needs the "read" scope for MCP.')
  const boardIds = project.boards.map((item) => item.id)
  if (defaultBoard && !boardIds.includes(defaultBoard))
    throw new Error(
      `No board "${defaultBoard}" on ${terminalSafe(project.project?.name || 'this project')} (have: ${boardIds.join(', ') || 'none'}).`,
    )
  const firstBoard = defaultBoard || boardIds[0]
  const canRecapture = Boolean(config) && allowCapture && !readOnly && scopes.has('push')
  // `shapewall mcp` on the solo engine (2.0.0): create_github_issue and
  // link_pull_request, as the 1.x MCP had them. This process asks GitHub with
  // this machine's token and the engine records the link (engineGithubStore,
  // src/github.js); the engine's own /mcp and a team server never offer them.
  const canGithub = Boolean(config) && localAuthor && !readOnly && Boolean(githubSettings(config, env).repo)
  const server = new McpServer(
    { name: 'shapewall', version: VERSION },
    {
      instructions: mcpInstructions({
        handIn: canRecapture ? 'remote' : hostedEndpoint ? 'hosted' : 'push',
        hosted: true,
        github: canGithub,
      }),
    },
  )
  // Links into the hosted board, built from the project's ids on this
  // server's origin (never from a URL in an answer).
  let linkBase = null
  try {
    linkBase = hostedBoardBase(remote.origin, project.workspace?.id, project.project?.id)
  } catch {
    linkBase = null
  }
  const link = (options) => {
    if (!linkBase) return null
    try {
      return boardLink({ base: linkBase, ...options })
    } catch {
      return null
    }
  }
  const links = {
    comment: (boardId, item) =>
      link({ board: boardId, comment: item.id, viewport: item.viewport?.name, ...(item.status === 'resolved' ? { filter: 'all' } : {}) }),
    page: (boardId, pageId) => link({ board: boardId, page: pageId }),
    compare: (boardId, pageId, viewport) => link({ board: boardId, page: pageId, viewport, compare: true }),
  }
  // "me": the account that made this token (the server says who, 1.3.0 and later).
  const maker = project.token?.createdBy
  const me = maker?.handle
    ? { names: [], handles: [maker.handle], label: maker.name || maker.handle }
    : {
        names: [],
        handles: [],
        why: 'This server does not say whose token this is. Pass the @handle or display name the comments are signed with.',
      }
  // The comments this server took (queued or working). A hosted claim ends
  // when its token has not called for 10 minutes (src/hosted/claim-sweep.js),
  // and an agent can work longer than that between tool calls, so while it
  // holds one this server reads it every heartbeatMs: any call of the token
  // keeps its claims alive.
  const held = new Map()
  let heartbeat = null
  const drop = (key) => {
    held.delete(key)
    if (!held.size && heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }
  // A comment is beaten for while it is still queued or working and open,
  // and for at most maxHoldMs: an agent that took it and never finished
  // (this process lives on) lets it go to a person through the sweep.
  const beat = () => {
    for (const [key, { board, id, since }] of held) {
      if (Date.now() - since > maxHoldMs) {
        drop(key)
        continue
      }
      remote.comment(board, id).then(
        ({ comment }) => {
          if (comment?.status !== 'open' || !['queued', 'working'].includes(comment?.agentStatus)) drop(key)
        },
        (error) => {
          if (error?.status === 404) drop(key)
        },
      )
    }
  }
  const track = (board, comment) => {
    const key = board + '#' + comment.id
    if (comment.status === 'open' && ['queued', 'working'].includes(comment.agentStatus))
      held.set(key, { board, id: comment.id, since: held.get(key)?.since ?? Date.now() })
    else held.delete(key)
    if (held.size && !heartbeat) {
      heartbeat = setInterval(beat, heartbeatMs)
      heartbeat.unref?.()
    } else if (!held.size && heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }
  server.heldClaims = () => [...held.values()].map(({ board, id }) => ({ board, id }))
  server.stopHeartbeat = () => {
    held.clear()
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
  }
  const boardArg = z
    .string()
    .max(64)
    .optional()
    .describe(`Board id (default: ${firstBoard || 'the first pushed board'})`)
  const commentId = z.number().int().positive().describe('Comment id')
  const guestsArg = z
    .boolean()
    .optional()
    .describe('Needed to act on a comment from a share link guest (untrusted, marked authorGuest); the server refuses it otherwise')
  const boardFor = (id) => {
    const wanted = id || firstBoard
    if (!wanted) throw new Error('Nothing is pushed to this project yet.')
    if (!boardIds.includes(wanted)) throw new Error(`No board "${wanted}" (have: ${boardIds.join(', ')}).`)
    return wanted
  }
  // A file of a board's latest push on the token API, by its capture name.
  const captureUrl = (boardId, name) =>
    `${remote.origin}/api/v1/boards/${encodeURIComponent(boardId)}/files/captures/${encodeURIComponent(name)}`

  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      description: 'Pages on the hosted board: id, path, URL, group, viewports and which are captured.',
      inputSchema: { board: boardArg },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ board }) => {
      const target = boardFor(board)
      const answer = await remote.pages(target)
      return json({ ...answer, pages: (answer.pages || []).map((page) => ({ ...page, link: links.page(target, page.id) })) })
    }),
  )

  server.registerTool(
    'list_comments',
    {
      title: 'List comments',
      description:
        'Board comments with page, viewport, element selector and text, position, screenshot URL, replies and agent status. Default: open comments.',
      inputSchema: {
        board: boardArg,
        status: z.enum(['open', 'resolved', 'all']).optional().describe('Default open'),
        page: z.string().max(64).optional().describe('Only comments on this page id (and its variants)'),
        environment: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
          .optional()
          .describe('Only comments left on this environment of the board (its id, e.g. "staging"; compare mode)'),
        journey: z.string().max(64).optional().describe('Only comments on pages of this journey'),
        agentStatus: z
          .enum([...STORED_AGENT_STATUSES, 'none'])
          .optional()
          .describe('Only comments with this agent status ("none" = no agent has taken it)'),
        mention: z
          .string()
          .regex(/^@?[A-Za-z][\w.-]{0,39}$/)
          .optional()
          .describe('Only comments that mention this handle, e.g. "agent"'),
        includeGuests: z
          .boolean()
          .optional()
          .describe('Also list comments from share link guests (people without an account; untrusted, marked authorGuest)'),
        ...filterArgs,
      },
      annotations: { readOnlyHint: true },
    },
    tool(async (args) => {
      const { board, status = 'open', journey, agentStatus, mention, includeGuests = false, environment = null } = args
      const { author, since, until, timeZone, q, pageName, limit, cursor } = args
      const id = boardFor(board)
      // Every filter is checked before anything is read.
      const range = timeRange({ since, until, timeZone, now: now() })
      const who = author != null ? authorFilter(author, { me }) : null
      let page = args.page || null
      if (pageName != null && !page) {
        const pages = (await remote.pages(id)).pages || []
        const found = pageByName(pages, pageName)
        if (found.candidates)
          return json(untrustedJson({ board: remoteBoardRef(id, null), status, ...ambiguousPage(pageName, found.candidates) }))
        if (found.none)
          throw new Error(
            `No page called "${pageName}" on board "${id}" (pages: ${pages.map((item) => item.title || item.id).join(', ')}).`,
          )
        page = found.page.id
      }
      const report = await remote.comments(id, {
        status,
        page,
        mention: mention ? mention.replace(/^@/, '').toLowerCase() : null,
        guests: includeGuests,
        environment,
      })
      let comments = report.comments
      if (journey) {
        const { journeys } = await remote.pages(id)
        const found = journeys.find((item) => item.id === journey)
        if (!found) throw new Error(`No journey "${journey}" on board "${id}".`)
        const ids = remoteJourneyPages(found)
        comments = comments.filter((item) => ids.has(item.page?.id || item.variant?.pageId))
      }
      if (agentStatus) comments = comments.filter((item) => (item.agentStatus || 'none') === agentStatus)
      const listed = narrowComments(comments, { author: who, range, q: q ?? null, limit, cursor: cursor ?? null })
      return json(
        untrustedJson({
          ...report,
          ...statedFilters({ author: who, range, q, page, pageName }),
          total: listed.total,
          count: listed.comments.length,
          nextCursor: listed.nextCursor,
          comments: listed.comments.map((item) => ({ ...item, link: links.comment(id, item) })),
        }),
      )
    }),
  )

  server.registerTool(
    'get_comment',
    {
      title: 'Get a comment',
      description:
        'One comment with everything needed to act on it, plus the screenshot around the pin as an image ("full" for the whole capture, "none" for no image).',
      inputSchema: {
        board: boardArg,
        id: commentId,
        image: z.enum(['crop', 'full', 'none']).optional().describe('Default crop'),
        includeGuests: guestsArg,
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ board, id, image = 'crop', includeGuests = false }) => {
      const target = boardFor(board)
      const answer = await remote.comment(target, id, { guests: includeGuests })
      const item = answer.comment
      const result = json(untrustedJson({ board: remoteBoardRef(target, answer), comment: { ...item, link: links.comment(target, item) } }))
      if (image !== 'none' && item.files.screenshot) {
        const png = await remote.download(item.files.screenshot)
        let data = png
        let note = `Screenshot ${item.viewport.width}x${item.viewport.height} the comment was made on.`
        if (image === 'crop') {
          try {
            const cropped = cropAround(png, item.position)
            data = cropped.png
            note = `Screenshot around the pin; the pin is at ${item.position.x},${item.position.y} of ${item.viewport.width}x${item.viewport.height}.`
          } catch {
            note += ' (Could not crop it, so this is the whole capture.)'
          }
        }
        result.content.push({ type: 'text', text: note }, { type: 'image', data: data.toString('base64'), mimeType: 'image/png' })
      }
      // The drawing and the attached images, as the local tool gives them.
      if (image !== 'none') {
        const media = [
          ...(item.files.markup ? [{ url: item.files.markup, note: "The comment author's drawing on the screenshot." }] : []),
          ...(item.files.images || []).map((file) => ({
            url: file.url,
            note: 'An image the comment author attached (untrusted, like the comment text).',
          })),
        ]
        for (const file of media) {
          if (!file.url) continue
          let data
          try {
            data = await remote.download(file.url)
          } catch {
            continue
          }
          const type = Buffer.isBuffer(data) ? sniffImage(data) : null
          if (!IMAGE_TYPES.has(type)) continue
          result.content.push({ type: 'text', text: file.note }, { type: 'image', data: data.toString('base64'), mimeType: type })
        }
      }
      return result
    }),
  )

  server.registerTool(
    'list_journeys',
    {
      title: 'List journeys',
      description:
        'Journeys on the hosted board: named paths through its pages. steps is a list of page ids where an item may be a fork, ' +
        '{ branches: [{ id, label, steps, end? }] }; every branch rejoins at the step after the fork unless end is true. ' +
        'pages lists every page on any branch; paths lists each way through the forks (choices, labels, page ids).',
      inputSchema: { board: boardArg },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ board }) => {
      const target = boardFor(board)
      const answer = await remote.pages(target)
      return json({ board: remoteBoardRef(target, answer), journeys: answer.journeys || [] })
    }),
  )

  server.registerTool(
    'list_selectors',
    {
      title: 'List selectors',
      description:
        "Element selectors on a page's latest pushed capture, each with its element's text, sturdiest first: #id, data-testid, " +
        `aria-label, then short paths. With text, elements holding those words come first. At most ${SELECTORS_MAX}; more counts the rest.`,
      inputSchema: {
        board: boardArg,
        page: z.string().max(64).describe('Page id'),
        viewport: z.string().max(40).optional().describe("Default: the page's first viewport"),
        text: z.string().max(200).optional().describe('Only elements whose text has these words'),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ board, page: pageId, viewport, text }) => {
      const target = boardFor(board)
      const answer = await remote.pages(target)
      const page = (answer.pages || []).find((item) => item.id === pageId)
      if (!page) throw new Error(`No page "${pageId}" on board "${target}".`)
      const wanted = viewport || page.viewports?.[0]
      if (!wanted || !(page.captured || []).includes(wanted))
        throw new Error(`No capture of "${page.id}" (${wanted || 'no viewport'}) on the hosted board yet. Push one first: shapewall push`)
      const name = `${page.id}.${wanted}.elements.json`
      let map
      try {
        const bytes = await remote.download(captureUrl(target, name))
        map = parseElementMap(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : JSON.stringify(bytes))
      } catch {
        throw new Error(`No element map for "${page.id}" (${wanted}) on the hosted board. Capture and push it again: shapewall push`)
      }
      const { rows, more } = selectorsOnMap(map, { text: text || '' })
      return json(untrustedJson({ board: remoteBoardRef(target, answer), page: page.id, viewport: wanted, selectors: rows, more }))
    }),
  )

  server.registerTool(
    'get_page_capture',
    {
      title: 'Get a page capture',
      description: pageCaptureDescription.replace('current capture', 'current capture on the hosted board'),
      inputSchema: {
        board: boardArg,
        page: z.string().max(64).describe('Page id'),
        viewport: z.string().max(40).optional().describe("Default: the page's first viewport"),
        crop: cropArg,
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ board, page: pageId, viewport, crop }) => {
      const target = boardFor(board)
      const answer = await remote.pages(target)
      // Ids only: the page and viewport must be the hosted board's, and the
      // file is fetched by its capture name from this server's token API.
      const page = (answer.pages || []).find((item) => item.id === pageId)
      if (!page) throw new Error(`No page "${pageId}" on board "${target}".`)
      const wanted = viewport || page.viewports?.[0]
      if (!wanted || !(page.viewports || []).includes(wanted))
        throw new Error(`Page "${page.id}" has no viewport "${wanted}" (it has: ${(page.viewports || []).join(', ')}).`)
      if (!(page.captured || []).includes(wanted))
        throw new Error(`No capture of "${page.id}" (${wanted}) on the hosted board yet. Push one first.`)
      const png = await remote.download(captureUrl(target, `${page.id}.${wanted}.png`))
      if (!Buffer.isBuffer(png)) throw new Error(`The capture of "${page.id}" (${wanted}) is not an image.`)
      return pageCaptureResult({
        png,
        board: target,
        page: page.id,
        viewport: wanted,
        // Per page from a server that says it, else the board's newest capture.
        capturedAt: page.capturedAt?.[wanted] || answer.capturedAt || null,
        crop: crop || null,
      })
    }),
  )

  server.registerTool(
    'board_link',
    {
      title: 'Board link',
      description:
        'A link into the hosted board: the board, a page (flown to), a comment (opened), a viewport, a page compare (before and after ' +
        "of its latest recapture), or follow mode (follow: the board follows an agent as it works). Open it in your app's browser pane if it has one; otherwise give it to the person.",
      inputSchema: {
        board: boardArg,
        page: z.string().max(64).optional().describe('Page id'),
        comment: z.number().int().positive().optional().describe('Comment id'),
        viewport: z.string().max(40).optional().describe('Viewport name, or "all"'),
        compare: z.boolean().optional().describe("Open the page's before and after (needs page, or a comment on a page)"),
        follow: z
          .string()
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
          .optional()
          .describe('Follow an agent on the board: "any" (whichever agent works), or one agent\'s id'),
        includeGuests: guestsArg,
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ board, page, comment, viewport, compare = false, follow, includeGuests = false }) => {
      const target = boardFor(board)
      const answer = await remote.pages(target)
      const pages = answer.pages || []
      if (page && !pages.some((item) => item.id === page)) throw new Error(`No page "${page}" on board "${target}".`)
      const viewports = [...new Set(pages.flatMap((item) => item.viewports || []))]
      if (viewport && viewport !== 'all' && !viewports.includes(viewport))
        throw new Error(`No viewport "${viewport}" on board "${target}" (have: ${viewports.join(', ')}).`)
      const item = comment ? (await remote.comment(target, comment, { guests: includeGuests })).comment : null
      const onPage = page || (compare && item?.page?.id ? item.page.id : null)
      if (compare && !onPage) throw new Error('compare needs a page (or a comment on a page).')
      if (!linkBase) throw new Error('This server does not say which workspace the project is in, so there is no link to give.')
      const url = boardLink({
        base: linkBase,
        board: target,
        ...(onPage ? { page: onPage } : {}),
        ...(item ? { comment: item.id } : {}),
        ...(viewport ? { viewport } : {}),
        ...(compare ? { compare: true } : {}),
        ...(follow ? { follow } : {}),
        ...(item?.status === 'resolved' ? { filter: 'all' } : {}),
      })
      return json({
        url,
        board: target,
        page: onPage,
        comment: item ? item.id : null,
        viewport: viewport || null,
        compare,
        follow: follow || null,
        note: "Open this in your app's browser pane if it has one; otherwise give it to the person (they sign in to the hosted board).",
      })
    }),
  )

  server.registerTool(
    'compare_captures',
    {
      title: 'Compare captures',
      description: compareDescription.replace('Two captures', 'Two captures on the hosted board'),
      inputSchema: {
        board: boardArg,
        page: z.string().max(64).describe('Page id'),
        viewport: z.string().max(40).optional().describe("Default: the page's first viewport"),
        before: versionArg('previous'),
        after: versionArg('current'),
        crop: cropArg,
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ board, page: pageId, viewport, before = 'previous', after = 'current', crop }) => {
      const target = boardFor(board)
      const work = async () => {
        let answer
        try {
          answer = await remote.pageVersions(target, pageId, { viewport: viewport || null })
        } catch (error) {
          if (error?.code === 'unknown_page') throw new Error(`No page "${pageId}" on board "${target}".`, { cause: error })
          if (error?.code === 'unknown_viewport') throw new Error(`Page "${pageId}" has no viewport "${viewport}".`, { cause: error })
          if (error?.status === 404)
            throw new Error('This hosted server has no capture history yet (it needs Shapewall 1.3.0 or later).', { cause: error })
          throw error
        }
        const wanted = viewport || answer.viewports?.[0]
        // Ids only: the files are the ones the server lists for this page and
        // viewport, fetched from this server's token API. The current one's
        // URL names its version (?version=): a push that lands between the
        // list and the download is a 409, never an image under the wrong label.
        const rows = (answer.versions || []).filter((row) => row.viewport === wanted)
        const current = rows.find((row) => row.current)?.version || null
        const history = captureHistory(
          current,
          rows.filter((row) => !row.current).map((row) => row.version),
        )
        const pair = pickPair(history, { before, after }, `"${pageId}" (${wanted})`)
        const fetchPng = async (entry) => {
          const row = rows.find((item) => item.version === entry.version && item.current === entry.current)
          let bytes = null
          try {
            bytes = row?.files?.png ? await remote.download(row.files.png) : null
          } catch (error) {
            if (error?.status === 409)
              throw new Error(
                `The current capture of "${pageId}" (${wanted}) changed while comparing (a push landed). Call compare_captures again.`,
                { cause: error },
              )
            throw error
          }
          if (!Buffer.isBuffer(bytes)) throw new Error(`The capture ${entry.version} of "${pageId}" (${wanted}) is not an image.`)
          return bytes
        }
        const beforePng = await fetchPng(pair.before)
        const afterPng = await fetchPng(pair.after)
        let compared
        try {
          compared = await compareImages({
            beforePng,
            afterPng,
            crop: crop || null,
            maxPixels: compare?.maxPixels ?? COMPARE_MAX_PIXELS,
            fit: compare?.fit || null,
          })
        } catch (error) {
          throw new Error(`"${pageId}" (${wanted}): ${error.message}`, { cause: error })
        }
        return compareResult({
          compared,
          board: target,
          page: pageId,
          viewport: wanted,
          pair,
          crop: crop || null,
          link: links.compare(target, pageId, wanted),
          versions: history,
        })
      }
      return compare ? compare.run(work) : work()
    }),
  )

  // The 1.x local argument, on the solo engine only (same words as src/mcp.js).
  const authorArg = localAuthor
    ? { author: z.string().max(60).optional().describe('Display name for an external agent. Board agents use their configured name.') }
    : {}
  if (!readOnly && scopes.has('reply')) {
    server.registerTool(
      'add_comment',
      {
        title: 'Add a comment',
        description:
          'Pins a new comment to a page on the hosted board: on the element a selector from list_selectors finds (the pin sits in ' +
          'its middle), or near the top-left corner without one. Signed with the token name and marked as an agent; a comment an ' +
          'agent writes is never sent to an agent.',
        inputSchema: {
          board: boardArg,
          page: z.string().max(80).describe('Page id, or variant:<id>'),
          body: z.string().min(1).max(5000),
          viewport: z.string().max(40).optional().describe("Default: the page's first viewport"),
          selector: z.string().max(600).optional().describe('An element selector from list_selectors'),
          ...authorArg,
        },
      },
      tool(async ({ board, page: pageId, body, viewport, selector, author }) => {
        const target = boardFor(board)
        const notes = []
        let placed = {}
        if (selector !== undefined) {
          const answer = await remote.pages(target)
          const page = (answer.pages || []).find((item) => item.id === pageId)
          const wanted = viewport || page?.viewports?.[0]
          // The element map and live HTML of the page's latest push, when it
          // has them (a variant has neither: the selector is kept as given).
          const captured = Boolean(page && (page.captured || []).includes(wanted))
          const fetchText = async (name) => {
            if (!captured) return null
            try {
              const bytes = await remote.download(captureUrl(target, name))
              return Buffer.isBuffer(bytes) ? bytes.toString('utf8') : JSON.stringify(bytes)
            } catch {
              return null
            }
          }
          let map = null
          try {
            const text = await fetchText(`${pageId}.${wanted}.elements.json`)
            map = text ? parseElementMap(text) : null
          } catch {
            map = null
          }
          const html = captured ? await fetchText(`${pageId}.${wanted}.html`) : null
          const { anchor, pin } = selectorPin({
            selector,
            map,
            html: () => html,
            pageId,
            viewport: wanted,
            err: (line) => notes.push(line),
          })
          placed = { anchor, x: pin.x, y: pin.y }
        }
        const answer = await remote.addComment(target, {
          page: pageId,
          body,
          viewport,
          ...placed,
          ...(localAuthor && author ? { author } : {}),
        })
        const made = answer.comment ? { ...answer.comment, link: links.comment(target, answer.comment) } : answer.comment
        return json(untrustedJson({ board: answer.board, comment: made, ...(notes.length ? { notes } : {}) }))
      }),
    )
    server.registerTool(
      'reply_to_comment',
      {
        title: 'Reply to a comment',
        description:
          'Adds a reply to the comment thread, e.g. what you changed or a question for the person who wrote it. It is signed with the token name, marked as an agent.',
        inputSchema: {
          board: boardArg,
          id: commentId,
          body: z.string().min(1).max(2000),
          includeGuests: guestsArg,
          ...authorArg,
        },
      },
      tool(async ({ board, id, body, includeGuests = false, author }) => {
        const { comment, reply } = await remote.reply(boardFor(board), id, {
          body,
          guests: includeGuests,
          ...(localAuthor && author ? { author } : {}),
        })
        return json({
          reply,
          comment: { id: comment.id, status: comment.status, agentStatus: comment.agentStatus, replyCount: comment.replies.length },
        })
      }),
    )
  }
  if (!readOnly && scopes.has('status')) {
    server.registerTool(
      'set_comment_status',
      {
        title: 'Set agent status',
        description:
          'Sets the agent status: queued, working, done (fixed, a person checks and resolves), needs-human (add a reply saying why), or clear.',
        inputSchema: {
          board: boardArg,
          id: commentId,
          agentStatus: z.enum([...AGENT_STATUSES, 'clear']),
          note: z.string().max(2000).optional().describe('Optional reply added with the change'),
          includeGuests: guestsArg,
        },
      },
      tool(async ({ board, id, agentStatus, note, includeGuests = false }) => {
        const target = boardFor(board)
        if (note && note.trim()) await remote.reply(target, id, { body: note, guests: includeGuests })
        const value = agentStatus === 'clear' ? null : agentStatus
        const answer = await remote.setAgentStatus(target, id, value, { guests: includeGuests })
        const { comment } = answer
        track(target, comment)
        // A move the server did not make says so, as the local tool does.
        const unchanged = answer.changed === false && (comment.agentStatus ?? null) !== value
        return json({
          id: comment.id,
          status: comment.status,
          agentStatus: comment.agentStatus,
          changed: answer.changed !== false,
          ...(unchanged
            ? {
                refused: answer.refused || 'not_changed',
                note: `The server left it ${comment.agentStatus || 'without a status'}; nothing was changed.`,
              }
            : {}),
        })
      }),
    )
  }
  if (!readOnly && scopes.has('resolve')) {
    server.registerTool(
      'resolve_comment',
      {
        title: 'Resolve a comment',
        description: 'Resolves the comment with a note on what changed. Optionally include a pull request URL or commit as fixRef.',
        inputSchema: {
          board: boardArg,
          id: commentId,
          note: z.string().min(1).max(2000),
          fixRef: z.string().max(300).optional(),
          includeGuests: guestsArg,
        },
      },
      tool(async ({ board, id, note, fixRef, includeGuests = false }) => {
        const target = boardFor(board)
        const { comment } = await remote.resolve(target, id, {
          note,
          fixRef,
          ...(scopes.has('status') ? { agentStatus: 'done' } : {}),
          guests: includeGuests,
        })
        track(target, comment)
        return json({
          id: comment.id,
          status: comment.status,
          resolution: comment.resolution,
          agentStatus: comment.agentStatus,
          fixRef: comment.fixRef || null,
        })
      }),
    )
  }
  if (canGithub) {
    // Never a share link guest's comment (C R1-1): the agent gets guest_comment; the owner files those with shapewall github.
    const store = engineGithubStore(remote, config, { guests: false })
    if (scopes.has('reply'))
      server.registerTool(
        'create_github_issue',
        {
          title: 'Create a GitHub issue',
          description:
            'Opens an issue in the configured GitHub repo from a comment (text, page URL, element and a link back to the board) and records it on the comment. Returns the existing issue if the comment has one.',
          inputSchema: { board: boardArg, id: commentId },
        },
        tool(async ({ board, id }) => {
          const { issue, created } = await createIssue(config, { boardId: boardFor(board), commentId: id, env, fetchImpl, store })
          return json({ id, issue, created })
        }),
      )
    if (scopes.has('resolve'))
      server.registerTool(
        'link_pull_request',
        {
          title: 'Link a pull request',
          description:
            'Links a pull request of the configured repo to a comment. When that pull request has merged, the comment is resolved with it as the fix. ' +
            'Tip: put "shapewall:<id>" in the PR description and `shapewall github sync` (or the webhook) links it by itself.',
          inputSchema: {
            board: boardArg,
            id: commentId,
            pr: z.string().min(1).max(300).describe('Pull request number (12 or #12) or its URL'),
          },
        },
        tool(async ({ board, id, pr }) => {
          const { comment, pull, merged } = await linkPull(config, { boardId: boardFor(board), commentId: id, pr, env, fetchImpl, store })
          return json({ id: comment.id, status: comment.status, pull, merged })
        }),
      )
  }

  if (canRecapture) {
    // One capture and push at a time from this server, so pushes land in the
    // order their captures ran. The capture itself holds the board-job lock
    // like every local capture (a busy board is refused, as locally).
    let queue = Promise.resolve()
    const serial = (work) => {
      const run = queue.then(work, work)
      queue = run.catch(() => {})
      return run
    }
    server.registerTool(
      'recapture_pages',
      {
        title: 'Recapture pages',
        description:
          'Captures these pages again on this machine (every viewport, screenshot and live HTML) from the board baseUrl in the local ' +
          'shapewall.config.json, then pushes only those new captures to the hosted board, so it shows the new version. Every other page there ' +
          'is left as it is. Returns when both are done.',
        inputSchema: { board: boardArg, pageIds: z.array(z.string().max(64)).min(1).max(100) },
      },
      tool(async ({ board, pageIds }) => {
        const target = boardFor(board)
        // The hosted board must be a board of this project's config, by id:
        // anything else would push this machine's captures to the wrong board.
        const local = config.boards.find((item) => item.id === target)
        if (!local)
          throw new Error(
            `The hosted board "${target}" is not a board in the local config (it has: ${config.boards
              .map((item) => item.id)
              .join(', ')}). recapture_pages pushes only to the hosted board with the same id; nothing was captured or pushed.`,
          )
        const ids = [...new Set(pageIds)]
        const unknown = ids.filter((id) => !local.pages.some((page) => page.id === id))
        if (unknown.length) throw new Error(`No page ${unknown.map((id) => `"${id}"`).join(', ')} on board "${local.id}".`)
        return serial(async () => {
          const lines = []
          const note = (line) => {
            lines.push(line)
            log(line)
          }
          const run = capture || (await import('../capture/capture.js')).runCapture
          const result = await run({ config, boardId: local.id, only: ids, log: note })
          const manifest = readManifest(config, local.id)
          const pages = Object.fromEntries(
            ids.map((id) => [
              id,
              Object.fromEntries(
                Object.entries(manifest?.pages?.[id] || {}).map(([viewport, entry]) => [
                  viewport,
                  entry?.status === 'ok' ? 'ok' : String(entry?.error || 'failed').slice(0, 200),
                ]),
              ),
            ]),
          )
          // Nothing new to show when every shot failed: the hosted board keeps
          // what it has rather than getting a board of failed shots.
          const landed = Object.values(pages).some((viewports) => Object.values(viewports).includes('ok'))
          let pushed
          if (!landed) pushed = { ok: false, error: 'No page was captured, so nothing was pushed.' }
          else {
            try {
              // Only the viewports captured now go up (a page push): every
              // other page on the hosted board stays as it is there, and the
              // server refuses (stale_capture) if it has a newer capture.
              const fresh = Object.fromEntries(
                Object.entries(pages)
                  .map(([id, viewports]) => [id, Object.keys(viewports).filter((viewport) => viewports[viewport] === 'ok')])
                  .filter(([, viewports]) => viewports.length),
              )
              const answer = await (push || pushPages)({ config, board: local, remote, pages: fresh, out: note })
              pushed = { ok: true, files: answer.files, pages: answer.sent || fresh, url: answer.url }
            } catch (error) {
              const code = typeof error?.code === 'string' && error.status >= 400 && error.status < 500 ? `${error.code}: ` : ''
              pushed = { ok: false, error: `${code}${error.message || String(error)}` }
            }
          }
          // Where to look at each new capture against the one before it.
          const compare = pushed.ok
            ? Object.entries(pages).flatMap(([id, viewports]) =>
                Object.entries(viewports)
                  .filter(([, state]) => state === 'ok')
                  .map(([viewport]) => ({ page: id, viewport, link: links.compare(target, id, viewport) })),
              )
            : []
          return json({
            ok: result.ok && pushed.ok,
            shots: result.total,
            failed: result.failed,
            compare,
            pages,
            pushed,
            log: lines.slice(-20),
          })
        })
      }),
    )
  }
  return server
}

export async function runRemoteMcp({ remote, readOnly = false, board = null, config = null, allowCapture = true, localAuthor = false }) {
  let interrupted = false
  let wake = null
  const onSignal = () => {
    interrupted = true
    wake?.()
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  let server = null
  let transport = null
  try {
    server = await createRemoteMcpServer({
      remote,
      readOnly,
      board,
      config,
      allowCapture,
      localAuthor,
      // stdout is the protocol; progress goes to stderr, cleaned (push lines hold the server's URL).
      log: (line) => process.stderr.write(`${terminalSafe(line)}\n`),
    })
    if (interrupted) return
    transport = new StdioServerTransport()
    await server.connect(transport)
    if (!interrupted) {
      await new Promise((resolve) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          process.stdin.off('end', done)
          resolve()
        }
        wake = done
        server.server.onclose = done
        process.stdin.once('end', done)
      })
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    server?.stopHeartbeat()
    await transport?.close?.().catch(() => {})
    process.stdin.pause()
  }
}
