// Who and what the demo's Usage and Activity pages are about: the people of
// "Lumen" (fixtures.js), its two projects, and four agents on made-up
// machines with made-up models. Everything here is fictional.
//
// What each agent reports differs on purpose, as on a real server: one
// reports tokens and a cost, one tokens only, one nothing at all (so "not
// reported" shows up as a hatch and as dashes, never as zero).

import { DEMO_AGENT_IDS, EXPORT_BOARD, NOTES_PROJECT, USERS, WEBSITE_BOARD, WEBSITE_PROJECT, WORKSPACE_ID, fixedId } from '../fixtures.js'

const user = (handle) => USERS.find((item) => item.handle === handle).id

export const USAGE_AGENTS = [
  {
    id: DEMO_AGENT_IDS.demo,
    // The scripted agent of the board this one stands for (a visitor's own turns land here).
    profile: 'demo',
    name: 'Demo agent',
    machine: 'robin-macbook',
    kind: 'claude',
    projectId: NOTES_PROJECT,
    owner: user('robin'),
    reports: 'cost',
    models: ['sonnet-large', 'sonnet-large', 'opus-max'],
    weight: 34,
    audience: 'trusted',
    rule: 'ask',
    connectedDays: 58,
    token: { id: fixedId('tk', 11), prefix: 'swp_Dm4agN7p', scopes: ['read', 'comment', 'claim'] },
  },
  {
    id: DEMO_AGENT_IDS.second,
    profile: 'second',
    name: 'Second agent',
    machine: 'jo-laptop',
    kind: 'codex',
    projectId: NOTES_PROJECT,
    owner: user('jo'),
    reports: 'tokens',
    models: ['sol-high', 'sol-medium'],
    weight: 24,
    audience: 'trusted',
    rule: 'ask',
    connectedDays: 55,
    token: { id: fixedId('tk', 12), prefix: 'swp_S2ndQx81', scopes: ['read', 'comment', 'claim'] },
  },
  {
    id: DEMO_AGENT_IDS.coding,
    profile: null,
    name: 'Coding agent',
    machine: 'build-box',
    kind: 'custom',
    projectId: NOTES_PROJECT,
    owner: user('jo'),
    reports: 'none',
    models: [null],
    weight: 16,
    audience: 'trusted',
    rule: 'auto',
    connectedDays: 21,
    // The "Coding agent" token of the API tokens page.
    token: { id: fixedId('tk', 2), prefix: 'swp_7xRb2NqE', scopes: ['comment', 'read', 'resolve'] },
  },
  {
    id: DEMO_AGENT_IDS.website,
    profile: null,
    name: 'Website agent',
    machine: 'build-box',
    kind: 'claude',
    projectId: WEBSITE_PROJECT,
    owner: user('priya'),
    reports: 'cost',
    models: ['sonnet-large'],
    weight: 26,
    audience: 'trusted',
    rule: 'ask',
    connectedDays: 52,
    token: { id: fixedId('tk', 13), prefix: 'swp_W3bs1teK', scopes: ['read', 'comment', 'claim'] },
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

export const USAGE_WORLD = {
  workspaceId: WORKSPACE_ID,
  agents: USAGE_AGENTS,
  people: USAGE_PEOPLE,
  former: USAGE_FORMER,
  viewer: USAGE_VIEWER,
  boards: { [NOTES_PROJECT]: EXPORT_BOARD, [WEBSITE_PROJECT]: WEBSITE_BOARD },
  projects: [NOTES_PROJECT, WEBSITE_PROJECT],
}

// Each project's daily budgets (its agent policy), set so today's use shows
// against them.
export const USAGE_POLICY = {
  [NOTES_PROJECT]: { dailyTurns: 120, dailyClaims: 30 },
  [WEBSITE_PROJECT]: { dailyTurns: 60, dailyClaims: 12 },
}
export const USAGE_POLICY_DEFAULT = { dailyTurns: 200, dailyClaims: 50 }
// Shown on the page: the demo's records go back as far as its fictional history.
export const USAGE_HISTORY_DAYS = 60
