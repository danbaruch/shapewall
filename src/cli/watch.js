// `shapewall watch`: hand each new open comment to an agent.

import { loadConfig } from '../config.js'
import { mentionFlag, startNotifier } from './notify.js'

export async function watch(flags, out, err) {
  const config = flags.remote === undefined ? loadConfig(flags.config) : null
  const { watchComments } = await import('../watch.js')
  const number = (name, fallback) => {
    if (flags[name] === undefined) return fallback
    const value = Number(flags[name])
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`)
    return value
  }
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const notifier = config ? await startNotifier(config, err) : null
  try {
    if (flags.remote !== undefined) {
      if (flags.recapture) throw new Error('--recapture works with local --exec only')
      if (flags['no-claim']) throw new Error('--no-claim works on a local board only (not with --remote)')
      const { createRemote, remoteSettings } = await import('../remote/remote.js')
      const { remoteBoard } = await import('../remote/cli.js')
      const { watchRemote } = await import('../remote/remote-watch.js')
      const remote = createRemote(remoteSettings(flags))
      const { project, boardId } = await remoteBoard(remote, flags.board)
      await watchRemote({
        remote,
        boardId,
        passToken: Boolean(flags['pass-token']),
        includeGuests: Boolean(flags['include-guests']),
        projectId: project.project.id,
        exec: typeof flags.exec === 'string' ? flags.exec : null,
        concurrency: number('concurrency', 1),
        newOnly: Boolean(flags['new-only']),
        once: Boolean(flags.once),
        mention: mentionFlag(flags.mention),
        timeoutMs: number('timeout', 60) * 60000,
        signal: controller.signal,
        out,
        log: err,
      })
      return
    }
    await watchComments({
      config,
      boardId: flags.board,
      exec: typeof flags.exec === 'string' ? flags.exec : null,
      concurrency: number('concurrency', 1),
      newOnly: Boolean(flags['new-only']),
      once: Boolean(flags.once),
      mention: mentionFlag(flags.mention),
      claim: !flags['no-claim'],
      recapture: Boolean(flags.recapture),
      timeoutMs: number('timeout', 60) * 60000,
      signal: controller.signal,
      out,
      log: err,
    })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    if (notifier) {
      await notifier.flush(5000)
      notifier.stop()
    }
  }
}
