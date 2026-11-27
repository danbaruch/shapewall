import { portableManifest, portableVariants } from '../portable-capture.js'
// Command-line parts that talk to a hosted Shapewall: `push`, `hosted`, and
// the --remote forms of `comments`, `watch` and `mcp`.

import fs from 'node:fs'
import path from 'node:path'
import { portableChecks } from '../checks/transport.js'
import { getBoard, loadConfig } from '../config.js'
import {
  formatFeedback,
  formatFeedbackForAgent,
  formatFeedbackItem,
  formatFeedbackItemForAgent,
  remoteBoardRef,
  untrustedJson,
} from '../feedback.js'
import { AGENT_STATUSES, boardDir, readManifest, readVariants } from '../store.js'
import { createRemote, pushDefinition, pushFiles, readCaptureFile, remoteSettings } from './remote.js'
import { safeOut, terminalSafe } from './terminal.js'

export async function push(flags, print) {
  // Names and URLs here come from the server: cleaned before printing.
  const out = safeOut(print)
  const config = loadConfig(flags.config)
  const remote = createRemote(remoteSettings(flags))
  const boards = flags.board ? [getBoard(config, flags.board)] : config.boards
  const project = await remote.project()
  if (flags.page !== undefined) {
    if (boards.length !== 1) throw new Error('push --page needs --board ID (this config has more than one board).')
    if (flags['include-checks']) throw new Error('push --page sends captures only; push the whole board for --include-checks.')
    const ids = [flags.page]
      .flat()
      .flatMap((value) => String(value).split(','))
      .map((value) => value.trim())
      .filter(Boolean)
    const result = await pushPages({ config, board: boards[0], remote, pages: ids, out })
    if (result.skipped.length) out(`Not pushed (no ok capture here): ${result.skipped.join(', ')}`)
    return
  }
  for (const board of boards) await pushBoard({ config, board, remote, project, includeChecks: !!flags['include-checks'], out })
}

// Uploads one board's latest captures and returns the commit's answer
// ({ files, url, ... }). The hosted server swaps a board in whole on commit
// (src/hosted/push.js), so this sends the whole board. `shapewall push` uses it.
export async function pushBoard({ config, board, remote, project = null, includeChecks = false, out = () => {} }) {
  const manifest = readManifest(config, board.id)
  if (!manifest) throw new Error(`Board "${board.id}" has no captures yet. Run "shapewall capture --board ${board.id}" first.`)
  const checks = portableChecks(config, board, { includeChecks })
  const files = pushFiles(config, board)
  const started = await remote.startPush(pushDefinition(config, board))
  if (checks && !started.limits.checks)
    throw new Error('This server does not support checks. Update it before explicitly including diagnostics.')
  const where = project ? ` to ${project.workspace.name} / ${project.project.name}` : ''
  out(`Pushing board "${board.id}" (${files.length} files)${where}`)
  let bytes = 0
  let done = 0
  for (const [area, name, file] of files) {
    // A server from before element maps does not take them (its boards keep x/y pins).
    if (name.endsWith('.elements.json') && !started.limits.elements) continue
    // Never through a symlink (see readCaptureFile).
    const cap = name.endsWith('.html')
      ? started.limits.html
      : name.endsWith('.elements.json')
        ? started.limits.elements
        : started.limits.png
    if (!Number.isSafeInteger(cap) || cap < 0) throw new Error('The server returned an invalid upload limit.')
    let data
    try {
      data = readCaptureFile(config, file, Math.min(cap, 11 * 1024 * 1024))
    } catch (error) {
      if (error.code !== 'file_too_large') throw error
      out(`  skipped ${area}/${name}: ${(error.size / 1048576).toFixed(1)} MB is over the upload limit`)
      continue
    }
    await remote.pushFile(started.id, area, name, data)
    bytes += data.length
    done += 1
    if (done % 25 === 0) out(`  ${done}/${files.length} files`)
  }
  const result = await remote.commitPush(started.id, {
    manifest: portableManifest(config, board, manifest),
    variants: portableVariants(readVariants(config, board.id)),
    checks,
  })
  if (checks && result.checks !== checks.reports.length) throw new Error('The server did not confirm all included check reports.')
  out(`Pushed ${result.files} files (${(bytes / 1048576).toFixed(1)} MB). Board: ${result.url}`)
  return result
}

// Uploads only some pages' latest captures to a board already pushed (a
// page push, src/hosted/push.js): every other page on the hosted board stays
// as it is there, also when another machine pushed it since. `pages` is a
// list of page ids (each viewport with an ok capture here) or a map
// { <page id>: [<viewport>, ...] }. The server refuses the whole push
// (stale_capture) if it holds a newer capture of any of them.
// -> the commit's answer plus `sent` (the map) and `skipped` ("page (viewport)").
// `shapewall push --page` and recapture_pages of `mcp --remote` use it.
export async function pushPages({ config, board, remote, pages, out = () => {} }) {
  const manifest = readManifest(config, board.id)
  if (!manifest) throw new Error(`Board "${board.id}" has no captures yet. Run "shapewall capture --board ${board.id}" first.`)
  const wanted = Array.isArray(pages)
    ? Object.fromEntries(
        pages.map((id) => {
          const page = board.pages.find((item) => item.id === id)
          if (!page) throw new Error(`No page "${id}" on board "${board.id}".`)
          return [id, page.viewports]
        }),
      )
    : pages
  const sent = {}
  const skipped = []
  for (const [id, viewports] of Object.entries(wanted)) {
    for (const viewport of viewports) {
      if (manifest.pages?.[id]?.[viewport]?.status === 'ok') (sent[id] = sent[id] || []).push(viewport)
      else skipped.push(`${id} (${viewport})`)
    }
  }
  if (!Object.keys(sent).length) throw new Error('None of these pages has an ok capture here, so nothing was pushed.')
  let started
  try {
    started = await remote.startPagePush(board.id, sent)
  } catch (error) {
    if (error?.code === 'invalid_board' && error.status === 400)
      throw new Error('This server cannot take a push of a few pages yet. Update it, or push the whole board with "shapewall push".', {
        cause: error,
      })
    throw error
  }
  const dir = path.join(boardDir(config, board.id), 'captures')
  const names = Object.entries(sent).flatMap(([id, viewports]) =>
    viewports.flatMap((viewport) => ['.png', '.thumb.png', '.html', '.elements.json'].map((suffix) => `${id}.${viewport}${suffix}`)),
  )
  out(`Pushing ${Object.keys(sent).join(', ')} (${Object.values(sent).flat().length} captures) of board "${board.id}"`)
  for (const name of names) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) continue
    if (name.endsWith('.elements.json') && !started.limits.elements) continue
    const cap = name.endsWith('.html')
      ? started.limits.html
      : name.endsWith('.elements.json')
        ? started.limits.elements
        : started.limits.png
    if (!Number.isSafeInteger(cap) || cap < 0) throw new Error('The server returned an invalid upload limit.')
    await remote.pushFile(started.id, 'captures', name, readCaptureFile(config, file, Math.min(cap, 11 * 1024 * 1024)))
  }
  const portable = portableManifest(config, board, manifest)
  const result = await remote.commitPush(started.id, {
    manifest: {
      ...portable,
      pages: Object.fromEntries(
        Object.entries(sent).map(([id, viewports]) => [
          id,
          Object.fromEntries(viewports.map((viewport) => [viewport, portable.pages[id][viewport]])),
        ]),
      ),
    },
    variants: [],
  })
  out(`Pushed ${result.files} files of ${result.pages} page${result.pages === 1 ? '' : 's'}. Board: ${result.url}`)
  return { ...result, sent, skipped }
}

function mentionOf(value) {
  if (value === undefined) return null
  const handle = String(value).replace(/^@/, '').toLowerCase()
  if (!/^[a-z][\w.-]{0,39}$/.test(handle)) throw new Error('--mention needs a name like robin or agent')
  return handle
}

// The board on the hosted project: --board, else the only/first one pushed.
export async function remoteBoard(remote, wanted) {
  const project = await remote.project()
  if (!project.boards.length) throw new Error(`Nothing is pushed to ${project.project.name} yet. Run "shapewall push".`)
  if (wanted) {
    if (!project.boards.some((item) => item.id === wanted))
      throw new Error(`No board "${wanted}" on ${project.project.name} (have: ${project.boards.map((item) => item.id).join(', ')})`)
    return { project, boardId: wanted }
  }
  return { project, boardId: project.boards[0].id }
}

// A change's --json: the same { trust, note, board, comment } as locally.
function mutationJson(boardId, answer, extra = {}) {
  return JSON.stringify(untrustedJson({ board: remoteBoardRef(boardId, answer), comment: answer.comment, ...extra }), null, 2)
}

export async function remoteComments(positional, flags, print) {
  // --json prints JSON as is (escaped); text is cleaned before printing.
  const out = (text) => print(flags.json ? text : terminalSafe(text))
  const remote = createRemote(remoteSettings(flags))
  const { boardId } = await remoteBoard(remote, flags.board)
  const action = positional[0] || 'list'
  if (action === 'list') {
    const status = flags.all ? 'all' : flags.resolved ? 'resolved' : 'open'
    const report = await remote.comments(boardId, {
      status,
      page: flags.page || null,
      mention: mentionOf(flags.mention),
      guests: Boolean(flags['include-guests']),
    })
    out(
      flags['for-agent']
        ? formatFeedbackForAgent(report)
        : flags.json
          ? JSON.stringify(untrustedJson(report), null, 2)
          : formatFeedback(report),
    )
    return
  }
  const id = positional[1]
  // A share link guest's comment needs --include-guests here too.
  const guests = Boolean(flags['include-guests'])
  if (action === 'get' || action === 'show') {
    if (!id) throw new Error('usage: shapewall comments get ID [--json] [--for-agent] --remote URL')
    const answer = await remote.comment(boardId, id, { guests })
    if (flags['for-agent']) out(formatFeedbackItemForAgent(answer.comment, boardId))
    else if (flags.json) out(JSON.stringify(untrustedJson({ board: answer.board, comment: answer.comment }), null, 2))
    else out(formatFeedbackItem(answer.comment).join('\n'))
    return
  }
  if (action === 'add') {
    const page = typeof flags.page === 'string' ? flags.page.trim() : ''
    const body = typeof flags.body === 'string' ? flags.body : ''
    if (!page || !body.trim()) throw new Error('usage: shapewall comments add --page ID --body TEXT [--viewport NAME] --remote URL')
    if (flags.selector !== undefined || flags.author !== undefined)
      throw new Error("comments add --remote takes --page, --body and --viewport (the server signs it with the token's name).")
    const result = await remote.addComment(boardId, {
      page,
      body,
      viewport: typeof flags.viewport === 'string' ? flags.viewport : undefined,
    })
    out(flags.json ? mutationJson(boardId, result) : `Added #${result.comment.id} on ${page}`)
    return
  }
  if (action === 'resolve' || action === 'reopen') {
    if (!id) throw new Error(`usage: shapewall comments ${action} ID --remote URL`)
    const result =
      action === 'resolve'
        ? await remote.resolve(boardId, id, {
            note: typeof flags.note === 'string' ? flags.note : undefined,
            fixRef: typeof flags.ref === 'string' ? flags.ref : undefined,
            guests,
          })
        : await remote.reopen(boardId, id, { guests })
    out(flags.json ? mutationJson(boardId, result) : `#${result.comment.id} is ${result.comment.status}`)
    return
  }
  if (action === 'reply') {
    const body = typeof flags.body === 'string' ? flags.body : positional[2]
    if (!id || !body) throw new Error('usage: shapewall comments reply ID --body TEXT --remote URL')
    const result = await remote.reply(boardId, id, { body, guests })
    out(
      flags.json
        ? mutationJson(boardId, result, { reply: result.reply })
        : `Replied to #${result.comment.id} as ${result.reply?.author || 'this token'}`,
    )
    return
  }
  if (action === 'status') {
    const value = positional[2]
    if (!id || !value) throw new Error(`usage: shapewall comments status ID ${[...AGENT_STATUSES, 'clear'].join('|')} --remote URL`)
    if (![...AGENT_STATUSES, 'clear'].includes(value)) {
      throw new Error(`unknown status '${value.slice(0, 40)}' (use: ${[...AGENT_STATUSES, 'clear'].join(', ')})`)
    }
    if (typeof flags.note === 'string' && flags.note.trim()) {
      await remote.reply(boardId, id, { body: flags.note, guests })
    }
    const result = await remote.setAgentStatus(boardId, id, value === 'clear' ? null : value, { guests })
    out(flags.json ? mutationJson(boardId, result) : `#${result.comment.id} agent status: ${result.comment.agentStatus || 'none'}`)
    return
  }
  throw new Error(`unknown comments action "${action}" (list, resolve, reopen, reply, status)`)
}
