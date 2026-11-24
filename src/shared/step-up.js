// The groups a workspace can switch on, in the order Settings shows them.
export const STEP_UP_GROUPS = ['cards', 'agents', 'tokens', 'members', 'data']

export const STEP_UP_GROUP_LABEL = {
  cards: 'Agent edits and pushes',
  agents: 'Agents and machines',
  tokens: 'Tokens and share links',
  members: 'Members and roles',
  data: 'Exports and deletes',
}

// What each group covers, as Settings says it.
export const STEP_UP_GROUP_COVERS = {
  cards: "Allow on an agent's edit or command, Push this fix, approving an agent run or a shell command",
  agents: 'approving a machine or an agent, who may use an agent, its approval rule, the project agent policy',
  tokens: 'new API tokens, new share links, turning share links or public projects on, making a project public',
  members: 'inviting an admin, making someone an admin, changing or removing an admin',
  data: 'exporting the workspace, deleting a project or a board',
}

export const STEP_UP_WINDOWS = [5, 15, 30, 60]
export const STEP_UP_WINDOW_DEFAULT = 15

export const ALWAYS_LABEL = {
  passkey: 'adding or removing a passkey',
  recovery: 'new recovery codes',
  tailnet: 'linking or unlinking a tailnet login',
  account: 'deleting your account',
  workspace: 'deleting a workspace',
  owner: 'making someone an owner, changing or removing an owner (leaving as one too), inviting an owner',
  move: "moving your account to the server's new address",
  settings: 'making these settings weaker',
}
export const STEP_UP_ALWAYS = Object.values(ALWAYS_LABEL)

// "5 minutes", "1 hour".
export const stepUpWindowLabel = (minutes) => (minutes === 60 ? '1 hour' : `${minutes} minutes`)
