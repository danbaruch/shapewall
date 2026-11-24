// Suggested next steps: the agent is asked (context.js NEXT_STEPS_PROMPT) to
// end an answer with up to three short follow-ups in a <next-steps> block.
// The server takes the block out of the stored answer (run.js) and keeps the
// items as `suggestions`; the panel shows them as chips. Pure functions with
// no imports, shared with the board client (a streaming answer hides the
// block while it is still being written).

export const NEXT_STEPS_MAX = 3
export const NEXT_STEP_CHARS_MAX = 90
const BLOCK_RE = /<next-steps>([\s\S]*?)(?:<\/next-steps>|$)/gi
// The start of a block still arriving: "<", "<next", "<next-st", ...
const PARTIAL_RE = /<(?:n(?:e(?:x(?:t(?:-(?:s(?:t(?:e(?:p(?:s)?)?)?)?)?)?)?)?)?)?$/i

// One suggestion line: no list markers or quotes, one line, no markup.
function cleanStep(line) {
  const value = String(line || '')
    .replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+/, '')
    .replace(/^["“'`]+|["”'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (value.length < 2 || value.length > NEXT_STEP_CHARS_MAX) return null
  // Markup or a link is not a follow-up the person would type.
  if (/[<>]|https?:\/\//i.test(value)) return null
  return value
}

// { text, steps }: the answer without any <next-steps> block, and the
// suggestions of the last block (at most NEXT_STEPS_MAX, no repeats).
export function splitNextSteps(text) {
  const source = String(text ?? '')
  let last = null
  for (const match of source.matchAll(BLOCK_RE)) last = match[1]
  const stripped = source.replace(BLOCK_RE, '').replace(/\s+$/, '')
  if (last === null) return { text: stripped, steps: [] }
  const seen = new Set()
  const steps = []
  for (const line of last.split(/\r?\n/)) {
    const step = cleanStep(line)
    if (!step || seen.has(step.toLowerCase())) continue
    seen.add(step.toLowerCase())
    steps.push(step)
    if (steps.length >= NEXT_STEPS_MAX) break
  }
  return { text: stripped, steps }
}

// Text that is still streaming, without a block (complete or not) and
// without the start of one at the very end.
export function hideNextSteps(text) {
  return splitNextSteps(text).text.replace(PARTIAL_RE, '')
}
