// Saves agent settings for `count` projects named <prefix>-<n> under <dir>, as
// fast as it can: two of these at once must not lose each other's saves
// (test/agent-settings.test.js). Usage: node save-settings.mjs <file> <dir> <prefix> <count>
import fs from 'node:fs'
import path from 'node:path'
import { saveUserAgentEntry } from '../../src/agent/user-settings.js'

const [file, dir, prefix, count] = process.argv.slice(2)
const env = { SHAPEWALL_AGENT_SETTINGS_FILE: file }
for (let index = 0; index < Number(count); index += 1) {
  const project = path.join(dir, `${prefix}-${index}`)
  fs.mkdirSync(project, { recursive: true })
  saveUserAgentEntry(project, { model: `${prefix}-${index}` }, env)
}
