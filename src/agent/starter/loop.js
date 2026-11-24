// The starter agent's turn loop, inside the container: ask the model, run
// the tools it calls, repeat until it answers without a tool call or a
// budget runs out.
//
// Budgets per comment, checked before every model call:
// - turns: model calls;
// - tokens: as the endpoint reports them (stream_options.include_usage),
//   or estimated at 4 characters a token when it does not; each answer's
//   max_tokens is capped at what is left;
// - wall time: a deadline, also enforced from the host (it stops the
//   container), so a model or a command that hangs cannot outlast it.

export const TOOL_CALLS_PER_TURN_MAX = 8
const DEFAULT_ANSWER_TOKENS = 4096
const TEXT_MAX = 20000

const ARG_SHOWN_MAX = 160

// A tool call's arguments for the run log: names and short values (long
// text such as a file's content is cut, with its length).
export function argsSummary(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const out = {}
  for (const [key, value] of Object.entries(args).slice(0, 12)) {
    if (typeof value === 'string')
      out[key] = value.length > ARG_SHOWN_MAX ? `${value.slice(0, ARG_SHOWN_MAX)}... (${value.length} characters)` : value
    else if (['number', 'boolean'].includes(typeof value) || value === null) out[key] = value
    else out[key] = '[...]'
  }
  return out
}

const estimate = (value) => Math.ceil((typeof value === 'string' ? value.length : JSON.stringify(value).length) / 4)

// runLoop({ backend, settings, system, task, tools, budget, deadline, emit, signal })
// -> { stop: 'answered' | 'turns' | 'tokens' | 'time' | 'stopped' | 'error', text, usage, error? }
export async function runLoop({
  backend,
  settings,
  system,
  task,
  tools,
  budget,
  deadline,
  emit = () => {},
  signal = null,
  now = () => Date.now(),
}) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: task }] }]
  const usage = { turns: 0, tokens: 0, estimated: false }
  let text = ''
  const over = () => {
    if (signal?.aborted) return 'stopped'
    if (now() >= deadline) return 'time'
    if (usage.turns >= budget.turns) return 'turns'
    if (usage.tokens >= budget.tokens) return 'tokens'
    return null
  }
  for (;;) {
    const stop = over()
    if (stop) return { stop, text: text.trim(), usage }
    usage.turns += 1
    emit({ type: 'turn', turn: usage.turns })
    // What is left of the token budget caps this answer.
    settings.maxTokens = Math.max(1, Math.min(settings.answerTokens || DEFAULT_ANSWER_TOKENS, budget.tokens - usage.tokens))
    let turnText = ''
    let reported = null
    const calls = []
    try {
      for await (const event of backend.stream({ system, messages, tools: tools.specs, signal })) {
        if (signal?.aborted) break
        if (event.type === 'text') {
          turnText += event.text
          emit({ type: 'text', text: event.text })
        } else if (event.type === 'usage') {
          reported = (reported || 0) + event.total
        } else if (event.type === 'tool_call') {
          calls.push(event)
        }
      }
    } catch (error) {
      if (signal?.aborted) return { stop: 'stopped', text: text.trim(), usage }
      return {
        stop: 'error',
        text: text.trim(),
        usage,
        error: { code: error.code || 'agent_error', message: String(error.message).slice(0, 300) },
      }
    }
    if (reported === null) {
      usage.estimated = true
      usage.tokens += estimate(system) + estimate(messages) + estimate(turnText) + estimate(calls)
    } else usage.tokens += reported
    emit({ type: 'usage', tokens: usage.tokens, estimated: usage.estimated })
    if (signal?.aborted) return { stop: 'stopped', text: text.trim(), usage }
    if (turnText) text = `${text}${text ? '\n\n' : ''}${turnText}`.slice(-TEXT_MAX)
    if (!calls.length) return { stop: 'answered', text: text.trim(), usage }
    const taken = calls.slice(0, TOOL_CALLS_PER_TURN_MAX).map((call, index) => ({ ...call, id: call.id || `call_${usage.turns}_${index}` }))
    messages.push({ role: 'assistant', content: [{ type: 'text', text: turnText }], toolCalls: taken })
    for (const call of taken) {
      const id = call.id
      emit({ type: 'tool', id, name: call.name, state: 'running', args: argsSummary(call.args) })
      const result = await tools.run(call)
      emit({ type: 'tool', id, name: call.name, label: result.label, state: result.ok ? 'done' : 'error', detail: result.detail })
      messages.push({ role: 'tool', toolCallId: id, content: [{ type: 'text', text: result.text }] })
    }
    if (calls.length > taken.length) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: `[Shapewall] Only the first ${TOOL_CALLS_PER_TURN_MAX} tool calls of a turn run.` }],
      })
    }
  }
}
