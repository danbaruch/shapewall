// The demo console's Agents page: the same answers the local installation's
// agent settings give (src/agent/settings-routes.js view), from sample data,
// so the page is the real one (settings/AgentsCard.jsx, AgentSettings.jsx).
//
// What works in the browser works: the default agent (the board chat follows
// it), Test connection on a scripted agent (a scripted success), and Remove
// and Connect on the two scripted agents, and Edit (a name, a built-in icon
// and a colour for a scripted agent; no uploaded picture, there is no
// computer to keep it on). Reset puts all of it back. Anything
// that would run a command or save an endpoint on a computer answers
// `{ demoNote }` instead, which the page shows as a neutral note.
//
// Every name, folder and address here is fictional.

import { cleanAgentName, isAgentTint, isBuiltInIcon } from '../../../../src/agent/identity.js'
import { logoForAgent } from '../../../../src/agent/agent-logos.js'
import { DEMO_AGENTS, demoAgentState, fail } from './util.js'

export const DEMO_NOTE = 'In the demo nothing runs on a computer. On your install this connects the agent.'
const SAVE_NOTE = 'In the demo nothing is saved on a computer. On your install this saves the endpoint and chat uses it.'
const KEEP_ONE = 'The demo keeps one agent connected, so the board chat has someone to answer. Connect another one first.'

// The agents Shapewall knows how to run (src/agent/acp/detect.js
// KNOWN_AGENTS; test/demo-backend.test.js checks they match), after the two
// scripted ones.
export const DEMO_KNOWN = [
  ...DEMO_AGENTS.map(({ id, label }) => ({ id, label, adapter: null, cli: null, install: null, logo: null })),
  ...[
    {
      id: 'claude',
      label: 'Claude Code',
      adapter: 'claude-agent-acp',
      cli: 'claude',
      install: 'npm install -g @agentclientprotocol/claude-agent-acp',
    },
    { id: 'codex', label: 'Codex', adapter: 'codex-acp', cli: 'codex', install: 'npm install -g @agentclientprotocol/codex-acp' },
    { id: 'goose', label: 'goose', adapter: 'goose', cli: 'goose', install: null },
    { id: 'gemini', label: 'Gemini CLI', adapter: 'gemini', cli: 'gemini', install: 'npm install -g @google/gemini-cli' },
    // Their product marks, as on a real install (src/agent/agent-logos.js).
  ].map((agent) => ({ ...agent, logo: logoForAgent(agent.id) })),
]
// What this pretend computer has on its PATH: Codex ready to connect, Claude
// Code without its adapter; goose and Gemini CLI are not installed.
const DETECTED = [
  { id: 'codex', label: 'Codex', command: 'codex-acp', state: 'ready', install: null },
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude-agent-acp',
    state: 'needs-adapter',
    install: 'npm install -g @agentclientprotocol/claude-agent-acp',
  },
]
export const DEMO_SOURCE = '/home/robin/code/lumen-notes'
export const DEMO_ENDPOINT = { baseUrl: 'https://api.example.com/v1', model: 'example-model', label: 'Example endpoint' }

export function agentRoutes(ctx) {
  const { state } = ctx
  const isScripted = (id) => DEMO_AGENTS.some((agent) => agent.id === id)
  // The names and icons given on this page stay through the other changes.
  const write = (next) => {
    state.agents = { default: next.default, removed: next.removed, ...(state.agents?.identity ? { identity: state.agents.identity } : {}) }
  }

  const view = () => {
    const agents = demoAgentState(state)
    const current = agents.connected.find((agent) => agent.id === agents.default) || DEMO_AGENTS[0]
    return {
      editable: true,
      demo: true,
      file: null,
      fileProblem: null,
      saved: { backend: 'openai-compatible', baseUrl: DEMO_ENDPOINT.baseUrl, model: DEMO_ENDPOINT.model, label: DEMO_ENDPOINT.label },
      // Built-in icons only: there is no computer to keep an uploaded picture on.
      iconUpload: false,
      profiles: agents.connected.map((agent) => ({
        id: agent.id,
        label: agent.label,
        icon: agent.icon,
        tint: agent.tint,
        logo: null,
        command: null,
        default: agent.id === agents.default,
        state: 'ready',
      })),
      endpoint: { label: DEMO_ENDPOINT.label, model: DEMO_ENDPOINT.model, host: 'api.example.com', default: false },
      project: { root: DEMO_SOURCE, configFile: `${DEMO_SOURCE}/shapewall.config.json` },
      config: {},
      effective: {
        backend: 'demo',
        configured: true,
        problem: null,
        label: current.label,
        icon: current.icon || null,
        tint: current.tint || null,
        logo: null,
        baseUrl: null,
        model: 'scripted',
        host: null,
        keyVar: 'SHAPEWALL_AGENT_API_KEY',
        hasKey: false,
        keyVarNamed: false,
        vision: true,
        keyHosts: [],
        acpCommand: null,
        refusedEnv: [],
        sources: {},
      },
      env: { baseUrl: false, model: false, acp: null, keyHosts: [] },
      // A removed scripted agent is still "on this computer": Connect brings it back.
      detected: [
        ...DEMO_AGENTS.filter((agent) => agents.removed.includes(agent.id)).map((agent) => ({
          id: agent.id,
          label: agent.label,
          command: null,
          state: 'ready',
          install: null,
        })),
        ...DETECTED,
      ],
      known: DEMO_KNOWN,
      knownKeyHosts: ['api.example.com'],
      defaultKeyVar: 'SHAPEWALL_AGENT_API_KEY',
      keyVarsSet: [],
    }
  }

  return [
    ['GET', /^\/api\/agent\/settings$/, () => view()],
    [
      // What a scripted agent is called and how it looks, with the server's
      // rules (src/agent/settings-routes.js POST /identity).
      'POST',
      /^\/api\/agent\/settings\/identity$/,
      ({ body }) => {
        const agents = demoAgentState(state)
        const id = body?.id === 'default' ? agents.default : body?.id
        if (id === 'endpoint') return { demoNote: SAVE_NOTE }
        if (!agents.connected.some((agent) => agent.id === id)) fail(404, 'unknown_profile', 'That agent is not connected.')
        const look = { ...(state.agents?.identity?.[id] || {}) }
        if (Object.hasOwn(body, 'name')) {
          const { name, problem } = cleanAgentName(body.name)
          if (problem) fail(400, 'invalid_name', problem)
          if (name) look.label = name
          else delete look.label
        }
        if (Object.hasOwn(body, 'icon')) {
          if (body.icon === null || body.icon === '') delete look.icon
          else if (isBuiltInIcon(body.icon)) look.icon = body.icon
          else fail(400, 'invalid_icon', 'icon: one of the built-in icons, or null for none.')
        }
        if (Object.hasOwn(body, 'tint')) {
          if (body.tint === null || body.tint === '') delete look.tint
          else if (isAgentTint(body.tint)) look.tint = body.tint
          else fail(400, 'invalid_tint', 'tint: one of the accent colours, or null for none.')
        }
        const identity = { ...(state.agents?.identity || {}) }
        if (Object.keys(look).length) identity[id] = look
        else delete identity[id]
        state.agents = { default: agents.default, removed: agents.removed, ...(Object.keys(identity).length ? { identity } : {}) }
        return view()
      },
    ],
    [
      'POST',
      /^\/api\/agent\/settings\/identity\/icon$/,
      () => ({ demoNote: 'In the demo there is no computer to keep a picture on. Pick one of the built-in icons.' }),
    ],
    // Saving the endpoint form: nothing to save it to.
    ['POST', /^\/api\/agent\/settings$/, () => ({ demoNote: SAVE_NOTE })],
    [
      'POST',
      /^\/api\/agent\/settings\/test$/,
      ({ body }) => {
        const id = body?.profileId
        if (id && !isScripted(id)) fail(404, 'unknown_profile', 'No such agent.')
        // No profile: the default connection, which in the demo is the default scripted agent.
        const agent = demoAgentState(state).connected.find((item) => item.id === (id || demoAgentState(state).default)) || DEMO_AGENTS[0]
        return {
          ok: true,
          message: `${agent.label} answered. It is a scripted demo agent that answers in this browser.`,
          details: ['Started in 0.2 s', 'Answered a test message in 0.4 s'],
        }
      },
    ],
    [
      'POST',
      /^\/api\/agent\/settings\/profiles\/connect$/,
      ({ body }) => {
        const agents = demoAgentState(state)
        const id = body?.agentId
        if (!isScripted(id) || !agents.removed.includes(id)) return { demoNote: DEMO_NOTE }
        write({ default: agents.default, removed: agents.removed.filter((item) => item !== id) })
        const agent = DEMO_AGENTS.find((item) => item.id === id)
        return { ...view(), connected: true, result: { ok: true, message: `${agent.label} is connected.`, details: [] } }
      },
    ],
    [
      'DELETE',
      /^\/api\/agent\/settings\/profiles\/([a-z0-9-]+)$/,
      ({ params }) => {
        const agents = demoAgentState(state)
        const [id] = params
        if (!agents.connected.some((agent) => agent.id === id)) fail(404, 'unknown_profile', 'No such agent.')
        if (agents.connected.length === 1) return { demoNote: KEEP_ONE }
        const removed = [...agents.removed, id]
        const left = agents.connected.filter((agent) => agent.id !== id)
        write({ default: agents.default === id ? left[0].id : agents.default, removed })
        return view()
      },
    ],
    [
      'POST',
      /^\/api\/agent\/settings\/profiles\/([a-z0-9-]+)\/default$/,
      ({ params }) => {
        const agents = demoAgentState(state)
        const [id] = params
        if (id === 'endpoint')
          return { demoNote: 'In the demo the chat stays with a scripted agent. On your install chat would use the endpoint.' }
        if (!agents.connected.some((agent) => agent.id === id)) fail(404, 'unknown_profile', 'No such agent.')
        write({ default: id, removed: agents.removed })
        return view()
      },
    ],
  ]
}
