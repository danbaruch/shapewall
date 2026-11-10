// The agent picker (AgentPicker.jsx), from a thread's `profiles`
// (src/agent/routes.js): every connected agent once, by name. The default
// connection is listed only when it is not one of the profiles (`sameAs`
// names the profile it runs); a thread on the default then shows that
// profile as chosen.
//
// { show, value, known, options: [{ id, label, configured, state,
// loginHint, isDefault }] }. `value` is what the picker shows; choosing it
// again changes nothing (see `choice`). `state` is the server's word for how
// the agent is doing (src/agent/agent-health.js).
export function pickerProfiles(thread) {
  const profiles = Array.isArray(thread?.profiles) ? thread.profiles : []
  const current = thread?.profileId || 'default'
  const fallback = profiles.find((profile) => profile.id === 'default')
  const defaultId = fallback?.sameAs || 'default'
  const options = profiles
    .filter((profile) => !(profile.id === 'default' && profile.sameAs))
    .map((profile) => ({
      id: profile.id,
      label: profile.label || (profile.id === 'default' ? 'Default connection' : profile.id),
      configured: profile.configured !== false,
      state: profile.configured === false ? 'unavailable' : profile.state || 'ready',
      loginHint: profile.loginHint || null,
      isDefault: profile.id === defaultId,
    }))
  const value = current === 'default' && fallback?.sameAs ? fallback.sameAs : current
  const known = options.some((option) => option.id === value)
  return { show: profiles.length > 0 && (options.length > 1 || !known), value, known, options }
}

// The profile id to save for a pick, or null when it is what the thread
// already uses (the default shown as its profile included).
export function choice(thread, picked) {
  const { value } = pickerProfiles(thread)
  return picked === value ? null : picked
}

// Errors that mean the agent never got to work (not logged in or set up, not
// started, not found; src/agent/errors.js): the chat then offers another
// connected agent.
export { isSetupError } from '../../../src/agent/errors.js'

// Another connected agent this chat could switch to (the first available one
// that is not the current), or null.
export function otherProfile(thread) {
  const { value, options } = pickerProfiles(thread)
  return options.find((option) => option.id !== value && option.configured) || null
}

// ---- How a row reads --------------------------------------------------------------

export const STATE_TEXT = {
  ready: 'Ready',
  login: 'Not signed in',
  starting: 'Starting',
  'not-responding': 'Not responding',
  unavailable: 'Not set up',
}

// The status dot of each state (design tokens).
export const STATE_DOT = {
  ready: 'bg-ok',
  login: 'bg-warn',
  starting: 'bg-accent motion-safe:animate-pulse',
  'not-responding': 'bg-bad',
  unavailable: 'bg-faint',
}

// How to sign in, in short: the first way of the server's hint
// (src/agent/acp/command.js loginHint), "run `codex login` in a terminal".
export function signInHint(loginHint) {
  if (!loginHint) return null
  return `Sign in: ${String(loginHint).split(/, or /)[0]}`
}

// The one line under an agent's name.
export function stateLine(option) {
  const text = STATE_TEXT[option?.state] || STATE_TEXT.ready
  if (option?.state === 'login' && option.loginHint) return `${text}. ${signInHint(option.loginHint)}`
  return text
}

// Two letters for an agent without an icon: the initials of a two-word
// name ("Claude Code" CC, "Gemini CLI" GC), else its first two letters
// ("Codex" Co, "goose" Go).
export function monogram(label) {
  const words = String(label || '?')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return '?'
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase()
  const word = words[0]
  return word[0].toUpperCase() + (word[1] || '').toLowerCase()
}

// The quiet note after a switch, said once.
export function switchedNote(label) {
  return `Switched to ${label}. It starts fresh and can read this chat.`
}

// ---- Fix with ... (board/FixWithAgent.jsx) -----------------------------------------

// The fix button, from /api/agent/status: { name, options, defaultId }.
// `name` is the default agent's (null when unknown: "Fix with agent");
// `options`, only when more than one agent can run, is the caret's list.
export function fixChoices(status) {
  if (!status?.configured) return { name: null, options: [], defaultId: null }
  const profiles = Array.isArray(status.profiles) ? status.profiles : []
  const { options } = pickerProfiles({ profileId: 'default', profiles })
  const usable = options.filter((option) => option.configured)
  const defaultId = profiles.find((profile) => profile.id === 'default')?.sameAs || 'default'
  const name = status.label || usable.find((option) => option.isDefault)?.label || null
  return { name, options: usable.length > 1 ? usable : [], defaultId }
}

// The profile a comment thread must be set to before a fix runs with
// `wanted`, or null when it already uses that agent. The default ('default')
// and the profile it runs (`defaultId`) are the same agent.
export function profileToSet({ threadProfile = 'default', wanted, defaultId }) {
  const isDefault = (id) => id === 'default' || id === defaultId
  const current = threadProfile || 'default'
  if (current === wanted || (isDefault(current) && isDefault(wanted))) return null
  return wanted
}

// "Fix with Codex", "Fix again", "Fix with agent".
export function fixLabel({ again, name }) {
  if (again) return 'Fix again'
  return name ? `Fix with ${name}` : 'Fix with agent'
}
