import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from '../src/config.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// A fresh folder under test/.output (on disk, ignored by git).
export function tempDir(name) {
  const dir = path.join(ROOT, 'test', '.output', `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// PATH without any folder that holds an agent adapter this machine may have
// (claude-agent-acp, codex-acp, goose, gemini): a test that starts the solo
// engine (its own agent, src/remote/local-agent.js) never finds a real agent.
const AGENT_PROGRAMS = ['claude-agent-acp', 'codex-acp', 'goose', 'gemini', 'claude', 'codex']
export function pathWithoutAgents(value = process.env.PATH || '') {
  return value
    .split(path.delimiter)
    .filter((dir) => dir && !AGENT_PROGRAMS.some((name) => fs.existsSync(path.join(dir, name))))
    .join(path.delimiter)
}

// An environment of its own for a test: a home and config folder nobody else uses (never the person's Settings >
// Agent, keys or policy file) and no agent on PATH.
export function isolatedEnv(name, extra = {}) {
  const home = tempDir(name + '-home')
  return {
    PATH: pathWithoutAgents(),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.state'),
    ...extra,
  }
}

export const SAMPLE = {
  title: 'Sample',
  id: 'sample',
  baseUrl: 'http://127.0.0.1:9',
  groups: ['Marketing', 'App'],
  pages: [
    { id: 'home', path: '/', title: 'Home', group: 'Marketing' },
    { id: 'pricing', path: '/pricing', title: 'Pricing', group: 'Marketing', note: 'Prices are placeholders' },
    { id: 'app', path: '/app?tab=notes', title: 'App', group: 'App', viewports: ['desktop'] },
  ],
}

export function sampleConfig(name, overrides = {}) {
  const dir = tempDir(name)
  return normalizeConfig({ ...structuredClone(SAMPLE), ...overrides }, { dir, file: path.join(dir, 'shapewall.config.json') })
}

// http.request, so tests can set any Host header (fetch cannot).
export function request(port, method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        // A new connection each time: a server restarted on the same port
        // must not get a pooled socket of the old one.
        agent: false,
        port,
        method,
        path: pathname,
        headers: {
          ...(data !== null && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}),
          ...(data !== null ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            json = null
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json, body: Buffer.concat(chunks) })
        })
      },
    )
    req.on('error', reject)
    if (data !== null) req.write(data)
    req.end()
  })
}
