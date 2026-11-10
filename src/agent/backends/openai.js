// The OpenAI-compatible chat completions backend: POST {baseUrl}/chat/completions
// with stream: true, read the server-sent events back. Works with OpenAI,
// DeepSeek, xAI, OpenRouter, Ollama, LM Studio, vLLM and anything else that
// speaks the same API. The key (optional, for local servers) is read from the
// environment per request and removed from any error text.

import { agentKey } from '../config.js'
import { NO_IMAGES_NOTE } from '../context.js'
import { AgentError } from '../errors.js'

const CONNECT_TIMEOUT_MS = 60000
// The composer's model picker: the endpoint's list, kept 10 minutes.
const MODELS_CACHE_MS = 10 * 60 * 1000
const MODELS_TIMEOUT_MS = 5000
export const MODELS_MAX = 100
const ERROR_BODY_MAX = 4000

// Neutral messages (backends/index.js) to the chat completions shape.
export function toOpenAIMessages(system, messages, { vision }) {
  const out = [{ role: 'system', content: system }]
  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.toolCallId, content: textOf(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const entry = { role: 'assistant', content: textOf(message.content) || (message.toolCalls?.length ? null : '') }
      if (message.toolCalls?.length) {
        entry.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        }))
      }
      out.push(entry)
      continue
    }
    const parts = []
    for (const part of message.content) {
      if (part.type === 'text') parts.push({ type: 'text', text: part.text })
      else if (part.type === 'image' && vision)
        parts.push({ type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } })
      else if (part.type === 'image') parts.push({ type: 'text', text: '[An image was attached, but this model does not take images.]' })
    }
    // Text-only messages as a plain string: some servers take nothing else.
    out.push({ role: 'user', content: parts.every((part) => part.type === 'text') ? parts.map((part) => part.text).join('\n\n') : parts })
  }
  return out
}

function textOf(content) {
  return (content || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
}

function toOpenAITools(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

// Keeps a secret out of anything shown or logged.
export function redact(text, secret) {
  let value = String(text ?? '')
  if (secret) value = value.split(secret).join('[redacted]')
  return value.replace(/\b(sk|gsk|xai|key)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
}

// Reads a server-sent event stream: yields each `data:` payload.
async function* sseData(body, signal) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    if (signal?.aborted) return
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, '')
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data) yield data
    }
  }
  const rest = buffer.trim()
  if (rest.startsWith('data:')) yield rest.slice(5).trim()
}

export function upstreamError(status, bodyText, key) {
  let message = ''
  try {
    const json = JSON.parse(bodyText)
    message = json?.error?.message || json?.message || (typeof json?.error === 'string' ? json.error : '')
  } catch {
    message = bodyText
  }
  message = redact(String(message || '').slice(0, 300), key).trim()
  const suffix = message ? `: ${message}` : ''
  if (status === 401 || status === 403) return new AgentError('agent_auth', `The model endpoint refused the API key (${status})${suffix}`)
  if (status === 404) return new AgentError('agent_not_found', `The model endpoint or model was not found (404)${suffix}`)
  if (status === 429) return new AgentError('agent_rate_limited', `The model endpoint is rate limiting or out of credit (429)${suffix}`)
  return new AgentError('agent_upstream', `The model endpoint answered ${status}${suffix}`)
}

// Servers and models without function calling answer 400 to `tools`.
const TOOLS_UNSUPPORTED = /tool|function/i
const USAGE_UNSUPPORTED = /stream_options|include_usage/i
// Models without vision answer 400 to image parts ("Multimodal data
// provided, but model does not support multimodal requests", "image_url is
// not supported", ...).
const IMAGES_UNSUPPORTED = /image|vision|multimodal|multi-modal/i

const hasImages = (messages) => messages.some((message) => (message.content || []).some((part) => part.type === 'image'))

// Token counts as the endpoint reports them (the starter agent's budget).
function usageEvent(usage) {
  const prompt = Number(usage?.prompt_tokens) || 0
  const completion = Number(usage?.completion_tokens) || 0
  const total = Number(usage?.total_tokens) || prompt + completion
  return { type: 'usage', prompt, completion, total }
}

export function createOpenAIBackend(settings, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  // Learned per server process and model: once a model refuses tools, ask without them.
  const toolsRefused = new Set()
  // settings.usage asks for token counts (stream_options.include_usage);
  // a server that refuses it is asked again without.
  let usageRefused = false
  // Once the endpoint refuses images, this model gets none (the chat says so).
  const imagesRefused = new Set()
  // The endpoint's own model list (GET {baseUrl}/models), for the composer's
  // picker: cached, bounded, and empty when the endpoint has none.
  let models = null
  return {
    id: 'openai-compatible',
    tools: settings.tools ? 'shapewall' : 'none',
    vision: settings.vision,
    async listModels() {
      if (models && Date.now() - models.at < MODELS_CACHE_MS) return models.ids
      const key = agentKey(settings, env)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS)
      let ids = []
      try {
        const response = await fetchImpl(`${settings.baseUrl}/models`, {
          method: 'GET',
          headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          signal: controller.signal,
          redirect: 'error',
        })
        if (response.ok) {
          const json = await response.json().catch(() => null)
          ids = [...new Set((Array.isArray(json?.data) ? json.data : []).map((item) => String(item?.id ?? '')))]
            // eslint-disable-next-line no-control-regex
            .filter((id) => id && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id))
            .sort((a, b) => a.localeCompare(b))
            .slice(0, MODELS_MAX)
        }
      } catch {
        ids = []
      } finally {
        clearTimeout(timer)
      }
      models = { at: Date.now(), ids }
      return ids
    },
    // `model`: this chat's choice from the endpoint's own list (the
    // composer's picker, routes.js); the configured model otherwise.
    async *stream({ system, messages, tools = [], signal, model: chosen = null }) {
      const model = chosen || settings.model
      const key = agentKey(settings, env)
      const vision = settings.vision && !imagesRefused.has(model)
      const withImages = vision && hasImages(messages)
      if (imagesRefused.has(model) && hasImages(messages.slice(-1))) yield { type: 'notice', text: NO_IMAGES_NOTE }
      const useTools = tools.length > 0 && !toolsRefused.has(model)
      const body = {
        model,
        stream: true,
        messages: toOpenAIMessages(system, messages, { vision }),
      }
      if (useTools) body.tools = toOpenAITools(tools)
      const useUsage = Boolean(settings.usage) && !usageRefused
      if (useUsage) body.stream_options = { include_usage: true }
      if (settings.maxTokens) body.max_tokens = settings.maxTokens
      if (settings.temperature !== null && settings.temperature !== undefined) body.temperature = settings.temperature
      const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
      if (key) headers.Authorization = `Bearer ${key}`

      const connect = new AbortController()
      // settings.connectTimeoutMs 0: no limit here (the starter agent's host
      // relay keeps the time and says what happened).
      const connectMs = settings.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
      const timer = connectMs ? setTimeout(() => connect.abort(), connectMs) : null
      const onAbort = () => connect.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      let response
      try {
        response = await fetchImpl(`${settings.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: connect.signal,
          redirect: 'error',
        })
      } catch (error) {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (signal?.aborted) return
        if (error?.relayed) throw new AgentError('agent_unreachable', redact(error.message, key))
        const reason = connect.signal.aborted ? 'timed out' : redact(error.cause?.code || error.message, key)
        throw new AgentError('agent_unreachable', `Could not reach the model endpoint (${reason}).`)
      }
      clearTimeout(timer)
      try {
        if (!response.ok) {
          const text = (await response.text().catch(() => '')).slice(0, ERROR_BODY_MAX)
          if (useTools && response.status === 400 && TOOLS_UNSUPPORTED.test(text)) {
            toolsRefused.add(model)
            yield { type: 'status', text: 'This model does not use tools; asking without them' }
            yield* this.stream({ system, messages, tools: [], signal, model: chosen })
            return
          }
          if (withImages && response.status === 400 && IMAGES_UNSUPPORTED.test(text)) {
            // Once more without the images, instead of the raw 400.
            imagesRefused.add(model)
            if (!hasImages(messages.slice(-1))) yield { type: 'notice', text: NO_IMAGES_NOTE }
            yield* this.stream({ system, messages, tools, signal, model: chosen })
            return
          }
          if (useUsage && response.status === 400 && USAGE_UNSUPPORTED.test(text)) {
            usageRefused = true
            yield* this.stream({ system, messages, tools, signal, model: chosen })
            return
          }
          throw upstreamError(response.status, text, key)
        }
        const type = String(response.headers.get('content-type') || '')
        if (!type.includes('text/event-stream')) {
          // A server that ignored stream: true answers with one JSON body.
          const json = await response.json().catch(() => null)
          const choice = json?.choices?.[0]
          if (!choice) throw new AgentError('agent_upstream', 'The model endpoint did not answer in the chat completions format.')
          if (json.usage) yield usageEvent(json.usage)
          if (choice.message?.content) yield { type: 'text', text: String(choice.message.content) }
          for (const call of choice.message?.tool_calls || []) yield toolCall(call.id, call.function?.name, call.function?.arguments)
          yield { type: 'done', finishReason: choice.finish_reason || 'stop' }
          return
        }
        const calls = new Map()
        let finishReason = null
        for await (const data of sseData(response.body, signal)) {
          if (data === '[DONE]') break
          let chunk
          try {
            chunk = JSON.parse(data)
          } catch {
            continue
          }
          if (chunk.error) throw upstreamError(500, JSON.stringify(chunk), key)
          if (chunk.usage) yield usageEvent(chunk.usage)
          const choice = chunk.choices?.[0]
          if (!choice) continue
          const delta = choice.delta || {}
          const reasoning = delta.reasoning_content ?? delta.reasoning
          if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', text: reasoning }
          if (typeof delta.content === 'string' && delta.content) yield { type: 'text', text: delta.content }
          for (const part of delta.tool_calls || []) {
            const index = part.index ?? calls.size
            const call = calls.get(index) || { id: '', name: '', args: '' }
            if (part.id) call.id = part.id
            if (part.function?.name) call.name += part.function.name
            if (part.function?.arguments) call.args += part.function.arguments
            calls.set(index, call)
          }
          if (choice.finish_reason) finishReason = choice.finish_reason
        }
        if (signal?.aborted) return
        for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
          yield toolCall(call.id || `call_${index}`, call.name, call.args)
        }
        yield { type: 'done', finishReason: finishReason || 'stop' }
      } catch (error) {
        if (signal?.aborted) return
        if (error instanceof AgentError) throw error
        if (error?.relayed) throw new AgentError('agent_upstream', redact(error.message, key))
        throw new AgentError('agent_upstream', `The model stream broke off (${redact(error.message, key)}).`)
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}

function toolCall(id, name, rawArgs) {
  let args = {}
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {}
  } catch {
    args = { _invalid: String(rawArgs).slice(0, 200) }
  }
  return { type: 'tool_call', id: String(id || ''), name: String(name || ''), args }
}
