// Helpers for the connected-agent tests: approving `shapewall agent
// connect` through the real device login, running the link in this process
// against the stub ACP agent (test/fixtures/acp-stub.mjs), and reading a
// chat turn's event stream as the board does.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBackend } from '../src/agent/backends/index.js'
import { REMOTE_PREAMBLE } from '../src/agent/context.js'
import { runAgentLink } from '../src/remote/agent-link.js'
import { createRemote } from '../src/remote/remote.js'
import { reauth } from './hosted-helpers.js'
import { tempDir } from './helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ACP_STUB = path.join(HERE, 'fixtures', 'acp-stub.mjs')

export async function until(check, label, ms = 15_000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// The device login of `shapewall agent connect`, approved by `user`: the
// CLI's start and poll over HTTP, the console's lookup and approve.
// Returns { token, agentId, result } (the token as the CLI would save it).
export async function connectAgent(
  hosted,
  user,
  { workspaceId, projectId, name = 'Builder', kind = 'claude', audience, users, icon, tint, machine = 'studio' },
) {
  const post = async (pathname, body) => {
    const response = await fetch(`http://127.0.0.1:${hosted.port}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, json: await response.json().catch(() => null) }
  }
  hosted.rateLimiter.reset()
  const started = await post('/api/v1/device/start', { name: machine, purpose: 'agent', agent: { kind, name } })
  if (started.status !== 201) throw new Error(`device start ${started.status} ${JSON.stringify(started.json)}`)
  await reauth(user)
  const approved = await user.browser.post('/api/device/approve', {
    code: started.json.userCode,
    workspaceId,
    projectId,
    agent: { name, ...(audience ? { audience } : {}), ...(users ? { users } : {}), ...(icon ? { icon } : {}), ...(tint ? { tint } : {}) },
  })
  if (approved.status !== 200) return { status: approved.status, error: approved.json?.error, code: started.json.userCode }
  const polled = await post('/api/v1/device/poll', { deviceCode: started.json.deviceCode })
  if (polled.status !== 200) throw new Error(`device poll ${polled.status} ${JSON.stringify(polled.json)}`)
  return { status: 200, token: polled.json.token, agentId: polled.json.agent.id, result: polled.json, info: approved.json.info }
}

// The link of a connected agent, in this process, running the stub ACP
// agent read-only in `cwd`. Returns { stop, logs, ready, backend }.
export function startLink(
  hosted,
  token,
  {
    cwd = tempDir('hosted-chat-project'),
    args = [],
    policy = { audience: 'server' },
    kind = 'claude',
    maxTurns = 2,
    env = {},
    limits = {},
    // A backend of the test's own in place of the stub ACP agent.
    backend: given = null,
    fetchImpl = fetch,
    remote = true,
  } = {},
) {
  const logs = []
  const controller = new AbortController()
  const backend =
    given ||
    createBackend(
      {
        configured: true,
        backend: 'acp',
        label: 'Stub agent',
        // The modes Claude Code's adapter lists: a read-only session needs a mode that asks.
        acp: { argv: [process.execPath, ACP_STUB, '--ro-modes', ...args] },
        readOnly: true,
        preamble: REMOTE_PREAMBLE,
        vision: false,
      },
      {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
        root: cwd,
        protect: [path.join(cwd, '.shapewall')],
        log: (line) => logs.push(line),
      },
    )
  let ready
  const whenReady = new Promise((resolve) => (ready = resolve))
  const done = runAgentLink({
    origin: hosted.origin,
    token,
    backend,
    hello: { kind, machine: 'studio', version: '0.5.0', maxTurns },
    policy,
    remote: remote ? createRemote({ origin: hosted.origin, token }) : null,
    fetchImpl,
    signal: controller.signal,
    log: (line) => logs.push(line),
    limits: { backoffMinMs: 50, backoffMaxMs: 200, batchMs: 20, ...limits },
    onReady: (said) => ready(said),
  })
  let failure = null
  done.catch((error) => {
    failure = error
    ready(null)
  })
  return {
    logs,
    backend,
    cwd,
    ready: whenReady,
    done,
    failure: () => failure,
    stop: async () => {
      controller.abort()
      await done.catch(() => {})
      backend.close?.()
    },
  }
}

// A server-sent event stream's text as [{ id, name, data }].
export function parseEvents(text) {
  return String(text || '')
    .split('\n\n')
    .map((block) => {
      const name = /^event: (.*)$/m.exec(block)?.[1]
      const raw = /^data: (.*)$/m.exec(block)?.[1]
      if (!name || raw === undefined) return null
      const id = Number(/^id: (.*)$/m.exec(block)?.[1]) || null
      try {
        return { id, name, data: JSON.parse(raw) }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// Sends a chat message as `user` and reads the turn to its end:
// { status, json, events, final } (`final`: the stored answer).
export async function chat(user, url, body) {
  const response = await user.browser.post(url, typeof body === 'string' ? { text: body } : body)
  const events = response.status === 200 ? parseEvents(response.text) : []
  return {
    status: response.status,
    json: response.json,
    events,
    final: events.find((event) => event.name === 'done')?.data.message || null,
    text: response.text,
  }
}
