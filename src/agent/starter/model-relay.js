// The host side of the agent's model calls (rpc.js method "model").
//
// The agent in the container never holds the API key and never talks to the
// model endpoint itself. It sends the chat completions body here; the host
// sends it to the configured endpoint only, with the key, and streams the
// answer back. That makes the host the authority on the budget:
//
// - turns: one per model call; a call past the budget is refused;
// - tokens: counted from the usage the endpoint reports in the stream (or
//   estimated at 4 characters a token when it does not), and each call's
//   max_tokens is capped at what is left; a call past the budget is refused;
// - the model name, the endpoint and the key are the host's: the request's
//   own `model` is replaced, and only messages, tools, stream_options and
//   max_tokens are taken from it.
//
// Anything the endpoint answers is passed back with the key removed.

import { agentKey } from '../config.js'
import { redact } from '../backends/openai.js'
import { pause } from './pause.js'

// Time to the response headers of one model call. Until the model first
// answers in a run it may still be loading (a local model on a cold start
// takes minutes), so the first wait is longer. settings.modelTimeoutMs
// (starterAgent.modelTimeoutSeconds, --model-timeout) sets both.
export const FIRST_CALL_TIMEOUT_MS = 180000
export const CALL_TIMEOUT_MS = 60000
// A timeout or a connection failure is tried once more, after this pause
// (none after a timeout: the wait was long enough).
const RETRY_PAUSE_MS = 1000
const ERROR_BODY_MAX = 4000
const DEFAULT_ANSWER_TOKENS = 4096
const MESSAGES_MAX = 400

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// The usage reported in server-sent event lines (or one JSON body).
function usageFrom(text) {
  let total = null
  for (const line of text.split('\n')) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : null
    if (!data || data === '[DONE]' || !data.includes('usage')) continue
    try {
      const usage = JSON.parse(data).usage
      // The last report wins: some servers repeat a running total in every chunk.
      if (usage) total = Number(usage.total_tokens) || (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0)
    } catch {
      /* not JSON */
    }
  }
  if (total === null && text.trim().startsWith('{')) {
    try {
      const usage = JSON.parse(text).usage
      if (usage) total = Number(usage.total_tokens) || 0
    } catch {
      /* not JSON */
    }
  }
  return total
}

// A message as it goes to the model: only the fields chat completions use,
// and in content only text and inline (data:) images. A remote image URL
// would have the provider fetch it: a way out of the sandbox.
const ROLES = new Set(['system', 'user', 'assistant', 'tool'])
function cleanMessage(message) {
  if (!isObject(message) || !ROLES.has(message.role)) return { role: 'user', content: '' }
  const out = { role: message.role }
  if (typeof message.content === 'string' || message.content === null) out.content = message.content
  else if (Array.isArray(message.content)) {
    out.content = message.content
      .filter((part) => isObject(part))
      .flatMap((part) => {
        if (part.type === 'text' && typeof part.text === 'string') return [{ type: 'text', text: part.text }]
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
        if (part.type === 'image_url' && typeof url === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(url)) {
          return [{ type: 'image_url', image_url: { url } }]
        }
        return [{ type: 'text', text: '[Shapewall: a part that is not text or an inline image was removed]' }]
      })
  } else out.content = ''
  // Earlier calls of the agent's own function tools, and only those fields.
  if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
    const calls = message.tool_calls.flatMap((call) =>
      isObject(call) && (call.type === undefined || call.type === 'function') && isObject(call.function)
        ? [
            {
              ...(typeof call.id === 'string' ? { id: call.id.slice(0, 200) } : {}),
              type: 'function',
              function: {
                name: String(call.function.name || '').slice(0, 64),
                arguments: typeof call.function.arguments === 'string' ? call.function.arguments : '{}',
              },
            },
          ]
        : [],
    )
    if (calls.length) out.tool_calls = calls
  }
  if (message.role === 'tool' && typeof message.tool_call_id === 'string') out.tool_call_id = message.tool_call_id
  if (typeof message.name === 'string') out.name = message.name.slice(0, 64)
  return out
}

// A tool as it goes to the model: { type: 'function', function: { name,
// description, parameters } } and nothing else, or null.
function cleanTool(tool) {
  if (!isObject(tool) || tool.type !== 'function' || !isObject(tool.function)) return null
  const { name, description, parameters } = tool.function
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) return null
  return {
    type: 'function',
    function: {
      name,
      ...(typeof description === 'string' ? { description: description.slice(0, 4000) } : {}),
      ...(isObject(parameters) ? { parameters } : {}),
    },
  }
}

const seconds = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`)

// createModelRelay({ settings, env, budget, send, fetchImpl, deadline }) ->
//   { handle(callMessage), cancel(id), stopAll(), usage, stop }
// deadline: the run's end (ms since the epoch); no retry and no wait past it.
export function createModelRelay({
  settings,
  env = process.env,
  budget,
  send,
  fetchImpl = globalThis.fetch,
  log = () => {},
  deadline = null,
  now = () => Date.now(),
  retryPauseMs = RETRY_PAUSE_MS,
}) {
  const usage = { turns: 0, tokens: 0, estimated: false }
  const running = new Map()
  const state = { stop: null, answered: false }
  const timeoutMs = () => settings.modelTimeoutMs || (state.answered ? CALL_TIMEOUT_MS : FIRST_CALL_TIMEOUT_MS)
  const timeLeft = () => (deadline === null ? Infinity : deadline - now())

  // One request to the endpoint, at most twice: a timeout or a connection
  // failure (no answer at all) is tried once more, within the same turn.
  // -> { response } | { error: 'cancelled' | 'could not reach it: ...' }
  async function connect(url, init, call, key) {
    let reason = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const limit = Math.min(timeoutMs(), timeLeft())
      if (limit <= 0) break
      const attemptController = new AbortController()
      const onCancel = () => attemptController.abort('cancelled')
      call.signal.addEventListener('abort', onCancel, { once: true })
      const timer = setTimeout(() => attemptController.abort('timeout'), limit)
      try {
        // On success the cancel link stays: cancelling the call stops reading its body.
        const response = await fetchImpl(url, { ...init, signal: attemptController.signal })
        state.answered = true
        return { response }
      } catch (error) {
        call.signal.removeEventListener('abort', onCancel)
        if (call.signal.aborted) return { error: 'cancelled' }
        reason = attemptController.signal.aborted ? `timed out after ${seconds(limit)}` : redact(error.cause?.code || error.message, key)
      } finally {
        clearTimeout(timer)
      }
      if (attempt === 1) {
        log(`no answer (${reason}); trying once more`)
        await pause(reason.startsWith('timed out') ? 0 : Math.min(retryPauseMs, Math.max(0, timeLeft())), call.signal)
        if (call.signal.aborted) return { error: 'cancelled' }
      }
    }
    log(`no answer (${reason || 'the time budget ran out'})`)
    return { error: `could not reach it: ${reason || 'the time budget ran out'}` }
  }

  const refuse = (id, status, message) => {
    send({ t: 'head', id, status, contentType: 'application/json' })
    send({ t: 'chunk', id, data: JSON.stringify({ error: { message } }) })
    send({ t: 'end', id })
  }

  async function handle(message) {
    const id = message.id
    const body = message.params?.body
    if (!isObject(body) || !Array.isArray(body.messages) || body.messages.length > MESSAGES_MAX) {
      return refuse(id, 400, 'Shapewall: a chat completions body with messages is needed')
    }
    if (usage.turns >= budget.turns) {
      state.stop = 'turns'
      return refuse(id, 429, 'Shapewall: the turn budget for this comment is used up')
    }
    if (usage.tokens >= budget.tokens) {
      state.stop = 'tokens'
      return refuse(id, 429, 'Shapewall: the token budget for this comment is used up')
    }
    // One call at a time: concurrent calls would each see the whole budget left.
    if (running.size) return refuse(id, 429, 'Shapewall: one model call at a time')
    const messages = body.messages.map(cleanMessage)
    // Function tools only (the agent's own, run in the sandbox): a provider-side
    // tool (web_search, browser, code_interpreter, ...) would act outside it.
    const functions = Array.isArray(body.tools) ? body.tools.map(cleanTool).filter(Boolean) : []
    const tools = functions.length ? functions : null
    // The prompt's size is reserved up front, with the answer's max_tokens.
    const prompt = Math.ceil(JSON.stringify([messages, tools]).length / 4)
    const left = budget.tokens - usage.tokens - prompt
    if (left < 1) {
      state.stop = 'tokens'
      return refuse(id, 429, 'Shapewall: the token budget for this comment is used up')
    }
    usage.turns += 1
    const asked =
      Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : settings.model.maxTokens || DEFAULT_ANSWER_TOKENS
    const out = { model: settings.model.model, messages, stream: true, max_tokens: Math.min(asked, left) }
    if (tools) out.tools = tools
    if (body.stream_options?.include_usage === true) out.stream_options = { include_usage: true }
    if (settings.model.temperature !== null && settings.model.temperature !== undefined) out.temperature = settings.model.temperature
    const key = settings.model.keyVar ? agentKey({ keyVar: settings.model.keyVar }, env) : null
    const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
    if (key) headers.Authorization = `Bearer ${key}`
    const requestBody = JSON.stringify(out)
    const controller = new AbortController()
    if (running.size) return refuse(id, 429, 'Shapewall: one model call at a time')
    running.set(id, controller)
    const connected = await connect(
      `${settings.model.baseUrl}/chat/completions`,
      { method: 'POST', headers, body: requestBody, redirect: 'error' },
      controller,
      key,
    )
    if (!connected.response) {
      running.delete(id)
      // Read once as it is: the container passes the host's words on unwrapped.
      send({ t: 'end', id, error: connected.error })
      return
    }
    const response = connected.response
    let seen = ''
    // The end goes out last, after the call is off the books: the agent may
    // send its next call the moment it reads it.
    let end = { t: 'end', id }
    try {
      const contentType = String(response.headers.get('content-type') || 'application/json')
      if (!response.ok) {
        const text = redact((await response.text().catch(() => '')).slice(0, ERROR_BODY_MAX), key)
        send({ t: 'head', id, status: response.status, contentType })
        send({ t: 'chunk', id, data: text })
        log(`model answered ${response.status}`)
        return
      }
      send({ t: 'head', id, status: response.status, contentType })
      const decoder = new TextDecoder()
      for await (const chunk of response.body) {
        const text = decoder.decode(chunk, { stream: true })
        // Kept for the usage count: the tail is enough for the last event.
        seen = (seen + text).slice(-200000)
        send({ t: 'chunk', id, data: redact(text, key) })
      }
    } catch (error) {
      end = { t: 'end', id, error: controller.signal.aborted ? 'cancelled' : `the answer broke off (${redact(error.message, key)})` }
    } finally {
      running.delete(id)
      const reported = usageFrom(seen)
      if (reported === null) {
        usage.estimated = true
        usage.tokens += Math.ceil((requestBody.length + seen.length) / 4)
      } else usage.tokens += reported
      send(end)
    }
  }

  return {
    usage,
    get stop() {
      return state.stop
    },
    // The wait for the next call's headers (the first call's is longer).
    get timeoutMs() {
      return timeoutMs()
    },
    handle,
    cancel(id) {
      running.get(id)?.abort('cancelled')
    },
    stopAll() {
      for (const controller of running.values()) controller.abort('cancelled')
    },
  }
}
