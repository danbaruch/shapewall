// `shapewall agent connect --endpoint` (1.5.0; plan R2): a model endpoint
// (Ollama, DeepSeek, OpenAI or any OpenAI-compatible chat completions
// server) as a connected agent, behind the same link protocol as a coding
// agent (agent-link.js). So the solo engine's own agent can be an endpoint,
// and a hosted board gains endpoint agents as a side effect.
//
// What this machine holds it to, whatever the server sends:
//   - read and answer only: no edits, no commands, no browser, no extensions
//     (approvals are "none" and cannot be raised: a model endpoint has no
//     way to make an edit this machine could check before it lands);
//   - no tools at all on the link: the turn's conversation is built from the
//     job (agent-job.js), already quoted as data, and the model answers in
//     text (`tools: 'none'`); Shapewall's local board tools need the 1.x
//     store, which a connected agent does not have;
//   - no images (the job carries none yet);
//   - the endpoint and its key are this machine's: agentSettings
//     (src/agent/config.js) from the environment, Settings > Agent and the
//     config, the same rules as the local chat (https for a key, plain http
//     only to this machine, a key host confirmed). The key is read from its
//     variable per request, and never printed, logged, stored, or sent to
//     the server: errors pass through the backend's own redaction.

import { agentSettings } from '../agent/config.js'
import { createOpenAIBackend } from '../agent/backends/openai.js'

// The endpoint settings for this project (Settings > Agent, the config, the environment), checked.
export function endpointSettings(config, env = process.env) {
  const settings = agentSettings(config, env)
  if (settings.backend === 'acp')
    throw new Error(
      'agent connect --endpoint runs a model endpoint, but this project is set to a coding agent (Settings > Agent). Leave --endpoint out to connect that agent.',
    )
  if (!settings.configured)
    throw new Error(
      `No model endpoint is set up for this project${settings.problem ? ` (${settings.problem})` : ''}. Set agent.baseUrl and agent.model in shapewall.config.json or Settings > Agent (or SHAPEWALL_AGENT_BASE_URL and SHAPEWALL_AGENT_MODEL), and the key in its variable (${settings.keyVar}).`,
    )
  return settings
}

// Where the endpoint is, for this terminal: the host only (never a path or a query, which may carry a key).
export function endpointHost(baseUrl) {
  try {
    return new URL(baseUrl).host || 'its address'
  } catch {
    return 'its address'
  }
}

// The backend a link turn streams from: the chat completions backend with
// no tools and no images, read only.
export function createEndpointBackend(settings, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const inner = createOpenAIBackend({ ...settings, tools: false, vision: false }, { env, fetchImpl })
  return {
    id: 'endpoint',
    tools: 'none',
    vision: false,
    readOnly: true,
    // Only what the chat completions backend takes; everything else a turn passes (a fix's workdir, MCP servers,
    // extensions, a permission gate) has no meaning here and is dropped, so nothing of it reaches the endpoint.
    stream({ system, messages, signal, model = null }) {
      return inner.stream({ system, messages, tools: [], signal, model })
    },
    answerPermission() {},
    resetThread() {},
    close() {},
  }
}
