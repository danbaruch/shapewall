// The rows of the Agents card (AgentsCard.jsx), from the settings answer
// (src/agent/settings-routes.js view): every agent Shapewall knows how to
// run (`known`), each in one of these states on this machine:
//
//   connected      a connected agent (`profile`: its state, default, sign-in hint)
//   found          its ACP program is on PATH: Connect
//   needs-adapter  the CLI without its ACP adapter: `install` is the line to run
//   needs-shell    Windows: only a .cmd wrapper, which needs a shell
//   missing        neither is on PATH
//
// Connected agents Shapewall does not know (a command saved by hand) come
// after them. An older server without `known` lists what it found.
export function agentRows(view) {
  const profiles = Array.isArray(view?.profiles) ? view.profiles : []
  const detected = Array.isArray(view?.detected) ? view.detected : []
  const known = Array.isArray(view?.known) && view.known.length ? view.known : detected
  const rows = known.map((agent) => {
    const profile = profiles.find((item) => item.id === agent.id)
    if (profile) return { kind: 'connected', id: agent.id, label: profile.label || agent.label, profile }
    const found = detected.find((item) => item.id === agent.id)
    if (!found) return { kind: 'missing', id: agent.id, label: agent.label }
    const kind = found.state === 'ready' ? 'found' : found.state === 'needs-shell' ? 'needs-shell' : 'needs-adapter'
    return { kind, id: agent.id, label: agent.label, install: found.install || agent.install || null }
  })
  for (const profile of profiles) {
    if (!rows.some((row) => row.id === profile.id)) rows.push({ kind: 'connected', id: profile.id, label: profile.label, profile })
  }
  return rows
}
