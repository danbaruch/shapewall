// Local owner feedback loop. Never infer page ids or commands from model prose.
import fs from 'node:fs'
import path from 'node:path'
import { addReply, currentVersion, getComment, setAgentStatus } from '../store.js'

const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage', '.output', '.shapewall'])
const FILES_MAX = 30000

// Metadata only: no source text or secrets enter the model or the chat log.
// Symlinks are not followed. A bounded scan also covers terminal/native edits.
export function projectSnapshot(config) {
  const entries = new Map()
  let visited = 0
  const walk = (dir) => {
    if (path.resolve(dir) === path.resolve(config.outputDir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++visited > FILES_MAX) return
      if (entry.isSymbolicLink() || SKIP.has(entry.name)) continue
      const file = path.join(dir, entry.name)
      try {
        if (entry.isDirectory()) walk(file)
        else if (entry.isFile()) {
          const stat = fs.statSync(file, { bigint: true })
          entries.set(path.relative(config.dir, file), `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`)
        }
      } catch {
        /* a file may disappear while the agent works */
      }
    }
  }
  try {
    walk(config.dir)
  } catch {
    /* caller still has explicit edit events */
  }
  return { entries, incomplete: visited > FILES_MAX }
}

export function projectChanged(before, after) {
  return (
    before.incomplete ||
    after.incomplete ||
    before.entries.size !== after.entries.size ||
    [...before.entries].some(([file, stamp]) => after.entries.get(file) !== stamp)
  )
}

export async function recaptureComment({ config, board, id, pageIds = [], capture = null, log = () => {} }) {
  const comment = getComment(config, board.id, id)
  if (String(comment.pageId).startsWith('variant:')) throw new Error('Recapture variants from the terminal before marking this fix done.')
  const ids = [...new Set([comment.pageId, ...pageIds])]
  if (ids.some((pageId) => !board.pages.some((page) => page.id === pageId))) throw new Error('Unknown page to recapture.')
  const before = currentVersion(config, board.id, comment.pageId, comment.viewport)
  const run = capture || (await import('../capture/capture.js')).runCapture
  const result = await run({ config, boardId: board.id, only: ids, log })
  if (!result.ok || result.failed) throw new Error('The recapture failed. Check the dev server and capture the page again.')
  const version = currentVersion(config, board.id, comment.pageId, comment.viewport)
  if (!version || version === before) throw new Error('The recapture did not produce a page version.')
  await addReply(config, board.id, id, {
    author: 'shapewall',
    body: comment.captureVersion
      ? `Recaptured ${ids.join(', ')}. Before and after are ready below this comment. Review the change, then resolve or reply “not yet”.`
      : `Recaptured ${ids.join(', ')}. This comment has no original capture for comparison. Review the updated page, then resolve or reply “not yet”.`,
  })
  return result
}

export async function finishFix({ config, board, id, reply, changed, capture, pageIds = [], signal, log = () => {} }) {
  let comment
  try {
    comment = getComment(config, board.id, id)
  } catch {
    return
  }
  if (signal?.aborted || reply.status !== 'done' || !changed) {
    if (comment.status === 'open') {
      await addReply(config, board.id, id, {
        author: 'shapewall',
        body:
          reply.status !== 'done' || signal?.aborted
            ? 'The agent stopped before the fix could be verified. Review its answer and try again.'
            : 'No project file changes were detected. Review the agent’s answer before continuing.',
      })
      await setAgentStatus(config, board.id, id, 'needs-human', { actor: 'shapewall' })
    }
    return
  }
  try {
    await recaptureComment({ config, board, id, capture, pageIds, log })
    if (signal?.aborted) {
      await setAgentStatus(config, board.id, id, 'needs-human', { actor: 'shapewall' })
    } else if (getComment(config, board.id, id).status === 'open' && getComment(config, board.id, id).agentStatus !== 'needs-human') {
      await setAgentStatus(config, board.id, id, 'done', { actor: 'shapewall' })
    }
  } catch (error) {
    await addReply(config, board.id, id, {
      author: 'shapewall',
      body: `The agent changed files, but verification needs a person: ${error.message}`,
    })
    await setAgentStatus(config, board.id, id, 'needs-human', { actor: 'shapewall' })
  }
}
