// Fictional ACP wrapper with a same-group writer that ignores TERM. No model.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
const root = process.argv[2]
fs.writeFileSync(path.join(root, 'parent.pid'), String(process.pid))
const child = spawn(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import fs from 'node:fs'; import path from 'node:path';
const root = process.argv[1];
process.on('SIGTERM', () => {});
fs.writeFileSync(path.join(root, 'child.pid'), String(process.pid));
const tick = () => fs.appendFileSync(path.join(root, 'ticks'), 'x');
tick(); setInterval(tick, 20); process.send('ready');`,
    root,
  ],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
)
await once(child, 'message')
child.disconnect()
if (process.argv[3] === 'terminal') process.exit(0)
if (process.argv[3] === 'start-error') {
  // Reject startup only after the descendant has installed its TERM handler
  // and written its readiness marker. Slow hosts must reach that same state.
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'initialize')
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: 'Fictional startup failure after descendant ready' },
        }) + '\n',
      )
  })
} else if (process.argv[3] === 'silent') {
  process.stdin.resume()
  process.stdin.on('end', () => process.exit(0))
} else await import('./acp-stub.mjs')
