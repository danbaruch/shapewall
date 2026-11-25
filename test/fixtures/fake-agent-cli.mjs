#!/usr/bin/env node
// A stand-in for the `claude` and `codex` CLIs in test/agent-setup.test.js:
// records its argv in $FAKE_CLI_LOG and does what the real ones do with the
// files (spike S4): claude mcp add-json refuses a name that is there, remove
// takes -s SCOPE; codex mcp get NAME --json prints the entry.
import fs from 'node:fs'
import path from 'node:path'

const name = path.basename(process.argv[1]).replace(/\.mjs$/, '')
const args = process.argv.slice(2)
if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ name, args, cwd: process.cwd() })}\n`)

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}
const claudeFile = () => path.join(process.env.CLAUDE_CONFIG_DIR || process.env.HOME, '.claude.json')

if (name === 'claude') {
  const [mcp, action, flag, scope, server, json] = args
  if (mcp !== 'mcp' || flag !== '-s') process.exit(2)
  const file = scope === 'project' ? path.join(process.cwd(), '.mcp.json') : claudeFile()
  const data = readJson(file)
  let servers
  if (scope === 'local') {
    data.projects ||= {}
    data.projects[fs.realpathSync(process.cwd())] ||= {}
    servers = data.projects[fs.realpathSync(process.cwd())].mcpServers ||= {}
  } else servers = data.mcpServers ||= {}
  if (action === 'add-json') {
    // A failure on demand: add-json of an entry with this command fails.
    if (process.env.FAKE_CLAUDE_FAIL_COMMAND && JSON.parse(json).command === process.env.FAKE_CLAUDE_FAIL_COMMAND) {
      process.stderr.write('add-json failed on purpose\n')
      process.exit(1)
    }
    if (servers[server]) {
      process.stderr.write(`MCP server ${server} already exists in ${scope} config\n`)
      process.exit(1)
    }
    servers[server] = JSON.parse(json)
  } else if (action === 'remove') {
    if (!servers[server]) process.exit(1)
    delete servers[server]
  } else process.exit(2)
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
  process.exit(0)
}

if (name === 'codex') {
  const text = fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8')
  const timeout = /tool_timeout_sec = (\d+)/.exec(text)
  process.stdout.write(JSON.stringify({ name: 'shapewall', tool_timeout_sec: timeout ? Number(timeout[1]) : null }))
  process.exit(0)
}
process.exit(2)
