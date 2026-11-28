// `shapewall watch`: hand each new open comment to an agent.

import fs from 'node:fs'
import { findConfigFile, loadConfig } from '../config.js'
import { assertMigrationAllows } from '../engine-folder.js'
import { ENGINE_TARGET } from '../engine-target.js'
import { assertNotEngineBoard } from './board-home.js'
import { mentionFlag, startNotifier } from './notify.js'
import { durationFlag } from './duration.js'

export async function watch(flags, out, err) {
  const isRemote = flags.remote !== undefined || Boolean(process.env.SHAPEWALL_REMOTE)
  const config = isRemote ? null : loadConfig(flags.config)
  // A local watch writes the local store: not on an engine project, and not during or after a migration.
  if (config) {
    await assertNotEngineBoard(config, 'shapewall watch', 'Run it without SHAPEWALL_NO_ENGINE, or start shapewall serve.')
    assertMigrationAllows(config, { local: true, boardIds: typeof flags.board === 'string' ? [flags.board] : null })
  }
  const { watchComments } = await import('../watch.js')
  const number = (name, fallback) => {
    if (flags[name] === undefined) return fallback
    const value = Number(flags[name])
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`)
    return value
  }
  // --timeout: 60 minutes unless given; a bare number is minutes, as in 0.x.
  const timeoutMs =
    flags.timeout === undefined ? 60 * 60000 : durationFlag(flags.timeout, { flag: 'timeout', unit: 'm', min: 1000, max: 7 * 24 * 3600000 })
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const notifier = config ? await startNotifier(config, err) : null
  try {
    if (isRemote) {
      if (flags.recapture) throw new Error('--recapture works with local --exec only')
      // This project's solo engine (engine-mode.js set the remote): --no-claim looks there as on a 1.x board.
      const engine = Boolean(flags[ENGINE_TARGET])
      if (flags['no-claim'] && !engine)
        throw new Error("--no-claim works on this project's board only (its solo engine or a 1.x board), not with --remote")
      const { createRemote, remoteSettings } = await import('../remote/remote.js')
      const { remoteBoard } = await import('../remote/cli.js')
      const { watchRemote } = await import('../remote/remote-watch.js')
      const remote = createRemote(remoteSettings(flags))
      const { project, boardId } = await remoteBoard(remote, flags.board)
      // A local config here (or --config) decides where the agent's files go (its outputDir).
      const local = fs.existsSync(findConfigFile(flags.config)) ? loadConfig(flags.config) : null
      await watchRemote({
        remote,
        outputDir: local?.outputDir || null,
        boardId,
        passToken: Boolean(flags['pass-token']),
        includeGuests: Boolean(flags['include-guests']),
        projectId: project.project.id,
        exec: typeof flags.exec === 'string' ? flags.exec : null,
        concurrency: number('concurrency', 1),
        newOnly: Boolean(flags['new-only']),
        once: Boolean(flags.once),
        mention: mentionFlag(flags.mention),
        claim: !(engine && flags['no-claim']),
        timeoutMs,
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
      timeoutMs,
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
