// `shapewall variant`: another version of a page, captured beside it.

import { randomBytes } from 'node:crypto'
import { ID_RE, boardViewports, getBoard, joinUrl, loadConfig } from '../config.js'
import { captureVariant } from '../capture/capture.js'
import { readVariants, removeVariant, saveVariant, variantsWithFiles } from '../store.js'
import { suggestFlag } from './args.js'

function slugify(textValue) {
  return (
    String(textValue || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'variant'
  )
}

export async function variant(positional, flags, out) {
  const config = loadConfig(flags.config)
  const board = getBoard(config, flags.board)
  const action = positional[0]
  if (action === 'list') {
    const list = variantsWithFiles(config, board)
    if (flags.json) out(JSON.stringify({ variants: list }, null, 2))
    else
      out(
        list.length
          ? list
              .map((item) => `${item.id}  beside ${item.pageId}  "${item.title}"  ${Object.keys(item.files).join(', ') || 'no files'}`)
              .join('\n')
          : 'No variants.',
      )
    return
  }
  if (action === 'rm') {
    const id = positional[1]
    if (!id) throw new Error('usage: shapewall variant rm ID')
    if (!(await removeVariant(config, board.id, id))) throw new Error(`No variant "${id}"`)
    out(`Removed ${id}`)
    return
  }
  if (action === 'add') {
    const pageId = positional[1]
    if (!pageId) throw new Error(`usage: shapewall variant add PAGE --url URL --title TEXT (PAGE is a page id on "${board.id}")`)
    const page = board.pages.find((item) => item.id === pageId)
    if (!page) {
      const ids = board.pages.map((item) => item.id)
      const close = suggestFlag(pageId, ids)
      throw new Error(
        `no page '${pageId.slice(0, 80)}' on board "${board.id}"${close ? ` (did you mean ${close}?)` : ''}; pages: ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? ', ...' : ''}`,
      )
    }
    const url = flags.url || (flags.path ? joinUrl(board.baseUrl, flags.path) : null)
    if (!url || !/^https?:\/\//.test(url)) throw new Error('--url (http or https) or --path is required')
    const title = typeof flags.title === 'string' && flags.title.trim() ? flags.title.trim() : 'Variant'
    let id = flags.id || `${slugify(title)}-${randomBytes(2).toString('hex')}`
    if (!ID_RE.test(id)) throw new Error('--id: lowercase letters, digits and dashes')
    if (readVariants(config, board.id).some((item) => item.id === id) && !flags.id) id = `${id}-${randomBytes(2).toString('hex')}`
    const viewports = flags.viewport
      ? String(flags.viewport)
          .split(',')
          .map((item) => item.trim())
      : page.viewports
    for (const name of viewports)
      if (!boardViewports(config, board)[name]) throw new Error(`--viewport: no viewport "${name}" on board "${board.id}"`)
    out(`Capturing variant ${id} of ${page.id} from ${url}`)
    const results = await captureVariant({ config, boardId: board.id, pageId: page.id, variantId: id, url, viewports, log: out })
    if (!Object.values(results).some((entry) => entry.status === 'ok')) throw new Error('every shot failed; nothing was saved')
    await saveVariant(config, board.id, {
      id,
      pageId: page.id,
      title,
      note: flags.note || '',
      source: flags.source || url,
      createdAt: new Date().toISOString(),
    })
    out(`Added variant ${id} beside ${page.id}`)
    return
  }
  throw new Error('usage: shapewall variant add|rm|list')
}
