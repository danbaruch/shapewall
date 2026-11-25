// `shapewall agent setup` and `shapewall agent docs`: how a coding agent
// opened in the project finds the board (src/agent-setup.js, src/agent-docs.js).

import fs from 'node:fs'
import path from 'node:path'
import { findConfigFile, loadConfig } from '../config.js'
import { cliCommand } from '../invocation.js'
import { applySetup, formatPlan, planJson, planSetup, shownPath, willWrite } from '../agent-setup.js'
import { describeWritten, findBlock, planAgentDocs, readState, removeAgentDocs, writeAgentDocs, agentDocsBlock } from '../agent-docs.js'

const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

async function askYesNo(question) {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}

// The project folder and the config to name (only when it is not the
// default shapewall.config.json there, which `shapewall mcp` finds itself).
function projectFor(flags, env) {
  const file = findConfigFile(flags.config)
  const exists = fs.existsSync(file)
  if (!exists && flags.remote === undefined)
    throw new Error(`No config at ${file}. Run "${cliCommand('init')}" first (or pass --remote URL for a hosted board).`)
  const named = Boolean(flags.config || env.SHAPEWALL_CONFIG)
  return { dir: exists ? path.dirname(file) : process.cwd(), configFile: exists && named ? file : null }
}

// With --remote the MCP server signs in with the login `shapewall login` saved: check there is one.
async function remoteFor(flags, env) {
  if (flags.remote === undefined) return null
  const { remoteOrigin } = await import('../remote/remote.js')
  const origin = remoteOrigin({ remote: flags.remote }, env)
  if (flags.remove) return origin
  const { readCredential } = await import('../remote/credentials.js')
  let saved = null
  try {
    saved = readCredential(origin, env)
  } catch (error) {
    throw new Error(`Could not read the saved logins: ${error.message}`, { cause: error })
  }
  if (!saved)
    throw new Error(
      `No saved login for ${origin}. Run "${cliCommand(`login --remote ${origin}`)}" first, then agent setup again (the MCP server uses that login; no token is written into the agent's config).`,
    )
  return origin
}

export async function agentSetupCommand(
  flags,
  out,
  err,
  { env = process.env, ask = askYesNo, interactive = Boolean(process.stdin.isTTY), run } = {},
) {
  const { dir, configFile } = projectFor(flags, env)
  const remote = await remoteFor(flags, env)
  const setup = planSetup({ dir, flags: { ...flags, remote: remote || undefined }, version: VERSION, env, configFile })
  const json = Boolean(flags.json)
  if (!setup.plans.length) {
    const message = 'Neither claude nor codex is on PATH. Name the app with --claude or --codex.'
    if (json) out(JSON.stringify({ ok: false, error: message, plans: [] }, null, 2))
    else err(message)
    return 1
  }
  const writes = setup.plans.filter(willWrite)
  const blocked = setup.plans.some((plan) => plan.action === 'differs' || plan.action === 'skip')
  const report = (extra) => out(JSON.stringify({ ok: !blocked, dryRun: Boolean(flags['dry-run']), plans: setup.plans.map(planJson), ...extra }, null, 2))
  if (!json) for (const line of formatPlan(setup)) out(line)
  if (!writes.length || flags['dry-run']) {
    if (json) report({ applied: [] })
    else if (flags['dry-run'] && writes.length) out('Dry run: nothing was written.')
    else if (!blocked && !flags.remove) out(nextStep())
    return blocked ? 1 : 0
  }
  if (!flags.yes) {
    if (!interactive || json) {
      const message = 'Add --yes to write these changes (there is no terminal to ask in).'
      if (json) report({ applied: [], error: message })
      else err(message)
      return 1
    }
    if (!(await ask('Write these changes? [y/N] '))) {
      out('Nothing was written.')
      return 1
    }
  }
  const applied = await applySetup(setup, { dir, env, ...(run ? { run } : {}) })
  const failed = applied.some((item) => !item.ok)
  if (json) {
    report({ applied, ok: !blocked && !failed })
    return blocked || failed ? 1 : 0
  }
  for (const item of applied) {
    const name = item.app === 'claude' ? 'Claude Code' : 'Codex'
    if (!item.ok) {
      err(`${name}: ${item.error}`)
      continue
    }
    const what = item.action === 'remove' ? 'removed the shapewall server' : 'registered the shapewall server'
    out(`${name}: ${what}.${item.backup ? ` Backup: ${shownPath(item.backup, env)}` : ''}`)
    if (item.app === 'codex' && item.checked && item.action !== 'remove')
      out(`  codex mcp get shapewall: tool_timeout_sec ${item.checked.tool_timeout_sec ?? 'not set'}`)
  }
  if (!failed && !blocked && !flags.remove) out(nextStep())
  return blocked || failed ? 1 : 0
}

const nextStep = () => 'Next: open Claude Code or Codex in this project and ask: "take the open Shapewall comments".'

// `agent docs`: where the section is; --write puts it in (or refreshes it),
// --remove takes it out, --print prints it.
export function agentDocsCommand(flags, out) {
  if (flags.print) {
    out(agentDocsBlock())
    return 0
  }
  const config = loadConfig(flags.config)
  if (flags.write && flags.remove) throw new Error('agent docs: --write or --remove, not both')
  if (flags.remove) {
    const result = removeAgentDocs(config.dir, config.outputDir)
    for (const note of result.notes) out(note)
    if (!result.removed.length) out('No Shapewall section to remove.')
    else {
      out(`Removed the Shapewall section from ${result.removed.join(' and ')}.`)
      if (result.deleted.length) out(`Deleted ${result.deleted.join(' and ')} (Shapewall made ${result.deleted.length === 1 ? 'it' : 'them'}; nothing else was in ${result.deleted.length === 1 ? 'it' : 'them'}).`)
      out('serve and capture will not add it back.')
    }
    return 0
  }
  if (flags.write) {
    const result = writeAgentDocs(config.dir, config.outputDir)
    for (const note of result.notes) out(note)
    out(result.changed ? `Wrote the Shapewall section to ${describeWritten(result)}.` : `The Shapewall section in ${result.files.join(' and ')} is up to date.`)
    return 0
  }
  const plan = planAgentDocs(config.dir)
  const state = readState(config.outputDir)
  const has = []
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      if (findBlock(fs.readFileSync(path.join(config.dir, name), 'utf8'), name)) has.push(name)
    } catch {
      /* missing or unreadable */
    }
  }
  out(has.length ? `The Shapewall section is in ${has.join(' and ')}.` : 'No Shapewall section in AGENTS.md or CLAUDE.md.')
  const pending = plan.changes.filter((change) => change.action !== 'same').map((change) => `${change.action} ${change.name}`)
  if (pending.length) out(`"agent docs --write" would: ${pending.join(', ')}.`)
  for (const note of plan.notes) out(note)
  if (config.agentDocs === false) out('The config says "agentDocs": false, so serve and capture never add it.')
  else if (state?.removed) out('It was removed with agent docs --remove, so serve and capture do not add it back.')
  return 0
}
