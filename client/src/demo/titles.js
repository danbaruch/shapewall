// The console names its pages "<Page> · Shapewall"; in the demo the tab says
// which page of which workspace: "Members · Lumen · Shapewall demo"
// (install.js keeps it so). No imports, so tests load it in Node.
const SECTION_TITLES = {
  projects: 'Projects',
  members: 'Members',
  invites: 'Invites',
  access: 'Access',
  tokens: 'API tokens',
  audit: 'Audit log',
  agents: 'Agents',
  feedback: 'Agent feedback',
  settings: 'Settings',
}
export function consoleTitle(hash, state) {
  const raw = String(hash || '').replace(/^#/, '')
  const path = (raw.startsWith('/') ? raw : '/').split('#')[0].split('?')[0]
  const parts = []
  const match = /^\/w\/(ws_[a-f0-9]{24})(?:\/([a-z]+))?(?:\/(pr_[a-f0-9]{24}))?\/?$/.exec(path)
  if (state.viewAs === 'guest') parts.push('Guest')
  else if (match) {
    const project = match[3] ? state.projects.find((item) => item.id === match[3]) : null
    parts.push(project ? project.name : SECTION_TITLES[match[2]] || 'Projects')
    const workspace = state.workspaces.find((item) => item.id === match[1])
    if (workspace) parts.push(workspace.name)
  } else {
    parts.push(
      { '/signin': 'Sign in', '/signup': 'Create your account', '/account': 'Account', '/invite': 'Invite', '/share': 'Shared board' }[
        path
      ] || 'Workspaces',
    )
  }
  return [...parts, 'Shapewall demo'].join(' · ')
}
