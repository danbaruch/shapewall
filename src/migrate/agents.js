// This project's agent settings, read for `shapewall migrate`.
//
// They live outside the project (agents.json in the user's config folder,
// src/agent/user-settings.js), one entry per project folder: the backend,
// endpoint, profiles, icon and tint, branch mode, capabilities. No key was
// ever stored there, only the name of the variable that holds it, and no
// key moves now either.
//
// In 1.5.0 the entry stays where it is: the engine's local agent connects
// over the link protocol (R2) and reads these settings as the machine side
// of that agent. The migration reports what the entry holds, so the person
// sees that nothing about their agent is lost, and checks that it holds no
// secret.

import { userAgentEntry } from '../agent/user-settings.js'

// Keys that would mean a secret was written into the file by hand. The
// settings module refuses them on read too; this is the migration's own
// check, so a report never says "kept" about a key.
const SECRET_RE = /(^|_)(api[-_]?key|key|token|secret|password)$/i

function secretKeys(value, at = '') {
  if (!value || typeof value !== 'object') return []
  const found = []
  for (const [key, inner] of Object.entries(value)) {
    const where = at ? `${at}.${key}` : key
    if (SECRET_RE.test(key) && key !== 'apiKeyEnv' && typeof inner === 'string' && inner) found.push(where)
    found.push(...secretKeys(inner, where))
  }
  return found
}

// { file, entry: summary | null, problem }. The summary names what is set,
// never a value that could be a credential (the endpoint host is shown, the
// key variable's name too, which is not secret).
export function readAgentSettings(projectDir, env = process.env) {
  const { file, entry, problem } = userAgentEntry(projectDir, env)
  if (!entry) return { file, entry: null, problem }
  const secrets = secretKeys(entry)
  let host = null
  try {
    host = entry.baseUrl ? new URL(entry.baseUrl).host : null
  } catch {
    host = null
  }
  return {
    file,
    problem: secrets.length ? `the agent settings hold what looks like a secret (${secrets.join(', ')}); it is not carried` : null,
    entry: {
      backend: entry.backend || null,
      endpointHost: host,
      model: entry.model || null,
      keyVariable: entry.apiKeyEnv || null,
      acpCommand: Boolean(entry.acpCommand),
      profiles: Array.isArray(entry.profiles) ? entry.profiles.length : 0,
      icon: Boolean(entry.icon || entry.fixedAgent?.icon),
      branchMode: Boolean(entry.branchMode),
      capabilities: Boolean(entry.capabilities),
      agentConfig: Boolean(entry.agentConfig),
    },
  }
}
