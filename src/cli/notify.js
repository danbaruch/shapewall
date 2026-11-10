// Notifications: `shapewall notify`, and sending comment events while a command runs.

import { getBoard, loadConfig } from '../config.js'
import { MENTION_HANDLE_RE } from '../mentions.js'

// --mention NAME (with or without the @): a handle, or an error.
export function mentionFlag(value) {
  if (value === undefined) return null
  const handle = String(value).replace(/^@/, '').toLowerCase()
  if (!MENTION_HANDLE_RE.test(handle)) throw new Error('--mention needs a name like robin or agent')
  return handle
}

// Starts sending comment events to the configured channels; null when there
// are none. `serve: true` makes this the notifier for every process while it
// runs; otherwise only this process's own changes that no running server
// sends (src/notify/run.js). Log lines go to `log` (stderr for commands
// whose stdout is data).
export async function startNotifier(config, log, options = {}) {
  if (!config.notifications?.channels.length) return null
  const { startNotifications } = await import('../notify/run.js')
  return startNotifications(config, { log, ...options })
}

// Runs `work` with notifications on, then waits (up to 15 s) for its
// messages to go out before the command exits.
export async function withNotifications(config, log, work) {
  const notifier = await startNotifier(config, log)
  try {
    return await work()
  } finally {
    if (notifier) {
      if (!(await notifier.flush(15000))) log('notify: some messages were not sent before exit')
      notifier.stop()
    }
  }
}

export async function notify(positional, flags, out) {
  const config = loadConfig(flags.config)
  const { createNotifier, describeChannels, testEvent } = await import('../notify/index.js')
  const action = positional[0] || 'list'
  const people = Object.keys(config.notifications.people)
  if (action === 'list') {
    const list = describeChannels(config)
    if (flags.json) {
      out(JSON.stringify({ channels: list, people }, null, 2))
      return 0
    }
    if (!list.length) {
      out('No notification channels. Add notifications.channels to the config, or set SHAPEWALL_SLACK_WEBHOOK_URL (docs/notifications.md).')
      return 0
    }
    for (const item of list) {
      const email =
        item.type === 'email'
          ? `, ${item.mode === 'off' ? 'off' : `via ${item.mode}`}, ${item.to} fixed recipient${item.to === 1 ? '' : 's'}`
          : ''
      const boards = item.boards ? `  boards: ${item.boards.join(', ')}` : ''
      out(`${item.id}  ${item.type}${item.fromEnv ? ' (from the environment)' : ''}${email}`)
      out(`  events: ${item.events.map((name) => name.replace(/^comment\./, '')).join(', ')}${boards}`)
      out(`  ${item.ready ? 'ready' : `not ready: set ${item.missing.join(' and ')}`}`)
    }
    if (people.length) out(`People mapped for mentions: ${people.map((handle) => `@${handle}`).join(', ')}`)
    return 0
  }
  if (action === 'test') {
    const channel = config.notifications.channels.find((item) => item.id === positional[1])
    if (!channel) {
      const have = config.notifications.channels.map((item) => item.id)
      throw new Error(`usage: shapewall notify test CHANNEL (${have.length ? `have: ${have.join(', ')}` : 'no channels configured'})`)
    }
    const to = typeof flags.to === 'string' ? [flags.to] : undefined
    if (channel.type === 'email' && !to && !channel.to.length) throw new Error('this email channel has no "to" addresses; pass --to EMAIL')
    const notifier = createNotifier(config)
    const result = await notifier.deliver(channel, testEvent(config, getBoard(config, flags.board).id), { to })
    notifier.stop()
    if (result.ok) {
      out(result.file ? `Wrote a test message to ${result.file}` : `Sent a test message to ${channel.id} (HTTP ${result.status})`)
      return 0
    }
    const attempts = result.attempts > 1 ? ` (after ${result.attempts} attempts)` : ''
    out(`Could not send to ${channel.id}: ${result.error}${attempts}`)
    return 1
  }
  throw new Error(`unknown notify action "${action}" (list, test)`)
}
