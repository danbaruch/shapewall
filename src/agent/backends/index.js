// Chat backends: what the chat panel talks to.
//
// A backend is an object:
//
//   {
//     id: 'openai-compatible',
//     // 'shapewall': Shapewall offers its read-only board tools and runs them
//     // (src/agent/tools.js). 'own': the agent has its own tools and reports
//     // them as `tool` events (an ACP agent, later).
//     tools: 'shapewall' | 'own' | 'none',
//     vision: true,             // takes image parts
//     async *stream({ system, messages, tools, signal, thread }) { ... yield events ... },
//     runMsMax?: 1200000,       // how long one answer may take (default 5 minutes)
//     answerPermission?(thread, id, optionId),   // the person's answer to a permission card
//     close?(),                 // stop what the backend started (server shutdown)
//   }
//
// `thread` is "<board>/<thread>": a backend with a process per thread (ACP)
// keeps it across turns.
//
// `messages` are neutral: { role: 'user' | 'assistant' | 'tool', content: [{ type: 'text', text } |
// { type: 'image', mediaType, data }], toolCalls?: [{ id, name, args }], toolCallId? }. `system` is
// Shapewall's own prompt; board and comment text never goes there (src/agent/context.js).
//
// Events a backend yields:
//   { type: 'text', text }                         answer text, streamed
//   { type: 'reasoning', text }                    model thinking, shown collapsed
//   { type: 'status', text }                       a short status line
//   { type: 'tool_call', id, name, args }          the model asks for a Shapewall tool (tools: 'shapewall')
//   { type: 'tool', id, name, label?, state, detail? }  the agent ran its own tool (tools: 'own'); state running | done | error
//   { type: 'plan', entries: [{ content, status }] }    the agent's plan (tools: 'own')
//   { type: 'permission', id, title, kind, detail, options, state, chosen, expiresAt }
//                                                  the agent asks before it acts; state pending, then
//                                                  approved | denied | expired | cancelled
//   { type: 'done', finishReason }                 the turn ended
// Errors are thrown as AgentError (code, message), with any secret removed.
//
// The sandboxed starter agent plugs in here as another backend.

import { createAcpBackend } from './acp.js'
import { createOpenAIBackend } from './openai.js'

export { AgentError } from '../errors.js'

const FACTORIES = {
  'openai-compatible': createOpenAIBackend,
  acp: createAcpBackend,
}

// The backend for these settings (src/agent/config.js agentSettings), or
// null when chat is not connected. `root` (the project) and `protect` (the
// Shapewall store) are for ACP: what an agent may read and write.
export function createBackend(
  settings,
  { env = process.env, fetchImpl = globalThis.fetch, root, protect, sensitivePaths, limits, log, mcpServersFor, processPool } = {},
) {
  if (!settings.configured) return null
  const factory = FACTORIES[settings.backend]
  if (!factory) return null
  return factory(settings, { env, fetchImpl, root, protect, sensitivePaths, limits, log, mcpServersFor, processPool })
}
