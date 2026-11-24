// The Chat connection form (AgentSettings.jsx) as plain data, so the rule
// for settings that change elsewhere is testable without a browser
// (test/agent-form.test.js).

// The form's fields from a /api/agent/settings view.
export function formFrom(view) {
  const saved = view?.saved || {}
  // The default command is a connected agent's: the name is that agent's,
  // the one the Agents page's Edit changes (settings-routes.js POST /).
  const named =
    saved.backend === 'acp' && saved.acpCommand ? (saved.profiles || []).find((item) => item.acpCommand === saved.acpCommand) : null
  return {
    backend: saved.backend || view?.effective?.backend || 'openai-compatible',
    baseUrl: saved.baseUrl || '',
    model: saved.model || '',
    apiKeyEnv: saved.apiKeyEnv || '',
    label: named?.label || saved.label || '',
    acpCommand: saved.acpCommand || '',
    keyHosts: saved.keyHosts || [],
    // null: not set here (an ACP agent says itself; an endpoint is assumed to take images).
    vision: typeof saved.vision === 'boolean' ? saved.vision : null,
  }
}

export function sameForm(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

// The agent settings changed somewhere else (another tab, the Agents card,
// `shapewall settings`, the agents file) and `next` is the fresh view.
// Unsaved typing is never lost:
//   - a clean form takes the new settings;
//   - a dirty form keeps its fields; everything read-only (the effective
//     connection, the agents, "Chat uses ...") still comes from `next`, and
//     `stale` says the saved settings under the form moved, so the screen
//     offers a Reload. Saved settings that did not move, or moved to just
//     what is typed, are not stale.
export function reloadView({ view, form, next }) {
  const dirty = view ? !sameForm(form, formFrom(view)) : false
  const fresh = formFrom(next)
  if (!dirty) return { view: next, form: fresh, stale: false }
  const moved = !sameForm(formFrom(view), fresh)
  return { view: next, form, stale: moved && !sameForm(form, fresh) }
}
