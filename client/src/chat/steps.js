// What the agent is doing, in plain English: the steps of a reply (its tool
// cards), the line that says what it is on right now ("Reading the
// comments"), and the summary a finished reply keeps ("Worked for 14s, 5
// steps"). Pure, so node tests can import it.

// Shapewall's own board tools (src/agent/tools.js) while they run: the card
// carries the tool's name until its result gives it a label.
const BOARD_TOOLS = {
  list_pages: 'Reading the pages',
  list_comments: 'Reading the comments',
  get_comment: 'Reading the comment',
  reply_to_comment: 'Replying to the comment',
  set_comment_status: 'Updating the comment status',
  resolve_comment: 'Resolving the comment',
  recapture_pages: 'Recapturing pages',
  view_capture: 'Looking at the page',
  view_image: 'Looking at the image',
}

// "Read src/app.css" -> "Reading src/app.css". Labels from agents and tools
// start with a verb in the imperative; anything else is shown as it is.
const VERBS = {
  add: 'Adding',
  build: 'Building',
  call: 'Calling',
  capture: 'Capturing',
  change: 'Changing',
  check: 'Checking',
  create: 'Creating',
  delete: 'Deleting',
  download: 'Downloading',
  edit: 'Editing',
  fetch: 'Fetching',
  find: 'Finding',
  get: 'Getting',
  grep: 'Searching',
  install: 'Installing',
  list: 'Listing',
  load: 'Loading',
  look: 'Looking',
  make: 'Making',
  move: 'Moving',
  open: 'Opening',
  plan: 'Planning',
  read: 'Reading',
  recapture: 'Recapturing',
  remove: 'Removing',
  rename: 'Renaming',
  reply: 'Replying',
  resolve: 'Resolving',
  run: 'Running',
  save: 'Saving',
  search: 'Searching',
  test: 'Testing',
  update: 'Updating',
  use: 'Using',
  view: 'Viewing',
  write: 'Writing',
}

export function runningLabel(card) {
  const label = String(card?.label || '').trim()
  const name = String(card?.name || '')
  if (BOARD_TOOLS[name] && (!label || label === name)) return BOARD_TOOLS[name]
  if (!label || /^[a-z0-9]+(_[a-z0-9]+)+$/.test(label)) return `Using ${(label || name || 'a tool').replace(/_/g, ' ')}`
  const [first, ...rest] = label.split(/\s+/)
  const verb = VERBS[first.toLowerCase()]
  return verb && rest.length ? `${verb} ${rest.join(' ')}` : verb || label
}

// The steps of a reply: its tool calls, in the order they started. Plans,
// notes and permission requests are shown as cards of their own.
export const stepsOf = (cards) => (cards || []).filter((card) => (card.kind || 'tool') === 'tool')

// The one line a live reply shows. `writing`: text was the last thing to arrive.
export function currentActivity({ cards = [], status = '', writing = false } = {}) {
  if (cards.some((card) => card.kind === 'permission' && card.state === 'pending')) return 'Waiting for your answer'
  const running = stepsOf(cards).findLast((card) => card.state === 'running')
  if (running) return runningLabel(running)
  if (writing) return 'Writing the answer'
  const text = String(status || '').trim()
  if (text && !/^sending$/i.test(text)) return text
  return 'Thinking'
}

// 14s, 1m 5s, 1h 2m.
export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// "Worked for 14s, 5 steps", "Worked for 3s", "2 steps, 1 failed". Null when
// there is nothing to say (an older reply with no steps and no timing).
export function activitySummary({ cards = [], durationMs = null } = {}) {
  const steps = stepsOf(cards)
  const failed = steps.filter((card) => card.state === 'error').length
  const parts = []
  if (Number.isFinite(durationMs) && durationMs >= 0) parts.push(`Worked for ${formatElapsed(Math.max(durationMs, 1000))}`)
  if (steps.length) parts.push(`${steps.length} step${steps.length === 1 ? '' : 's'}`)
  if (failed) parts.push(`${failed} failed`)
  return parts.length ? parts.join(', ') : null
}
