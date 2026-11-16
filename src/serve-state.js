// The address a running `shapewall serve` answers on, so links made by other
// commands (notifications from `comments resolve`, `watch`, `mcp`; GitHub
// issues) point at the real port instead of a guess.
//
// `serve` writes <outputDir>/serve.json when it listens and removes it when
// it stops; a file left by a crashed server is ignored (its pid is gone).

import fs from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from './store.js'

export const DEFAULT_PORT = 4600
export const DEFAULT_BOARD_URL = `http://127.0.0.1:${DEFAULT_PORT}/`

const stateFile = (config) => path.join(config.outputDir, 'serve.json')

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// The URL to open a board served on host:port. A wildcard address is not
// something to click, so it becomes the loopback name.
export function servedUrl(host, port) {
  const wildcard = host === '0.0.0.0' || host === '::' || host === '[::]'
  const name = wildcard ? '127.0.0.1' : host.includes(':') ? `[${host.replace(/^\[|\]$/g, '')}]` : host
  return `http://${name}:${port}/`
}

export function writeServeState(config, url) {
  try {
    fs.mkdirSync(config.outputDir, { recursive: true })
    writeJsonAtomic(stateFile(config), { url, pid: process.pid, startedAt: new Date().toISOString() })
    return true
  } catch {
    return false
  }
}

export function clearServeState(config) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(config), 'utf8'))
    if (state?.pid === process.pid) fs.rmSync(stateFile(config), { force: true })
  } catch {
    /* nothing to clear */
  }
}

// What serve.json records, running or not: { url, port, alive }, or null.
// A file a crashed server left still says which port the project was last
// served on, so doctor checks that one rather than the default.
export function recordedServe(config) {
  if (!config?.outputDir) return null
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(config), 'utf8'))
    if (typeof state?.url !== 'string' || !/^https?:\/\//.test(state.url)) return null
    const port = Number(new URL(state.url).port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return { url: state.url, port, alive: alive(state.pid) }
  } catch {
    return null
  }
}

// The running server's URL, or null.
export function runningBoardUrl(config) {
  if (!config?.outputDir) return null
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(config), 'utf8'))
    if (typeof state?.url !== 'string' || !/^https?:\/\//.test(state.url) || !alive(state.pid)) return null
    return state.url
  } catch {
    return null
  }
}
