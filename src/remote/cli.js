// Command-line parts that talk to a hosted Shapewall: `push`, `hosted`, and
// the --remote forms of `comments`, `watch` and `mcp`.

import { portableChecks } from '../checks/transport.js'
import { getBoard, loadConfig } from '../config.js'
import { formatFeedback, formatFeedbackForAgent, untrustedJson } from '../feedback.js'
import { AGENT_STATUSES, readManifest, readVariants } from '../store.js'
import { createRemote, pushDefinition, pushFiles, readCaptureFile, remoteSettings } from './remote.js'
import { safeOut, terminalSafe } from './terminal.js'

export async function push(flags, print) {
  // Names and URLs here come from the server: cleaned before printing.
  const out = safeOut(print)
  const config = loadConfig(flags.config)
  const remote = createRemote(remoteSettings(flags))
  const boards = flags.board ? [getBoard(config, flags.board)] : config.boards
  const project = await remote.project()
  for (const board of boards) {
    const manifest = readManifest(config, board.id)
    if (!manifest) throw new Error(`Board "${board.id}" has no captures yet. Run "shapewall capture --board ${board.id}" first.`)
    const checks = portableChecks(config, board, { includeChecks: !!flags['include-checks'] })
    const files = pushFiles(config, board)
    const started = await remote.startPush(pushDefinition(config, board))
    if (checks && !started.limits.checks)
      throw new Error('This server does not support checks. Update it before explicitly including diagnostics.')
    out(`Pushing board "${board.id}" (${files.length} files) to ${project.workspace.name} / ${project.project.name}`)
    let bytes = 0
    let done = 0
    for (const [area, name, file] of files) {
      // A server from before element maps does not take them (its boards keep x/y pins).
      if (name.endsWith('.elements.json') && !started.limits.elements) continue
      // Never through a symlink (see readCaptureFile).
      const data = readCaptureFile(config, file)
      const cap = name.endsWith('.html')
        ? started.limits.html
        : name.endsWith('.elements.json')
          ? started.limits.elements
          : started.limits.png
      if (data.length > cap) {
        out(`  skipped ${area}/${name}: ${(data.length / 1048576).toFixed(1)} MB is over the server's cap`)
        continue
      }
      await remote.pushFile(started.id, area, name, data)
      bytes += data.length
      done += 1
      if (done % 25 === 0) out(`  ${done}/${files.length} files`)
    }
    const result = await remote.commitPush(started.id, { manifest, variants: readVariants(config, board.id), checks })
    if (checks && result.checks !== checks.reports.length) throw new Error('The server did not confirm all included check reports.')
    out(`Pushed ${result.files} files (${(bytes / 1048576).toFixed(1)} MB). Board: ${result.url}`)
  }
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
  if (action === 'resolve' || action === 'reopen') {
    if (!id) throw new Error(`usage: shapewall comments ${action} ID --remote URL`)
    const { comment } =
      action === 'resolve'
        ? await remote.resolve(boardId, id, {
            note: typeof flags.note === 'string' ? flags.note : undefined,
            fixRef: typeof flags.ref === 'string' ? flags.ref : undefined,
            guests,
          })
        : await remote.reopen(boardId, id, { guests })
    out(flags.json ? JSON.stringify({ comment }, null, 2) : `#${comment.id} is ${comment.status}`)
    return
  }
  if (action === 'reply') {
    const body = typeof flags.body === 'string' ? flags.body : positional[2]
    if (!id || !body) throw new Error('usage: shapewall comments reply ID --body TEXT --remote URL')
    const { comment, reply } = await remote.reply(boardId, id, { body, guests })
    out(flags.json ? JSON.stringify({ comment, reply }, null, 2) : `Replied to #${comment.id} as ${reply.author}`)
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
    const { comment } = await remote.setAgentStatus(boardId, id, value === 'clear' ? null : value, { guests })
    out(flags.json ? JSON.stringify({ comment }, null, 2) : `#${comment.id} agent status: ${comment.agentStatus || 'none'}`)
    return
  }
  throw new Error(`unknown comments action "${action}" (list, resolve, reopen, reply, status)`)
}
