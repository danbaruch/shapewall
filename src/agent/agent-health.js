// How each connected agent is doing, in plain words, for the agent picker
// and Settings: derived only from what this server already saw (the last
// turn or connection test, and agent processes starting right now). Nothing
// polls an agent to find out.
//
//   ready           connected, and the last turn or test went fine (or none yet)
//   login           the last turn or test said it is not logged in (agent_auth)
//   starting        an agent process for it is starting now
//   not-responding  the last turn or test: it did not start, did not answer
//                   in time, or stopped
//   unavailable     not set up (no command, a removed profile)
//
// Kept in memory per server process; a restart starts from "ready".

import { loginHint } from './acp/command.js'

export const AGENT_STATES = ['ready', 'login', 'starting', 'not-responding', 'unavailable']

// One key per thing that runs: the default connection and the profile that
// runs the same command share what was learned about it.
export function healthKey(settings) {
  if (!settings) return null
  if (settings.backend === 'acp') return settings.acp?.argv ? `acp:${settings.acp.argv.join('\u0000')}` : null
  return settings.baseUrl ? `api:${settings.baseUrl}|${settings.model || ''}` : null
}

// What one turn (a stored reply: { status, error }) or connection test
// ({ ok, code, message }) says: 'ok', 'login', 'not-responding', or null
// when it says nothing about the agent (stopped by the person, a tool error,
// a long answer cut at the time limit).
export function outcomeOf(result) {
  if (!result) return null
  if (result.ok === true) return 'ok'
  const code = result.ok === false ? result.code : result.error?.code
  if (code === 'agent_auth') return 'login'
  if (result.ok === false) return /not (logged|signed) in/i.test(result.message || '') ? 'login' : 'not-responding'
  if (['agent_start', 'agent_exited'].includes(code)) return 'not-responding'
  if (result.status === 'done' && !result.error) return 'ok'
  return null
}

// The state of one agent. `outcome`: the last outcomeOf; `starting`: an
// agent process for it is starting now.
export function agentState({ configured, outcome = null, starting = false }) {
  if (!configured) return 'unavailable'
  if (starting) return 'starting'
  if (outcome === 'login') return 'login'
  if (outcome === 'not-responding') return 'not-responding'
  return 'ready'
}

// The store: record(settings, result) after a turn or test, and
// status(settings, pool) for the fields the board gets:
// { state, loginHint } (loginHint only for a native agent).
export function createAgentHealth() {
  const last = new Map()
  return {
    record(settings, result) {
      const key = healthKey(settings)
      const outcome = outcomeOf(result)
      if (key && outcome) last.set(key, outcome)
    },
    outcome(settings) {
      return last.get(healthKey(settings)) || null
    },
    status(settings, processPool = null) {
      const argv = settings?.acp?.argv ? settings.acp.argv.join('\u0000') : null
      const starting = Boolean(
        argv && [...(processPool?.agents || [])].some((agent) => agent.state === 'starting' && (agent.argv || []).join('\u0000') === argv),
      )
      const state = agentState({ configured: Boolean(settings?.configured), outcome: last.get(healthKey(settings)) || null, starting })
      return { state, ...(settings?.backend === 'acp' && settings.acp?.argv ? { loginHint: loginHint(settings.acp.argv) } : {}) }
    },
  }
}
