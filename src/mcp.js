// `shapewall mcp`: a Model Context Protocol server on stdio, for coding
// agents that prefer tools over shell commands. It exposes the same data as
// `shapewall comments --json` plus replies, agent status, resolve and
// recapture.
//
// Inputs are ids only: comment ids are integers, board and page ids must be
// on the board in the config, and files are found through the same
// allowlisted names the server uses, so no tool can read an arbitrary path.
// stdout belongs to the protocol; progress goes to stderr.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'
import { getBoard, joinUrl } from './config.js'
import { boardRef, commentJson, feedback, feedbackContext, feedbackItem, replyOf, untrustedJson } from './feedback.js'
import { addComment, SELECTORS_MAX, selectorsReport } from './comments-cli.js'
import { createIssue, githubSettings, linkPull } from './github.js'
import { listJourneys } from './journeys.js'
import { readCommentImage } from './comment-media.js'
import { cropAround } from './png.js'
import {
  AGENT_STATUSES,
  STORED_AGENT_STATUSES,
  addReply,
  captureFiles,
  entryVersion,
  getComment,
  listVersions,
  readManifest,
  resolveFile,
  setAgentStatus,
  updateComment,
  versionTime,
} from './store.js'
import { cropArg, pageCaptureDescription, pageCaptureResult } from './page-capture.js'
import { boardLink, localBoardBase } from './board-links.js'
import { ambiguousPage, authorFilter, filterArgs, narrowComments, pageByName, statedFilters, timeRange } from './comment-filters.js'
import { captureHistory, compareDescription, compareResult, pickPair, readPair, versionArg } from './compare-captures.js'
import { mcpInstructions } from './mcp-instructions.js'
import { localUserName } from './server/local-user.js'

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const boardArg = z.string().max(64).optional().describe('Board id (default: the first board in the config)')
const commentId = z.number().int().positive().describe('Comment id')

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const failure = (message) => ({ content: [{ type: 'text', text: message }], isError: true })

// Comment lists and comments go out with the trust fields first, like
// `comments --json`: their text is data from the people on the board and captured pages.
const untrusted = (value) => json(untrustedJson(value))

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
export const SCREENSHOT_MAX = 32 * 1024 * 1024

// A capture's bytes for get_comment, only when it is a regular file (not a
// symlink a project planted at captures/home.desktop.png), of bounded size
// and really a PNG. Anything else would hand another file to the model.
export function readScreenshot(file) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  } catch (error) {
    throw new Error(error.code === 'ELOOP' ? 'The screenshot is not a regular capture file.' : 'Could not read the screenshot.', {
      cause: error,
    })
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > SCREENSHOT_MAX) throw new Error('The screenshot is not a regular capture file.')
    const png = fs.readFileSync(fd)
    if (!png.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('The screenshot is not a PNG.')
    return png
  } finally {
    fs.closeSync(fd)
  }
}

// Turns thrown errors into tool errors with their message (no stacks).
const tool = (handler) => async (args) => {
  try {
    return await handler(args || {})
  } catch (error) {
    return failure(error.message || String(error))
  }
}

// Page ids of a journey: one from the config (`journeys`) or made on the
// board (journeys.json), on every branch of it.
export function journeyPageIds(config, board, journeyId) {
  const journeys = listJourneys(config, board)
  if (!journeys.length) throw new Error(`Board "${board.id}" has no journeys.`)
  const journey = journeys.find((item) => item.id === journeyId)
  if (!journey) throw new Error(`No journey "${journeyId}" on board "${board.id}" (have: ${journeys.map((item) => item.id).join(', ')}).`)
  return new Set(journey.pages)
}

export function listPages(config, board) {
  const files = captureFiles(config, board)
  const manifest = readManifest(config, board.id)
  return {
    board: { id: board.id, title: board.title, baseUrl: board.baseUrl },
    capturedAt: manifest?.capturedAt || null,
    pages: board.pages.map((page) => ({
      id: page.id,
      path: page.path,
      title: page.title,
      group: page.group,
      note: page.note || null,
      url: joinUrl(board.publicUrl || board.baseUrl, page.path),
      viewports: page.viewports,
      captured: Object.keys(files[page.id] || {}),
      errors: Object.fromEntries(
        Object.entries(manifest?.pages?.[page.id] || {})
          .filter(([, entry]) => entry?.status && entry.status !== 'ok')
          .map(([viewport, entry]) => [viewport, String(entry.error || entry.status).slice(0, 200)]),
      ),
    })),
  }
}

// Who "me" is on a local board: the comments the server stamped as the
// owner's (byOwner, store.js createComment). For older comments without the
// stamp, the name the board signs this machine's comments with
// (SHAPEWALL_USER_NAME, git user.name, the OS user), and, when the board has
// accounts (`serve --accounts`), the owner account's display name and
// handle. Read-only; a missing or unreadable accounts file just leaves the
// account out.
export function localMe(config, env = process.env) {
  const names = []
  const handles = []
  const name = localUserName(config.dir, env)
  if (name) names.push(name)
  const file = path.join(config.outputDir, '.accounts', 'accounts.sqlite')
  try {
    if (fs.existsSync(file)) {
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        const owner = db.prepare('SELECT handle, display_name FROM users ORDER BY created_at, rowid LIMIT 1').get()
        if (owner?.display_name) names.push(owner.display_name)
        if (owner?.handle) handles.push(owner.handle)
      } finally {
        db.close()
      }
    }
  } catch {
    // No sqlite in this Node, or no users table yet: the name alone.
  }
  return {
    names,
    handles,
    // Comments carry the server's owner stamp (byOwner): "me" goes by it.
    ownerStamp: true,
    why: 'Shapewall does not know your name on this machine. Set SHAPEWALL_USER_NAME or git user.name, or pass the name your comments are signed with.',
  }
}

// Links into a local board: built on the address of a running
// `shapewall serve` for this config (or the one set), read per call since
// serve may start after this server.
export function localLinks(config, env = process.env) {
  const base = () => localBoardBase(config, { env })
  const safe = (options) => {
    try {
      return boardLink({ base: base().url, ...options })
    } catch {
      return null
    }
  }
  return {
    base,
    comment: (boardId, item) =>
      safe({ board: boardId, comment: item.id, viewport: item.viewport?.name, ...(item.status === 'resolved' ? { filter: 'all' } : {}) }),
    page: (boardId, pageId) => safe({ board: boardId, page: pageId }),
    compare: (boardId, pageId, viewport) => safe({ board: boardId, page: pageId, viewport, compare: true }),
  }
}

// createMcpServer({ config }) returns an McpServer (not connected).
// readOnly drops every tool that writes; allowCapture: false drops recapture.
// env and fetchImpl are where GitHub calls read the token and go (tests).
export function createMcpServer({
  config,
  readOnly = false,
  allowCapture = !readOnly,
  capture = null,
  log = () => {},
  env = process.env,
  fetchImpl = undefined,
  boardId = null,
  toolNames = null,
  // The board's own agent (src/agent/owner-mcp.js): a function giving the
  // name its owner gave it. Its replies are signed with it and marked as an
  // agent's. External agents can supply a display name, defaulting to "agent".
  agentAuthor = null,
  // The server running this agent ({ pid, start }, owner-mcp.js): a comment
  // it holds (a fix it runs) is not this agent's to set a status on.
  fixServer = null,
  // The clock "today" is read from (tests set it).
  now = () => Date.now(),
}) {
  const signed = (author) => ({ author: (agentAuthor ? agentAuthor() : author) || 'agent', agent: true })
  const server = new McpServer(
    { name: 'shapewall', version: VERSION },
    {
      instructions: mcpInstructions({
        handIn: allowCapture ? 'local' : 'push',
        github: !readOnly && Boolean(githubSettings(config, env).repo),
      }),
    },
  )
  const links = localLinks(config, env)
  // The claims this server's agent took (board/id -> claim id), store.js local claims.
  const claims = new Map()
  const boardFor = (id) => {
    if (boardId && id && id !== boardId) throw new Error('This agent session is scoped to one board.')
    return getBoard(config, boardId || id || null)
  }
  const registerTool = (name, ...args) => {
    if (!toolNames || toolNames.includes(name)) server.registerTool(name, ...args)
  }

  registerTool(
    'list_pages',
    {
      title: 'List pages',
      description: 'Pages on the board: id, path, URL, group, viewports, which viewports are captured, and capture errors.',
      inputSchema: { board: boardArg },
      annotations: { readOnlyHint: true },
    },
    tool(({ board }) => {
      const target = boardFor(board)
      const report = listPages(config, target)
      return json({ ...report, pages: report.pages.map((page) => ({ ...page, link: links.page(target.id, page.id) })) })
    }),
  )

  registerTool(
    'list_journeys',
    {
      title: 'List journeys',
      description:
        'Journeys on the board: named paths through its pages. steps is a list of page ids where an item may be a fork, ' +
        '{ branches: [{ id, label, steps, end? }] }; every branch rejoins at the step after the fork unless end is true. ' +
        'pages lists every page on any branch; paths lists each way through the forks (choices, labels, page ids).',
      inputSchema: { board: boardArg },
      annotations: { readOnlyHint: true },
    },
    tool(({ board }) => {
      const target = boardFor(board)
      return json({ board: boardRef(target), journeys: listJourneys(config, target) })
    }),
  )

  registerTool(
    'list_comments',
    {
      title: 'List comments',
      description:
        'Board comments with author, page, viewport, element selector and text, position, replies and agent status. files.screenshot is the capture ' +
        'the comment was made on (files.latestScreenshot: the page now, when it was captured again since). Default: open comments.',
      inputSchema: {
        board: boardArg,
        status: z.enum(['open', 'resolved', 'all']).optional().describe('Default open'),
        page: z.string().max(64).optional().describe('Only comments on this page id (and its variants)'),
        journey: z
          .string()
          .max(64)
          .optional()
          .describe('Only comments on pages of this journey (config or board journeys, any branch) and their variants'),
        agentStatus: z
          .enum([...STORED_AGENT_STATUSES, 'none'])
          .optional()
          .describe('Only comments with this agent status ("none" = no agent has taken it)'),
        mention: z
          .string()
          .regex(/^@?[A-Za-z][\w.-]{0,39}$/)
          .optional()
          .describe('Only comments that mention this handle in the text or a reply, e.g. "agent" for @agent'),
        ...filterArgs,
      },
      annotations: { readOnlyHint: true },
    },
    tool((args) => {
      const { board, status = 'open', journey, agentStatus, mention, author, since, until, timeZone, q, pageName, limit, cursor } = args
      const target = boardFor(board)
      let page = args.page || null
      if (page && !target.pages.some((item) => item.id === page)) throw new Error(`No page "${page}" on board "${target.id}".`)
      // Every filter is checked before anything is read.
      const range = timeRange({ since, until, timeZone, now: now() })
      const who = author != null ? authorFilter(author, { me: localMe(config, env) }) : null
      if (pageName != null && !page) {
        const found = pageByName(target.pages, pageName)
        if (found.candidates) return untrusted({ board: boardRef(target), status, ...ambiguousPage(pageName, found.candidates) })
        if (found.none)
          throw new Error(
            `No page called "${pageName}" on board "${target.id}" (pages: ${target.pages.map((item) => item.title || item.id).join(', ')}).`,
          )
        page = found.page.id
      }
      const report = feedback(config, { boardId: target.id, status, pageId: page, mention: mention || null })
      let comments = report.comments
      if (journey) {
        const ids = journeyPageIds(config, target, journey)
        comments = comments.filter((item) => ids.has(item.page?.id || item.variant?.pageId))
      }
      if (agentStatus) comments = comments.filter((item) => (item.agentStatus || 'none') === agentStatus)
      const listed = narrowComments(comments, { author: who, range, q: q ?? null, limit, cursor: cursor ?? null })
      return untrusted({
        ...report,
        ...statedFilters({ author: who, range, q, page, pageName }),
        total: listed.total,
        count: listed.comments.length,
        nextCursor: listed.nextCursor,
        comments: listed.comments.map((item) => ({ ...item, link: links.comment(target.id, item) })),
      })
    }),
  )

  registerTool(
    'list_selectors',
    {
      title: 'List selectors',
      description:
        "Element selectors on a page's latest capture (what add_comment's selector takes), each with its element's text, sturdiest " +
        `first: #id, data-testid, aria-label, then short paths. With text, elements holding those words come first. At most ${SELECTORS_MAX}; more counts the rest.`,
      inputSchema: {
        board: boardArg,
        page: z.string().max(64).describe('Page id'),
        viewport: z.string().max(40).optional().describe("Default: the page's first viewport"),
        text: z.string().max(200).optional().describe('Only elements whose text has these words'),
      },
      annotations: { readOnlyHint: true },
    },
    tool(({ board, page, viewport, text }) =>
      json(selectorsReport(config, boardFor(board), { page, viewport: viewport || null, text: text || '' })),
    ),
  )

  registerTool(
    'get_page_capture',
    {
      title: 'Get a page capture',
      description: pageCaptureDescription,
      inputSchema: {
        board: boardArg,
        page: z.string().max(64).describe('Page id'),
        viewport: z.string().max(40).optional().describe("Default: the page's first viewport"),
        crop: cropArg,
      },
      annotations: { readOnlyHint: true },
    },
    tool(({ board, page: pageId, viewport, crop }) => {
      const target = boardFor(board)
      // Ids only: the page and viewport must be the board's, and the file
      // name is built from them (resolveFile allows only capture names).
      const page = target.pages.find((item) => item.id === pageId)
      if (!page) throw new Error(`No page "${pageId}" on board "${target.id}".`)
      const wanted = viewport || page.viewports[0]
      if (!page.viewports.includes(wanted))
        throw new Error(`Page "${page.id}" has no viewport "${wanted}" (it has: ${page.viewports.join(', ')}).`)
      const file = resolveFile(config, target.id, 'captures', `${page.id}.${wanted}.png`)
      if (!file) throw new Error(`No capture of "${page.id}" (${wanted}) yet. Capture it first (recapture_pages, or shapewall capture).`)
      const manifest = readManifest(config, target.id)
      return pageCaptureResult({
        png: readScreenshot(file),
        board: target.id,
        page: page.id,
        viewport: wanted,
        capturedAt: versionTime(entryVersion(manifest?.pages?.[page.id]?.[wanted], manifest)),
        crop: crop || null,
      })
    }),
  )

  registerTool(
    'get_comment',
    {
      title: 'Get a comment',
      description:
        'One comment with everything needed to act on it: page URL, viewport, element anchor (selector, text), pin position, replies, and the screenshot and live HTML ' +
        'it was made on (files.screenshot, files.liveHtml; files.latestScreenshot is the page now). ' +
        'files.images are images the comment author attached and files.markup is their drawing on the screenshot (PNG paths). ' +
        'By default also returns the screenshot around the pin as an image ("full" for the whole capture, "none" for no image), ' +
        'then the drawing and the attached images.',
      inputSchema: {
        board: boardArg,
        id: commentId,
        image: z.enum(['crop', 'full', 'none']).optional().describe('Default crop (about 900x700 px around the pin)'),
      },
      annotations: { readOnlyHint: true },
    },
    tool(({ board, id, image = 'crop' }) => {
      const target = boardFor(board)
      const item = feedbackItem(feedbackContext(config, target), getComment(config, target.id, id))
      const result = json(commentJson(target, { ...item, link: links.comment(target.id, item) }))
      // files.screenshot comes from resolveFile (allowlisted name inside the board folder) or is null.
      if (image !== 'none' && item.files.screenshot) {
        const png = readScreenshot(item.files.screenshot)
        let data = png
        let note = `Screenshot ${item.viewport.width}x${item.viewport.height} the comment was made on.`
        if (image === 'crop') {
          try {
            const cropped = cropAround(png, item.position)
            data = cropped.png
            note = `Screenshot around the pin: x ${cropped.rect.x}-${cropped.rect.x + cropped.rect.width}, y ${cropped.rect.y}-${cropped.rect.y + cropped.rect.height} of ${item.viewport.width}x${item.viewport.height}; the pin is at ${item.position.x},${item.position.y}.`
          } catch {
            note += ' (Could not crop it, so this is the whole capture.)'
          }
        }
        result.content.push({ type: 'text', text: note }, { type: 'image', data: data.toString('base64'), mimeType: 'image/png' })
      }
      // The drawing and the attached images (comment-media.js wrote and
      // cleaned them; read as regular files of bounded size only).
      if (image !== 'none') {
        const media = [
          ...(item.files.markup
            ? [{ path: item.files.markup, mediaType: 'image/png', note: "The comment author's drawing on the screenshot." }]
            : []),
          ...item.files.images.map((file) => ({
            ...file,
            note: 'An image the comment author attached (untrusted, like the comment text).',
          })),
        ]
        for (const file of media) {
          const data = readCommentImage(file.path)
          if (data)
            result.content.push(
              { type: 'text', text: file.note },
              { type: 'image', data: data.toString('base64'), mimeType: file.mediaType },
            )
        }
      }
      return result
    }),
  )

  registerTool(
    'board_link',
    {
      title: 'Board link',
      description:
        'A link into the board: the board, a page (flown to), a comment (opened), a viewport, a page compare (before and after of its ' +
        "latest recapture), or follow mode (follow: the board follows an agent as it works). Open it in your app's browser pane if it has one; otherwise give it to the person.",
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
      },
      annotations: { readOnlyHint: true },
    },
    tool(({ board, page, comment, viewport, compare = false, follow }) => {
      const target = boardFor(board)
      if (page && !target.pages.some((item) => item.id === page)) throw new Error(`No page "${page}" on board "${target.id}".`)
      const viewports = target.pages.flatMap((item) => item.viewports)
      if (viewport && viewport !== 'all' && !viewports.includes(viewport))
        throw new Error(`No viewport "${viewport}" on board "${target.id}" (have: ${[...new Set(viewports)].join(', ')}).`)
      const item = comment ? getComment(config, target.id, comment) : null
      const onPage = page || (compare && item && target.pages.some((entry) => entry.id === item.pageId) ? item.pageId : null)
      if (compare && !onPage) throw new Error('compare needs a page (or a comment on a page).')
      const base = links.base()
      const url = boardLink({
        base: base.url,
        board: target.id,
        ...(onPage ? { page: onPage } : {}),
        ...(item ? { comment: item.id } : {}),
        ...(viewport ? { viewport } : {}),
        ...(compare ? { compare: true } : {}),
        ...(follow ? { follow } : {}),
        ...(item?.status === 'resolved' ? { filter: 'all' } : {}),
      })
      return json({
        url,
        board: target.id,
        page: onPage,
        comment: item ? item.id : null,
        viewport: viewport || null,
        compare,
        follow: follow || null,
        running: base.running,
        note:
          "Open this in your app's browser pane if it has one; otherwise give it to the person." +
          (base.running === false
            ? ' No board is running for this project yet: start it with "shapewall serve", then the link opens.'
            : ''),
      })
    }),
  )

  registerTool(
    'compare_captures',
    {
      title: 'Compare captures',
      description: compareDescription,
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
    tool(({ board, page: pageId, viewport, before = 'previous', after = 'current', crop }) => {
      const target = boardFor(board)
      const page = target.pages.find((item) => item.id === pageId)
      if (!page) throw new Error(`No page "${pageId}" on board "${target.id}".`)
      const wanted = viewport || page.viewports[0]
      if (!page.viewports.includes(wanted))
        throw new Error(`Page "${page.id}" has no viewport "${wanted}" (it has: ${page.viewports.join(', ')}).`)
      // Ids only: files are found by capture and version names (resolveFile).
      const manifest = readManifest(config, target.id)
      const currentFile = resolveFile(config, target.id, 'captures', `${page.id}.${wanted}.png`)
      const current = currentFile ? entryVersion(manifest?.pages?.[page.id]?.[wanted], manifest) : null
      const archived = (listVersions(config, target.id)[page.id]?.[wanted] || []).map((entry) => entry.version)
      const history = captureHistory(current, archived)
      const pair = pickPair(history, { before, after }, `"${page.id}" (${wanted})`)
      const read = (entry) => {
        const file = entry.current ? currentFile : resolveFile(config, target.id, 'versions', `${page.id}.${wanted}.${entry.version}.png`)
        if (!file) throw new Error(`The capture ${entry.version} of "${page.id}" (${wanted}) is gone.`)
        return readScreenshot(file)
      }
      const { beforePng, afterPng } = readPair({
        pair,
        read,
        current,
        currentNow: () => {
          const now = readManifest(config, target.id)
          return entryVersion(now?.pages?.[page.id]?.[wanted], now)
        },
        what: `"${page.id}" (${wanted})`,
      })
      return compareResult({
        beforePng,
        afterPng,
        board: target.id,
        page: page.id,
        viewport: wanted,
        pair,
        crop: crop || null,
        link: links.compare(target.id, page.id, wanted),
        versions: history,
      })
    }),
  )

  if (!readOnly) {
    registerTool(
      'reply_to_comment',
      {
        title: 'Reply to a comment',
        description: 'Adds a reply to the comment thread, e.g. what you changed or a question for the person who wrote it.',
        inputSchema: {
          board: boardArg,
          id: commentId,
          body: z.string().min(1).max(2000),
          author: z.string().max(60).optional().describe('Display name for an external agent. Board agents use their configured name.'),
        },
      },
      tool(async ({ board, id, body, author }) => {
        const target = boardFor(board)
        const { comment, reply } = await addReply(config, target.id, id, { body, ...signed(author) })
        // The reply as the comment lists it (authorAgent, files), and the count as replyCount.
        const item = feedbackItem(feedbackContext(config, target), comment)
        return json({
          reply: replyOf(item, reply.id),
          comment: { id: comment.id, status: comment.status, agentStatus: comment.agentStatus, replyCount: comment.replies.length },
        })
      }),
    )

    registerTool(
      'add_comment',
      {
        title: 'Add a comment',
        description:
          'Pins a new comment to a page, as `shapewall comments add` does: on the element a selector from list_selectors finds ' +
          '(the pin sits in its middle), or near the top-left corner without one. Signed as an agent.',
        inputSchema: {
          board: boardArg,
          page: z.string().max(80).describe('Page id, or variant:<id>'),
          body: z.string().min(1).max(5000),
          viewport: z.string().max(40).optional().describe("Default: the page's first viewport"),
          selector: z.string().max(600).optional().describe('An element selector from list_selectors'),
          author: z.string().max(60).optional().describe('Display name for an external agent. Board agents use their configured name.'),
        },
      },
      tool(async ({ board, page, body, viewport, selector, author }) => {
        const target = boardFor(board)
        const notes = []
        const item = await addComment(
          config,
          target,
          { page, body, author: signed(author).author, ...(viewport ? { viewport } : {}), ...(selector !== undefined ? { selector } : {}) },
          () => {},
          (line) => notes.push(line),
          { agent: true },
        )
        return json(commentJson(target, { ...item, link: links.comment(target.id, item) }, notes.length ? { notes } : {}))
      }),
    )

    registerTool(
      'set_comment_status',
      {
        title: 'Set agent status',
        description:
          'Sets the agent status of a comment: queued, working, done (fixed, a person checks and resolves), needs-human (stuck or unclear; add a reply saying why), or clear.',
        inputSchema: {
          board: boardArg,
          id: commentId,
          agentStatus: z.enum([...AGENT_STATUSES, 'clear']),
          note: z.string().max(2000).optional().describe('Optional reply added with the change'),
        },
      },
      tool(async ({ board, id, agentStatus, note }) => {
        const target = boardFor(board)
        if (note && note.trim()) await addReply(config, target.id, id, { body: note, ...signed(null) })
        const value = agentStatus === 'clear' ? null : agentStatus
        // Taking work (queued, working) starts or moves on this process's
        // own claim; anything after it is written under that claim, so a
        // comment someone else took meanwhile is left alone (store.js).
        const key = `${target.id}/${Number(id)}`
        const held = ['queued', 'working'].includes(value) ? null : claims.get(key) || null
        const result = await setAgentStatus(config, target.id, id, value, {
          actor: 'agent',
          ...(held ? { claim: held } : {}),
          ...(fixServer ? { unlessHeldBy: fixServer } : {}),
          log: () => {},
        })
        if (['queued', 'working'].includes(value) && result.claim) claims.set(key, result.claim)
        else if (!['queued', 'working'].includes(value)) claims.delete(key)
        const { comment } = result
        return json({
          id: comment.id,
          status: comment.status,
          agentStatus: comment.agentStatus,
          changed: result.changed,
          ...(result.refused === 'invalid_transition'
            ? {
                changed: false,
                refused: 'invalid_transition',
                note: `A ${comment.status} comment cannot go to ${value || 'no status'} from ${comment.agentStatus || 'no status'}; nothing was changed.`,
              }
            : {}),
          ...(result.refused === 'claim_changed'
            ? {
                changed: false,
                refused: 'claim_changed',
                note: 'Someone else took or changed this comment since you claimed it; nothing was changed.',
              }
            : {}),
          ...(result.refused === 'held_by_fix'
            ? {
                changed: false,
                refused: 'held_by_fix',
                note: 'Shapewall is running this fix and sets the status itself when your turn ends; nothing was changed. Reply with what you did instead.',
              }
            : {}),
        })
      }),
    )

    registerTool(
      'resolve_comment',
      {
        title: 'Resolve a comment',
        description:
          'Marks the comment resolved with a note on what changed, and its agent status done. Optional fixRef: the pull request URL or commit that fixed it.',
        inputSchema: {
          board: boardArg,
          id: commentId,
          note: z.string().min(1).max(2000).describe('What changed'),
          fixRef: z.string().max(300).optional().describe('Pull request URL or commit that fixed it'),
        },
      },
      tool(async ({ board, id, note, fixRef }) => {
        const target = boardFor(board)
        const comment = await updateComment(
          config,
          target.id,
          id,
          { status: 'resolved', resolution: note, agentStatus: 'done', ...(fixRef ? { fixRef } : {}) },
          { actor: 'agent' },
        )
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

  // GitHub tools, when the config names a repo (the token is checked per call).
  if (!readOnly && githubSettings(config, env).repo) {
    registerTool(
      'create_github_issue',
      {
        title: 'Create a GitHub issue',
        description:
          'Opens an issue in the configured GitHub repo from a comment (text, page URL, element, screenshot and a link back to the board) and records it on the comment. Returns the existing issue if the comment has one.',
        inputSchema: { board: boardArg, id: commentId },
      },
      tool(async ({ board, id }) => {
        const target = boardFor(board)
        const { issue, created } = await createIssue(config, { boardId: target.id, commentId: id, env, fetchImpl })
        return json({ id, issue, created })
      }),
    )

    registerTool(
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
        const target = boardFor(board)
        const { comment, pull, merged } = await linkPull(config, { boardId: target.id, commentId: id, pr, env, fetchImpl })
        return json({ id: comment.id, status: comment.status, pull, merged })
      }),
    )
  }

  if (allowCapture) {
    registerTool(
      'recapture_pages',
      {
        title: 'Recapture pages',
        description:
          'Captures these pages again (every viewport, screenshot and live HTML) from the board baseUrl, so the board shows the new version. Returns when done.',
        inputSchema: { board: boardArg, pageIds: z.array(z.string().max(64)).min(1).max(100) },
      },
      tool(async ({ board, pageIds }) => {
        const target = boardFor(board)
        const ids = [...new Set(pageIds)]
        const unknown = ids.filter((id) => !target.pages.some((page) => page.id === id))
        if (unknown.length) throw new Error(`No page ${unknown.map((id) => `"${id}"`).join(', ')} on board "${target.id}".`)
        const lines = []
        const run = capture || (await import('./capture/capture.js')).runCapture
        const result = await run({
          config,
          boardId: target.id,
          only: ids,
          log: (line) => {
            lines.push(line)
            log(line)
          },
        })
        const manifest = readManifest(config, target.id)
        // Where to look at each new capture against the one before it.
        const compare = ids.flatMap((id) =>
          Object.entries(manifest?.pages?.[id] || {})
            .filter(([, entry]) => entry?.status === 'ok')
            .map(([viewport]) => ({ page: id, viewport, link: links.compare(target.id, id, viewport) })),
        )
        return json({
          ok: result.ok,
          shots: result.total,
          failed: result.failed,
          compare,
          pages: Object.fromEntries(
            ids.map((id) => [
              id,
              Object.fromEntries(
                Object.entries(manifest?.pages?.[id] || {}).map(([viewport, entry]) => [
                  viewport,
                  entry?.status === 'ok' ? 'ok' : String(entry?.error || 'failed').slice(0, 200),
                ]),
              ),
            ]),
          ),
          log: lines.slice(-20),
        })
      }),
    )
  }

  return server
}

// Serves on stdin/stdout until the client goes away.
export async function runMcp({ config, readOnly = false, allowCapture = !readOnly }) {
  const server = createMcpServer({ config, readOnly, allowCapture, log: (line) => process.stderr.write(`${line}\n`) })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  await new Promise((resolve) => {
    server.server.onclose = resolve
    process.stdin.once('end', resolve)
  })
}
