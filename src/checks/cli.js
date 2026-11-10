import { checksView } from './store.js'
import { runChecks } from './runner.js'

export async function checksCommand(config, positional, flags, out, err = () => {}) {
  const action = positional[0] || 'run'
  if (action === 'flow' || action === 'accessibility') {
    const { flowCommand, accessibilityCommand } = await import('./flows.js')
    return (action === 'flow' ? flowCommand : accessibilityCommand)(config, positional.slice(1), flags, out, err)
  }
  if (action === 'list') {
    const result = checksView(config, flags.board || config.boards[0].id, flags.env || null)
    out(flags.json ? JSON.stringify(result, null, 2) : `${result.checked} of ${result.total} page views checked. Use --json for reports.`)
    return 0
  }
  if (action !== 'run') throw new Error('checks: use run, list, flow or accessibility.')
  // SIGTERM (the board's Stop, its time limit) or Ctrl-C stops the run after
  // the view in progress is abandoned; a second signal exits at once.
  const controller = new AbortController()
  const onSignal = () => {
    if (controller.signal.aborted) process.exit(130)
    controller.abort()
  }
  for (const s of STOP_SIGNALS) process.on(s, onSignal)
  let reports
  try {
    reports = await runChecks({
      config,
      boardId: flags.board,
      envId: flags.env,
      only: flags.only,
      // --seo or --no-seo, else the config's checks.seo default.
      seo: flags.seo ? true : flags['no-seo'] ? false : (config.checks?.seo ?? false),
      limit: flags.limit === undefined ? 20 : Number(flags.limit),
      sourceBuild: flags['source-build'],
      onProgress: flags.json ? err : out,
      signal: controller.signal,
    })
  } finally {
    for (const s of STOP_SIGNALS) process.off(s, onSignal)
  }
  const failed = reports.filter((r) => r.state === 'failed').length
  const stopped = reports.stopped
  out(
    flags.json
      ? JSON.stringify({ schemaVersion: 1, reports, ...(stopped ? { stopped } : {}) }, null, 2)
      : stopped
        ? `Stopped after ${stopped.checked} of ${stopped.total} page views. ${failed} failed. Page views not checked keep their earlier results.`
        : `Checked ${reports.length} page views. ${failed} failed. Reports are local and were not sent to an agent.`,
  )
  return stopped ? CHECKS_STOPPED_EXIT : failed ? 2 : 0
}

const STOP_SIGNALS = ['SIGTERM', 'SIGINT']
// Exit code of a run that was stopped before every page view was checked.
export const CHECKS_STOPPED_EXIT = 3
