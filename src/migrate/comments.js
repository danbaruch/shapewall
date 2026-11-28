// A board's comments.json, planned as engine rows for `shapewall migrate`.
//
// Mapping (plan R3): a local comment keeps its id as its number on the
// board; text, pin, anchor, status, resolution, fix reference, agent status
// (live: the same owner on the same machine), reopen count, edits, images
// and drawings all come along. Images move from comment-files/ into the
// engine's comment_files table (their bytes, under the same file name).
//
// Authors (IC4 B2): on a plain local board (no 1.x accounts, `localOnly`),
// everyone who could type a comment was the owner, at this machine or on a
// device the owner paired, and no released 1.x build stamped byOwner: every
// person's comment there (not an agent's or a share guest's, not stamped
// byOwner: false) becomes the owner's, so the engine sends it to agents as
// 1.x watch did. With 1.x accounts (serve --accounts), other people could
// comment, and the rule below holds.
// A local board's comments carry free names. Only a comment the
// board stamped byOwner: true becomes the owner's account (author_user_id),
// the same rule the local agent uses (watch-capabilities.js ownersComment).
// A comment signed with the owner's name but not stamped (made before the
// stamp, or typed by anyone who could comment) is written the way an import
// is: no account, imported by the owner, so it reads as outside text that
// the owner can still vouch for. Replies never get an account (the local
// board never stamped them). Every other name stays a plain label, kind
// 'local' (or 'agent' and 'guest'). Reactions keep their names as labels.
//
// Pure: reads files, returns rows and the list of what does not come along.

import fs from 'node:fs'
import path from 'node:path'
import { boardDir, cleanGithub, commentOnOtherEnvironment, commentsFile, VERSION_RE } from '../store.js'
import { CommentError, STORED_AGENT_STATUSES, cleanFixRef, validateAnchor } from '../comment-fields.js'
import { validateDrawing } from '../comment-drawing.js'
import { REACTIONS } from '../reactions.js'
import { sniffImage } from '../image-sniff.js'

const ENV_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

// The environment id a comment row gets: its own when it names a valid id
// (kept even when the config no longer has it, which is listed), else the
// board's first environment, else 'default'.
function environmentOf(board, comment, where, notes) {
  const first = board?.environments?.[0]?.id || 'default'
  const env = comment?.environment
  if (typeof env !== 'string' || !env) return first
  if (!ENV_ID_RE.test(env)) {
    notes.push(`${where} named environment "${String(env).slice(0, 64)}", which is not a valid id; it goes on ${first}`)
    return first
  }
  if (board?.environments?.length && !board.environments.some((item) => item.id === env))
    notes.push(`${where} is on environment ${env}, which the config no longer has; it keeps that id`)
  return env
}

// Fields a local comment may hold. Everything here is either carried or
// listed in DROPPED_FIELDS with its reason; anything else is reported.
const CARRIED = new Set([
  'id',
  'pageId',
  'viewport',
  'x',
  'y',
  'body',
  'author',
  'anchor',
  'captureVersion',
  'status',
  'createdAt',
  'updatedAt',
  'resolvedAt',
  'resolution',
  'replies',
  'agentStatus',
  'agentStatusAt',
  'reactions',
  'reopenCount',
  'reopenedAt',
  'fixRef',
  'images',
  'drawing',
  'environment',
  'github',
  'byOwner',
  'authorAgent',
  'authorGuest',
  'editedAt',
])
export const DROPPED_FIELDS = {
  agentClaim: "a local watcher's claim; the engine's agents claim through their own link (the status stays)",
  agentBranch: 'the branch of a branch-ready fix; the branch stays in git and the comment keeps its status',
  mentions: 'read from the text again on the engine',
}
const REPLY_CARRIED = new Set([
  'id',
  'author',
  'body',
  'createdAt',
  'reactions',
  'images',
  'drawing',
  'agent',
  'guest',
  'editedAt',
  'unvouched',
])
const IMAGE_RE = /^[a-f0-9]{24}\.(png|jpg|webp|gif)$/
const MEDIA = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
const FILE_MAX = 10 * 1024 * 1024

const iso = (value, fallback = null) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback
const clean = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

// A comment's GitHub issue and pull request links (migration 25), as the
// local store reads them (store.js cleanGithub): what it would not keep is
// reported, and stays in the backup. -> null for none.
function githubOf(comment, where, drop) {
  if (comment.github == null) return null
  const raw = comment.github
  const github = cleanGithub(raw)
  // B-18: a value that is not an object (a string, a list) keeps nothing; said so.
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    drop(`${where}, GitHub links`, 'not the GitHub links Shapewall writes; it stays in the backup')
    return null
  }
  if (raw?.issue && !github.issue) drop(`${where}, GitHub issue`, 'not an issue link Shapewall writes; it stays in the backup')
  const pulls = Array.isArray(raw?.pulls) ? raw.pulls.length : 0
  if (pulls > github.pulls.length)
    drop(
      `${where}, ${pulls - github.pulls.length} pull request link(s)`,
      'not a pull request link Shapewall writes, or more than a comment keeps; it stays in the backup',
    )
  return github.issue || github.pulls.length ? github : null
}

// The comments file, parsed. A file that does not parse stops the
// migration (it is never read as "no comments").
export function readCommentsFile(config, boardId) {
  const file = commentsFile(config, boardId)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { nextId: 1, comments: [] }
    throw error
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new CommentError(500, 'corrupt_file', `${path.relative(config.dir || process.cwd(), file)} is not valid JSON (${error.message}).`)
  }
  const comments = Array.isArray(raw?.comments) ? raw.comments : []
  return { nextId: Number(raw?.nextId) || 1, comments }
}

// `owner`: { names: [...] } the owner's display names (the account's, the
// machine's); `board`: the config board (pages, environments).
export function planComments(config, board, { owner, localOnly = false }) {
  const names = new Set((owner.names || []).map(clean).filter(Boolean))
  const { nextId, comments: raw } = readCommentsFile(config, board.id)
  const filesDir = path.join(boardDir(config, board.id), 'comment-files')
  const drops = []
  const notes = []
  const counts = {
    comments: 0,
    replies: 0,
    reactions: 0,
    images: 0,
    drawings: 0,
    ownerStamped: 0,
    ownerLocal: 0,
    ownerByName: 0,
    labels: 0,
  }
  const used = new Set()
  const pages = new Set(board.pages.map((page) => page.id))
  const drop = (item, reason) => drops.push({ item, reason })
  // 'owner' (stamped by the board), 'name' (the owner's name, not stamped:
  // written as an import) or null.
  const ownerMark = (item) => {
    if (item.authorAgent === true || item.authorGuest === true || item.agent === true || item.guest === true) return null
    if (item.byOwner === true) {
      counts.ownerStamped += 1
      return 'owner'
    }
    if (localOnly && item.byOwner !== false) {
      counts.ownerLocal += 1
      return 'owner'
    }
    if (item.byOwner !== false && names.has(clean(item.author))) {
      counts.ownerByName += 1
      return 'name'
    }
    return null
  }
  const cut = (value, max, what) => {
    const text = String(value)
    if (text.length > max) drop(what, `longer than ${max} characters; cut to ${max}`)
    return text.slice(0, max)
  }

  // The bytes of one image record, checked against what it says it is.
  const imageFile = (record, where, replyId) => {
    const name = String(record?.file || '')
    if (!IMAGE_RE.test(name)) return (drop(where, 'an image record with no valid file name'), null)
    const file = path.join(filesDir, name)
    let data
    try {
      data = fs.readFileSync(file)
    } catch {
      return (drop(`${where}, image ${record.name || name}`, 'its file is missing from comment-files/'), null)
    }
    const type = MEDIA[name.split('.').pop()]
    if (data.length > FILE_MAX || sniffImage(data) !== type)
      return (drop(`${where}, image ${record.name || name}`, 'its file is not the image it says it is'), null)
    return {
      record: {
        id: name.split('.')[0],
        file: name,
        name: String(record.name || name).slice(0, 120),
        mediaType: type,
        bytes: data.length,
        width: Number(record.width) || 1,
        height: Number(record.height) || 1,
      },
      file: {
        file: name,
        replyId,
        name: String(record.name || name).slice(0, 120),
        mediaType: type,
        width: Number(record.width) || 1,
        height: Number(record.height) || 1,
        data,
      },
    }
  }
  const drawingOf = (value, where) => {
    if (value === undefined || value === null) return null
    try {
      const shaped = validateDrawing(value)
      if (!shaped) return null
      counts.drawings += 1
      return { ...shaped, captureVersion: VERSION_RE.test(String(value.captureVersion || '')) ? value.captureVersion : null }
    } catch (error) {
      drop(`${where}, drawing`, `it does not read as a drawing (${error.message})`)
      return null
    }
  }
  const reactionsOf = (value, where) => {
    if (!Array.isArray(value)) return []
    const out = []
    for (const entry of value) {
      if (!REACTIONS.includes(entry?.emoji) || !Array.isArray(entry.by)) {
        drop(`${where}, reaction`, 'not a reaction the board offers')
        continue
      }
      const named = entry.by.filter((who) => who && typeof who.name === 'string' && who.name.trim())
      if (named.length > 200) drop(`${where}, ${entry.emoji} reaction`, `the ${named.length - 200} name(s) past 200`)
      const by = named.slice(0, 200).map((who) => ({ name: who.name.trim() }))
      if (by.length) {
        counts.reactions += by.length
        out.push({ emoji: entry.emoji, by })
      }
    }
    return out
  }

  const planned = []
  for (const comment of raw) {
    const id = comment?.id
    if (!Number.isSafeInteger(id) || id < 1) {
      drop(`a comment without an id (${String(comment?.body || '').slice(0, 40)})`, 'local readers skip it too')
      continue
    }
    const where = `comment #${id}`
    if (used.has(id)) {
      drop(where, 'a second comment with the same id (local readers show only one)')
      continue
    }
    if (typeof comment.pageId !== 'string' || typeof comment.viewport !== 'string' || ![comment.x, comment.y].every(Number.isFinite)) {
      drop(where, 'it has no page, viewport or pin position')
      continue
    }
    used.add(id)
    for (const key of Object.keys(comment)) {
      if (CARRIED.has(key)) continue
      if (DROPPED_FIELDS[key]) {
        if (key !== 'mentions') drop(`${where}, ${key}`, DROPPED_FIELDS[key])
      } else drop(`${where}, field "${key}"`, 'not a field Shapewall writes; it stays in the backup')
    }
    if (!pages.has(comment.pageId) && !comment.pageId.startsWith('variant:'))
      notes.push(`${where} is on page "${comment.pageId}", which is no longer in the config (it comes along, as on the local board)`)
    let anchor = null
    try {
      anchor = validateAnchor(comment.anchor)
    } catch {
      drop(`${where}, element anchor`, 'not an anchor Shapewall writes; the pin position stays')
    }
    const files = []
    const images = []
    for (const record of Array.isArray(comment.images) ? comment.images : []) {
      const found = imageFile(record, where, null)
      if (found) {
        images.push(found.record)
        files.push(found.file)
      }
    }
    const replies = []
    for (const [index, reply] of (Array.isArray(comment.replies) ? comment.replies : []).entries()) {
      const replyId = Number.isSafeInteger(reply?.id) && reply.id > 0 ? reply.id : index + 1
      const at = `${where}, reply ${replyId}`
      if (!reply || typeof reply !== 'object') {
        drop(at, 'not a reply')
        continue
      }
      for (const key of Object.keys(reply))
        if (!REPLY_CARRIED.has(key)) drop(`${at}, field "${key}"`, 'not a field Shapewall writes; it stays in the backup')
      const replyImages = []
      for (const record of Array.isArray(reply.images) ? reply.images : []) {
        const found = imageFile(record, at, replyId)
        if (found) {
          replyImages.push(found.record)
          files.push(found.file)
        }
      }
      counts.labels += 1
      const drawing = drawingOf(reply.drawing, at)
      const reactions = reactionsOf(reply.reactions, at)
      replies.push({
        id: replyId,
        author: cut(reply.author || 'anonymous', 60, `${at}, author name`),
        ...(reply.agent === true ? { agent: true } : {}),
        ...(reply.agent === true && reply.unvouched === true ? { unvouched: true } : {}),
        ...(reply.guest === true ? { guest: true } : {}),
        body: String(reply.body || ''),
        createdAt: iso(reply.createdAt, iso(comment.createdAt, new Date(0).toISOString())),
        ...(iso(reply.editedAt) ? { editedAt: iso(reply.editedAt) } : {}),
        ...(replyImages.length ? { images: replyImages } : {}),
        ...(drawing ? { drawing } : {}),
        ...(reactions.length ? { reactions } : {}),
      })
    }
    counts.replies += replies.length
    counts.images += files.length
    const mark = ownerMark(comment)
    if (!mark) counts.labels += 1
    const status = comment.status === 'resolved' ? 'resolved' : 'open'
    if (comment.status !== 'open' && comment.status !== 'resolved')
      drop(`${where}, status "${comment.status}"`, 'read as open, as the local board does')
    const agentStatus = STORED_AGENT_STATUSES.includes(comment.agentStatus) ? comment.agentStatus : null
    if (comment.agentStatus && !agentStatus) drop(`${where}, agent status "${comment.agentStatus}"`, 'not an agent status Shapewall knows')
    let fixRef = null
    try {
      fixRef = comment.fixRef == null || comment.fixRef === '' ? null : cleanFixRef(comment.fixRef)
    } catch {
      drop(`${where}, fix reference`, 'not a fix reference Shapewall writes')
    }
    const createdAt = iso(comment.createdAt, new Date(0).toISOString())
    planned.push({
      number: id,
      pageId: comment.pageId,
      viewport: comment.viewport,
      x: comment.x,
      y: comment.y,
      body: String(comment.body || ''),
      author: cut(comment.author || 'anonymous', 60, `${where}, author name`),
      by: mark === 'owner' ? 'owner' : mark === 'name' ? 'name' : 'label',
      authorKind: comment.authorAgent === true ? 'agent' : comment.authorGuest === true ? 'guest' : 'local',
      anchor,
      captureVersion: VERSION_RE.test(String(comment.captureVersion || '')) ? comment.captureVersion : null,
      status,
      resolution: typeof comment.resolution === 'string' && comment.resolution ? comment.resolution : null,
      fixRef,
      replies,
      agentStatus,
      agentStatusAt: agentStatus ? iso(comment.agentStatusAt) : null,
      reopenCount: Number.isSafeInteger(comment.reopenCount) && comment.reopenCount > 0 ? comment.reopenCount : 0,
      reopenedAt: iso(comment.reopenedAt),
      createdAt,
      updatedAt: iso(comment.updatedAt, createdAt),
      resolvedAt: status === 'resolved' ? iso(comment.resolvedAt, iso(comment.updatedAt, createdAt)) : null,
      reactions: reactionsOf(comment.reactions, where),
      editedAt: iso(comment.editedAt),
      images,
      drawing: drawingOf(comment.drawing, where),
      // Migration 24: every comment row names its environment. A comment
      // with none is on the board's first one (MIG24 section 1).
      environment: environmentOf(board, comment, where, notes),
      otherEnvironment: commentOnOtherEnvironment(board, comment),
      // Migration 25: its GitHub issue and pull requests, as the local board kept them.
      github: githubOf(comment, where, drop),
      files: files.map((file) => ({ ...file, createdAt })),
    })
  }
  counts.comments = planned.length
  // Rendered drawings (markup-*.png) are made again on demand; any other
  // file in comment-files/ that no comment names stays in the backup.
  const named = new Set(planned.flatMap((comment) => comment.files.map((file) => file.file)))
  if (fs.existsSync(filesDir)) {
    for (const name of fs.readdirSync(filesDir)) {
      if (named.has(name)) continue
      if (/^markup-/.test(name)) {
        drop(`comment-files/${name}`, 'a rendered drawing; the engine draws it again from the comment')
        continue
      }
      drop(`comment-files/${name}`, 'no comment names it (left over from a deleted comment); it stays in the backup')
    }
  }
  const highest = Math.max(0, ...planned.map((comment) => comment.number))
  return {
    comments: planned,
    nextComment: Math.max(nextId, highest + 1),
    otherEnvironments: planned.filter((comment) => comment.otherEnvironment).length,
    githubLinks: planned.filter((comment) => comment.github).length,
    counts,
    drops,
    notes,
  }
}
