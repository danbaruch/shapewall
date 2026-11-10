// `serve` picks up edits to shapewall.config.json without a restart: the
// title, boards (pages, groups, journeys, environments, sitemap) and the
// capture settings. The server reads `config` on every request, so the new
// values are swapped into the same object. Anything that changes who or
// what the server talks to (agent, notifications, GitHub, auth, output
// folder) still needs a restart, and the log says so.
//
// The folder is watched, not the file: editors save by writing a new file
// and renaming it over the old one, which a watch on the file would miss.

import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config.js'

export const RELOADED_KEYS = [
  'title',
  'boards',
  'viewports',
  'concurrency',
  'capturePacing',
  'timeouts',
  'versions',
  'block',
  'reducedMotion',
]
const RESTART_KEYS = ['outputDir', 'boardUrl', 'auth', 'browser', 'liveHtml', 'agent', 'starterAgent', 'notifications', 'github']
const DEBOUNCE_MS = 150

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Reads the config file again and applies what can change live. Returns
// { applied, restart } (key names), or { error } with the config untouched.
export function reloadConfig(config, { load = loadConfig } = {}) {
  let next
  try {
    next = load(config.file)
  } catch (error) {
    return { error }
  }
  const applied = RELOADED_KEYS.filter((key) => !same(config[key], next[key]))
  const restart = RESTART_KEYS.filter((key) => !same(config[key], next[key]))
  for (const key of applied) config[key] = next[key]
  return { applied, restart }
}

// Starts watching; returns stop(). `log` gets one line per reload.
export function watchConfig(config, { log = () => {}, server = null } = {}) {
  if (!config.file) return () => {}
  const name = path.basename(config.file)
  let last = readText(config.file)
  let timer = null
  let watcher
  const check = () => {
    timer = null
    const text = readText(config.file)
    if (text === null || text === last) return
    last = text
    const result = reloadConfig(config)
    if (result.error) {
      log(`Config not reloaded (the board keeps the last good one): ${oneLine(result.error)}`)
      return
    }
    if (result.applied.length) log(`Config reloaded: ${result.applied.join(', ')}. Refresh the board to see it.`)
    if (result.restart.length) log(`Config: restart serve to apply ${result.restart.join(', ')}.`)
  }
  try {
    watcher = fs.watch(path.dirname(config.file), (event, file) => {
      if (file && file !== name) return
      clearTimeout(timer)
      timer = setTimeout(check, DEBOUNCE_MS)
    })
    watcher.on('error', () => stop())
    watcher.unref()
  } catch {
    return () => {}
  }
  function stop() {
    clearTimeout(timer)
    watcher?.close()
    watcher = null
  }
  server?.once('close', stop)
  return stop
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function oneLine(error) {
  return String(error?.message || error)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('; ')
}
