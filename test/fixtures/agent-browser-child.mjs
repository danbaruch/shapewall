// Opens an agent browser on the given origin, prints its profile folder,
// then waits to be stopped (agent-browser e2e: cleanup after a signal).
import { createAgentBrowser } from '../../src/agent/agent-browser.js'

const [tmpRoot, origin] = process.argv.slice(2)
const browser = createAgentBrowser({ browser: { on: true, allow: [origin], auth: null, profile: null }, tmpRoot })
await browser.navigate(origin + '/')
process.stdout.write(JSON.stringify({ dir: browser.dir }) + '\n')
setInterval(() => {}, 1000)
