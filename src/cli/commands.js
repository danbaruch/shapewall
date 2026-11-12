// The commands whose handling used to sit inline in main(): buzz-bridge,
// settings, journeys, events, mcp and export.

import { getBoard, loadConfig } from '../config.js'
import { formatJourneys, listJourneys } from '../journeys.js'
import { openBrowser } from './open.js'
import { withNotifications } from './notify.js'

export async function buzzBridge(flags, out) {
  if (typeof flags['bridge-config'] !== 'string') throw new Error('Use --bridge-config FILE for the private operator map.')
  const { startGateway } = await import('../buzz/gateway.js')
  const gateway = await startGateway(flags['bridge-config'])
  out('Private Buzz gateway ready on its owner-only Unix socket. Existing Buzz services and sessions are unchanged.')
  out('Keep this foreground process open; Ctrl-C stops only this gateway.')
  const stop = () => gateway.stop().finally(() => process.exit(0))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  return null
}

export async function settings(flags, out, err) {
  const { startAgentManagement } = await import('../agent/manage.js')
  // The handlers go in before the server says it is ready. A script (or a
  // quick Ctrl-C) may signal the moment it reads that line, and a signal
  // with no handler yet kills the process outright: no cleanup, and an exit
  // by signal where 0 is meant. A signal that lands while the server is
  // still starting is remembered and acted on as soon as it is up.
  let management = null
  let stopping = false
  const close = () =>
    management.close().catch((error) => {
      err(`Agent settings cleanup failed: ${error.message}`)
      process.exitCode = 1
    })
  const stop = () => {
    if (stopping) return
    stopping = true
    if (management) close()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    management = await startAgentManagement({ config: loadConfig(flags.config), port: Number(flags.port ?? 0), out })
  } catch (error) {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    throw error
  }
  if (stopping) close()
  else if (flags.open) openBrowser(`${management.url}${management.app.locals.openLink()}`, out)
  return null
}

export function journeys(positional, flags, out) {
  const action = positional[0] || 'list'
  if (action !== 'list') throw new Error(`unknown journeys action "${action}" (list)`)
  const config = loadConfig(flags.config)
  const board = getBoard(config, flags.board)
  const journeys = listJourneys(config, board)
  out(flags.json ? JSON.stringify({ board: board.id, journeys }, null, 2) : formatJourneys(board, journeys))
  return 0
}

export async function events(flags, out, err) {
  const config = loadConfig(flags.config)
  const { eventsCommand } = await import('../events-cli.js')
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await eventsCommand(config, flags, out, err, { signal: controller.signal })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
  return 0
}

export async function mcp(flags, err) {
  if (flags.remote !== undefined) {
    const { createRemote, remoteSettings } = await import('../remote/remote.js')
    const { runRemoteMcp } = await import('../remote/remote-mcp.js')
    await runRemoteMcp({ remote: createRemote(remoteSettings(flags)), readOnly: Boolean(flags['read-only']) })
    return 0
  }
  const config = loadConfig(flags.config)
  const { runMcp } = await import('../mcp.js')
  const readOnly = Boolean(flags['read-only'])
  // stdout is the MCP protocol, so notification log lines go to stderr.
  await withNotifications(config, err, () => runMcp({ config, readOnly, allowCapture: !readOnly && !flags['no-capture'] }))
  return 0
}

export async function exportCommand(flags, out) {
  const config = loadConfig(flags.config)
  const { exportStatic } = await import('../export.js')
  const result = await exportStatic(config, {
    out: flags.out || 'shapewall-export',
    includeComments: !flags['no-comments'],
    includeChecks: Boolean(flags['include-checks']),
    browserComments: Boolean(flags['browser-comments']),
    noindex: Boolean(flags.noindex),
  })
  out(`Exported ${result.boards} board${result.boards === 1 ? '' : 's'} (${result.files} files) to ${result.out}`)
  return 0
}
