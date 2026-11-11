// Board tools for function-calling models. Reads are always available;
// writes require the per-turn owner capability. Page ids never become paths
// or commands. Tool results remain quoted untrusted data (context.js).

import fs from 'node:fs'
import { feedbackContext, feedbackItem } from '../feedback.js'
import { addReply, captureFiles, commentCounts, getComment, listComments, setAgentStatus, updateComment } from '../store.js'
import { quoteData } from './context.js'
import { commentText } from '../comment-fields.js'

const LIST_MAX = 100

// A comment's images, as the model sees them: no local file paths.
const imagesForModel = (images) =>
  (images || []).map(({ name, mediaType, bytes, width, height }) => ({ name, mediaType, bytes, width, height }))

// A comment for the model: no local file paths.
export function commentForModel(config, board, comment) {
  const item = feedbackItem(feedbackContext(config, board), comment)
  const { images = [], markup = null } = item.files || {}
  delete item.files
  if (images.length) item.images = imagesForModel(images)
  if (markup) item.drawingImage = 'attached as an image'
  item.replies = item.replies.map((reply) => {
    const out = { ...reply }
    if (out.images) out.images = imagesForModel(out.images)
    if ('markup' in out) {
      if (out.markup) out.drawingImage = 'attached as an image'
      delete out.markup
    }
    return out
  })
  return item
}

// The images of a comment's thread, for the model: the comment's drawing
// rendered on its screenshot, its images, then the newest replies' ones,
// at most `max` in all. Each comes after a quoted note (untrusted data).
export const COMMENT_MEDIA_MAX = 4
export function commentMediaParts(config, board, comment, max = COMMENT_MEDIA_MAX) {
  const item = feedbackItem(feedbackContext(config, board), comment)
  const found = []
  if (item.files.markup) found.push({ path: item.files.markup, mediaType: 'image/png', kind: 'the reviewer drawing on the screenshot' })
  for (const image of item.files.images) found.push({ ...image, kind: 'an image the reviewer attached' })
  for (const reply of [...item.replies].reverse()) {
    if (reply.markup) found.push({ path: reply.markup, mediaType: 'image/png', reply: reply.id, kind: 'a drawing in a reply' })
    for (const image of reply.images || []) found.push({ ...image, reply: reply.id, kind: 'an image attached to a reply' })
  }
  const parts = []
  for (const media of found.slice(0, max)) {
    let data
    try {
      data = fs.readFileSync(media.path).toString('base64')
    } catch {
      continue
    }
    parts.push({
      type: 'text',
      text: quoteData(
        'comment-image',
        { board: board.id, comment: comment.id, reply: media.reply ?? null },
        { kind: media.kind, name: media.name || undefined, mediaType: media.mediaType },
      ),
    })
    parts.push({ type: 'image', mediaType: media.mediaType, data })
  }
  return parts
}

export const BOARD_TOOLS = [
  {
    name: 'list_pages',
    label: 'Read the pages',
    description: 'List the pages on this board: id, title, path, group, note, and which viewports were captured.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run({ config, board }) {
      const captures = captureFiles(config, board)
      return {
        pages: board.pages.map((page) => ({
          id: page.id,
          title: page.title,
          path: page.path,
          group: page.group,
          note: page.note || undefined,
          captured: Object.keys(captures[page.id] || {}),
        })),
      }
    },
  },
  {
    name: 'list_comments',
    label: 'Read the comments',
    description:
      'List comments on this board (newest last, at most 100): id, page, viewport, status, body, author, agent status and reply count.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'resolved', 'all'], description: 'Which comments (default open).' },
        pageId: { type: 'string', description: 'Only comments on this page id.' },
      },
      additionalProperties: false,
    },
    run({ config, board }, args) {
      const status = ['open', 'resolved'].includes(args?.status) ? args.status : args?.status === 'all' ? null : 'open'
      const comments = listComments(config, board.id, { status })
        .filter((comment) => !args?.pageId || comment.pageId === args.pageId)
        .sort((a, b) => a.id - b.id)
        .slice(-LIST_MAX)
      return {
        counts: commentCounts(config, board.id),
        comments: comments.map((comment) => ({
          id: comment.id,
          pageId: comment.pageId,
          viewport: comment.viewport,
          status: comment.status,
          body: commentText(comment),
          author: comment.author || null,
          element: comment.anchor?.text || null,
          agentStatus: comment.agentStatus || null,
          replies: (comment.replies || []).length,
        })),
      }
    },
  },
  {
    name: 'get_comment',
    label: 'Read a comment',
    description: 'One comment in full: body, replies, the page and element it is pinned to, its position and status.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'The comment number.' } },
      required: ['id'],
      additionalProperties: false,
    },
    run({ config, board }, args) {
      return commentForModel(config, board, getComment(config, board.id, args?.id))
    },
  },
]

export const OWNER_TOOLS = [
  {
    name: 'reply_to_comment',
    label: 'Reply to the comment',
    description: 'Reply to a review comment as the agent.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' }, body: { type: 'string', maxLength: 2000 } },
      required: ['id', 'body'],
      additionalProperties: false,
    },
    async run({ config, board }, args) {
      return (await addReply(config, board.id, args.id, { body: args.body, author: 'agent' })).comment
    },
  },
  {
    name: 'set_comment_status',
    label: 'Update agent status',
    description: 'Set queued, working, done, needs-human or clear. A person reviews and resolves.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' }, agentStatus: { type: 'string', enum: ['queued', 'working', 'done', 'needs-human', 'clear'] } },
      required: ['id', 'agentStatus'],
      additionalProperties: false,
    },
    async run({ config, board }, args) {
      return (await setAgentStatus(config, board.id, args.id, args.agentStatus === 'clear' ? null : args.agentStatus, { actor: 'agent' }))
        .comment
    },
  },
  {
    name: 'resolve_comment',
    label: 'Resolve the comment',
    description: 'Resolve a comment only when the owner asked you to resolve it, with a note explaining the fix.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' }, note: { type: 'string', maxLength: 2000 } },
      required: ['id', 'note'],
      additionalProperties: false,
    },
    run({ config, board }, args) {
      if (!args.note?.trim()) throw new Error('A resolution note is required.')
      return updateComment(
        config,
        board.id,
        args.id,
        { status: 'resolved', resolution: args.note, agentStatus: 'done' },
        { actor: 'agent' },
      )
    },
  },
  {
    name: 'recapture_pages',
    label: 'Recapture pages',
    description: 'Recapture configured page ids after edits. Returns when the capture finishes.',
    parameters: {
      type: 'object',
      properties: { pageIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 } },
      required: ['pageIds'],
      additionalProperties: false,
    },
    async run({ config, board, capture, requestedPages }, args) {
      if (
        !Array.isArray(args.pageIds) ||
        !args.pageIds.length ||
        args.pageIds.length > 100 ||
        args.pageIds.some((id) => !board.pages.some((page) => page.id === id))
      )
        throw new Error('Choose configured page ids.')
      for (const id of args.pageIds) requestedPages?.add(id)
      const run = capture || (await import('../capture/capture.js')).runCapture
      return run({ config, boardId: board.id, only: [...new Set(args.pageIds)], log: () => {} })
    },
  },
]

export const toolSpecs = ({ ownerWrites = false, allowCapture = true } = {}) =>
  [...BOARD_TOOLS, ...(ownerWrites ? OWNER_TOOLS.filter((tool) => allowCapture || tool.name !== 'recapture_pages') : [])].map(
    ({ name, description, parameters }) => ({ name, description, parameters }),
  )

// Runs a tool call. Returns { ok, label, text (quoted, for the model), detail (short, for the card) }.
export async function runTool(context, call) {
  const available = [
    ...BOARD_TOOLS,
    ...(context.ownerWrites ? OWNER_TOOLS.filter((tool) => context.allowCapture !== false || tool.name !== 'recapture_pages') : []),
  ]
  const tool = available.find((item) => item.name === call.name)
  if (!tool) {
    return {
      ok: false,
      label: call.name || 'Unknown tool',
      text: `There is no tool "${String(call.name).slice(0, 60)}".`,
      detail: 'Unknown tool',
    }
  }
  try {
    const result = await tool.run(context, call.args || {})
    const detail =
      result.comments !== undefined
        ? `${result.comments.length} comment${result.comments.length === 1 ? '' : 's'}`
        : result.pages
          ? `${result.pages.length} page${result.pages.length === 1 ? '' : 's'}`
          : result.id
            ? `Comment #${result.id}`
            : null
    return { ok: true, label: tool.label, text: quoteData(`tool:${tool.name}`, { board: context.board.id }, result), detail }
  } catch (error) {
    const message = error.statusCode ? error.message : 'The tool failed.'
    return { ok: false, label: tool.label, text: message, detail: message }
  }
}
