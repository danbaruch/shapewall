// Who and what the demo's Usage and Activity pages are about: the people of
// the workspace (fixtures.js), its boards, and four agents on made-up
// machines with made-up models. Everything here is fictional. The fourth
// agent works on the second line of work (fixtures.js secondWork): the Lumen
// world's website project, or the Brackwell world's Lumen Notes board. So
// these are functions of the world the export is about (world.js).
//
// What each agent reports differs on purpose, as on a real server: one
// reports tokens and a cost, one tokens only, one nothing at all (so "not
// reported" shows up as a hatch and as dashes, never as zero).

import { DEMO_AGENT_IDS, NOTES_PROJECT, USERS, WORKSPACE_ID, fixedId, mainBoard, secondWork } from '../fixtures.js'

const user = (handle) => USERS.find((item) => item.handle === handle).id

// Each agent's project and board (boardId: where its turns happen).
export const usageAgents = () => [
  {
    id: DEMO_AGENT_IDS.demo,
    // The scripted agent of the board this one stands for (a visitor's own turns land here).
    profile: 'demo',
    name: 'Demo agent',
    machine: 'robin-macbook',
    kind: 'claude',
    projectId: NOTES_PROJECT,
    boardId: mainBoard(),
    owner: user('robin'),
    reports: 'cost',
    models: ['sonnet-large', 'sonnet-large', 'opus-max'],
    weight: 34,
    audience: 'trusted',
    rule: 'ask',
    connectedDays: 58,
    token: { id: fixedId('tk', 11), prefix: 'swp_Dm4agN7p', scopes: ['claim', 'read', 'reply', 'status'] },
  },
  {
    id: DEMO_AGENT_IDS.second,
    profile: 'second',
    name: 'Second agent',
    machine: 'jo-laptop',
    kind: 'codex',
    projectId: NOTES_PROJECT,
    boardId: mainBoard(),
    owner: user('jo'),
    reports: 'tokens',
    models: ['sol-high', 'sol-medium'],
    weight: 24,
    audience: 'trusted',
    rule: 'ask',
    connectedDays: 55,
    token: { id: fixedId('tk', 12), prefix: 'swp_S2ndQx81', scopes: ['claim', 'read', 'reply', 'status'] },
  },
  {
    id: DEMO_AGENT_IDS.coding,
    profile: null,
    name: 'Coding agent',
    machine: 'build-box',
    kind: 'custom',
    projectId: NOTES_PROJECT,
    boardId: mainBoard(),
    owner: user('jo'),
    reports: 'none',
    models: [null],
    weight: 16,
    audience: 'trusted',
    rule: 'auto',
    connectedDays: 21,
    // Each agent's token is on the API tokens page (fixtures.js).
    token: { id: fixedId('tk', 2), prefix: 'swp_7xRb2NqE', scopes: ['claim', 'read', 'reply', 'resolve', 'status'] },
  },
  {
    id: DEMO_AGENT_IDS.website,
    profile: null,
    name: secondWork().agent,
    machine: 'build-box',
    kind: 'claude',
    projectId: secondWork().project,
    boardId: secondWork().board,
    owner: user('priya'),
    reports: 'cost',
    models: ['sonnet-large'],
    weight: 26,
    audience: 'trusted',
    rule: 'ask',
    connectedDays: 52,
    token: { id: fixedId('tk', 13), prefix: 'swp_W3bs1teK', scopes: ['claim', 'read', 'reply', 'status'] },
  },
]

// Who asks agents for work, and how often. Alex is a viewer (viewers cannot);
// Lee left the workspace, so Lee's older turns read "Former member".
export const USAGE_PEOPLE = [
  { id: user('robin'), weight: 30, answers: true, ip: '198.51.100.24', devices: ['Chrome on macOS', 'Safari on iPhone'] },
  { id: user('jo'), weight: 22, answers: true, ip: '203.0.113.7', devices: ['Firefox on Linux', 'Chrome on Android'] },
  { id: user('mei'), weight: 19, answers: false, ip: '203.0.113.52', devices: ['Chrome on macOS'] },
  { id: user('sam'), weight: 14, answers: false, ip: '203.0.113.61', devices: ['Safari on macOS', 'Safari on iPhone'] },
  { id: user('priya'), weight: 10, answers: true, ip: '203.0.113.45', devices: ['Chrome on Windows'] },
]
export const USAGE_FORMER = { id: user('lee'), leftDays: 16 }
export const USAGE_VIEWER = { id: user('alex'), ip: '203.0.113.88', devices: ['Chrome on Windows'] }

export const usageWorld = () => ({
  workspaceId: WORKSPACE_ID,
  agents: usageAgents(),
  people: USAGE_PEOPLE,
  former: USAGE_FORMER,
  viewer: USAGE_VIEWER,
  projects: [...new Set([NOTES_PROJECT, secondWork().project])],
  // The highest comment number an agent is asked about on each board (so a
  // turn's link opens a comment that is there).
  comments: { [mainBoard()]: 14, [secondWork().board]: secondWork().project === NOTES_PROJECT ? 5 : 4 },
})

// Each project's daily budgets (its agent policy), set so today's use shows
// against them.
export const usagePolicy = () => ({
  [NOTES_PROJECT]: { dailyTurns: 120, dailyClaims: 30 },
  ...(secondWork().project === NOTES_PROJECT ? {} : { [secondWork().project]: { dailyTurns: 60, dailyClaims: 12 } }),
})
export const USAGE_POLICY_DEFAULT = { dailyTurns: 200, dailyClaims: 50 }
// Shown on the page: the demo's records go back as far as its fictional history.
export const USAGE_HISTORY_DAYS = 60
