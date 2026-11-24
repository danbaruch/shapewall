// A manual-test fixture: real sandbox code in a fake runtime and a loopback
// model stub. No container daemon or external model/PR call.
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { runSandbox } from '../../src/agent/starter/sandbox-main.js'
export function hostedStarterRuntime() {
  return {
    name: 'podman',
    bin: '/usr/bin/podman',
    async exec(args) {
      return { code: args[0] === 'network' && args[1] === 'inspect' ? 1 : 0, stdout: '', stderr: '' }
    },
    spawn(args) {
      const child = new EventEmitter()
      child.stdin = new PassThrough()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      if (args[0] === 'start') {
        setImmediate(() => child.stdout.write(`${JSON.stringify({ ready: true })}\n`))
        return child
      }
      const mount = args[args.indexOf('-v') + 1].split(':')[0]
      runSandbox({ input: child.stdin, output: child.stdout, root: mount }).finally(() => {
        child.stdout.end()
        setImmediate(() => child.emit('close', 0))
      })
      return child
    },
  }
}
