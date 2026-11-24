import { fileURLToPath } from 'node:url'
import path from 'node:path'

const hosted = fileURLToPath(new URL('../src/hosted/', import.meta.url))
  .split(path.sep)
  .join('/')

// Check resolved inputs before tree shaking, including lazy chunks.
export function clientLicense() {
  return {
    name: 'shapewall-client-license',
    apply: 'build',
    generateBundle() {
      for (const id of this.getModuleIds()) {
        if (id.replaceAll('\\', '/').includes(hosted)) this.error(`The browser bundle includes a hosted server module: ${id}`)
      }
    },
  }
}
