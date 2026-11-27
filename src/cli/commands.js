// The commands whose handling used to sit inline in main(): buzz-bridge,
// settings, journeys, events, mcp and export.

import fs from 'node:fs'
import path from 'node:path'
import { findConfigFile, getBoard, loadConfig } from '../config.js'
import { formatJourneys, listJourneys } from '../journeys.js'
import { openBrowser } from './open.js'
import { withNotifications } from './notify.js'
import { agentRunEnv } from '../agent-run.js'

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
  // Once cleanup is done the process exits itself. Left to end on its own,
  // Node first drops its signal handlers and then takes a few milliseconds to
  // tear down, and a second Ctrl-C (or a SIGTERM right after a SIGINT) that
  // lands in that gap kills it by signal instead of exiting 0.
  const close = () =>
    management
      .close()
      .catch((error) => {
        err(`Agent settings cleanup failed: ${error.message}`)
        process.exitCode = 1
      })
      .finally(() => process.exit())
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
  else if (flags.open) openBrowser(management.app.locals.openLink(management.url), out)
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
  // An MCP server runs for an agent: it and what it starts are an agent's
  // process (src/agent-run.js), whichever app started it.
  Object.assign(process.env, agentRunEnv())
  if (flags.remote !== undefined) {
    const { createRemote, remoteSettings } = await import('../remote/remote.js')
    const { runRemoteMcp } = await import('../remote/remote-mcp.js')
    const readOnly = Boolean(flags['read-only'])
    const allowCapture = !readOnly && !flags['no-capture']
    const board = typeof flags.board === 'string' ? flags.board : null
    // On this project's solo engine (src/cli/engine-mode.js) the tools keep the 1.x `author` argument.
    const settings = remoteSettings(flags)
    await runRemoteMcp({
      remote: createRemote(settings),
      readOnly,
      board,
      allowCapture,
      config: allowCapture ? remoteMcpConfig(flags, err) : null,
      localAuthor: settings.source === 'engine',
    })
    return 0
  }
  if (flags.board !== undefined) throw new Error('mcp --board picks a hosted board: use it with --remote URL.')
  const config = loadConfig(flags.config)
  const { runMcp } = await import('../mcp.js')
  const readOnly = Boolean(flags['read-only'])
  // stdout is the MCP protocol, so notification log lines go to stderr.
  await withNotifications(config, err, () => runMcp({ config, readOnly, allowCapture: !readOnly && !flags['no-capture'] }))
  return 0
}

// The project config `mcp --remote` captures with (recapture_pages): found
// as every command finds it (--config FILE, $SHAPEWALL_CONFIG, else
// ./shapewall.config.json). Without one the server runs as before, with no
// recapture_pages; a config that was named but cannot load is an error, and
// one found but broken turns recapture off with a line on stderr.
export function remoteMcpConfig(flags, err = () => {}, { env = process.env, cwd = process.cwd() } = {}) {
  const named = typeof flags.config === 'string' || Boolean(env.SHAPEWALL_CONFIG)
  if (!named && !fs.existsSync(findConfigFile(null, cwd))) return null
  try {
    return loadConfig(flags.config, { cwd })
  } catch (error) {
    if (named) throw error
    err(`recapture_pages is off: ${error.message}`)
    return null
  }
}

export async function exportCommand(flags, out) {
  const config = loadConfig(flags.config)
  const { exportStatic } = await import('../export.js')
  const result = await exportStatic(config, {
    out: flags.out || 'shapewall-export',
    includeComments: !flags['no-comments'],
    includeChecks: Boolean(flags['include-checks']),
    browserComments: Boolean(flags['browser-comments']),
    noindex: Boolean(flags['no-index']),
  })
  out(`Exported ${result.boards} board${result.boards === 1 ? '' : 's'} (${result.files} files) to ${result.out}`)
  if (result.comments)
    out(
      `It includes ${result.comments} comment${result.comments === 1 ? '' : 's'}, with their authors and replies; --no-comments leaves them out.`,
    )
  const shown = path.relative(process.cwd(), result.out) || '.'
  out(`View it: npx serve ${/^[\w./-]+$/.test(shown) ? shown : JSON.stringify(shown)} (opening index.html from disk does not work)`)
  return 0
}
