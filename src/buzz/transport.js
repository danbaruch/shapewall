import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SIGNER_FILE_VARS } from './config.js'
import { signerBaseEnvironment } from './environment.js'

const CHILD = fileURLToPath(new URL('./signer-child.js', import.meta.url))

export function runSigner(configFile, request) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, configFile], {
      detached: true,
      // No Buzz, model/provider, SSH or other inherited credentials.
      // Only the two signer file paths (not secrets) pass through.
      env: {
        ...signerBaseEnvironment(),
        ...Object.fromEntries(
          Object.values(SIGNER_FILE_VARS)
            .filter((name) => typeof process.env[name] === 'string')
            .map((name) => [name, process.env[name]]),
        ),
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let output = ''
    let invalid = false
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* only this owned child group */
      }
    }
    const timer = setTimeout(() => {
      invalid = true
      kill()
    }, 45000)
    child.stdout.on('data', (part) => {
      output += part
      if (Buffer.byteLength(output) > 1024 * 1024) {
        invalid = true
        kill()
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ outcome: 'unknown' })
    })
    child.on('close', () => {
      clearTimeout(timer)
      if (invalid) return resolve({ outcome: 'unknown' })
      try {
        resolve(JSON.parse(output))
      } catch {
        resolve({ outcome: 'unknown' })
      }
    })
  })
}
