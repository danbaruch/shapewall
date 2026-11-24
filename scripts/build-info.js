import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

// Artifact metadata contains no machine paths, identities or build environment.
const root = new URL('../', import.meta.url)
const { version } = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'))
let revision = process.env.SHAPEWALL_BUILD_REVISION || ''
if (!revision) {
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    revision = ''
  }
}
if (!/^[a-f0-9]{7,40}$/i.test(revision)) revision = ''
export const buildInfo = { version, revision }
export const appDefines = { __APP_VERSION__: JSON.stringify(version), __APP_REVISION__: JSON.stringify(revision) }
export function buildMetadata() {
  return {
    name: 'shapewall-build-info',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify(buildInfo) + '\n' })
    },
  }
}
