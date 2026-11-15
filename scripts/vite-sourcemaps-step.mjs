// Vite plugin for shapewall.com and its public demo only (website/vite.config.js, vite.demo.config.js); the
// Shapewall package build (vite.config.js, vite.console.config.js) does not use it and ships no source maps.
//
// After the build writes its hidden source maps (scripts/vite-debug-ids.mjs gives each chunk a debug id), run
// scripts/sourcemaps.mjs on the output dir: it uploads the maps to our GlitchTip only when SHAPEWALL_SOURCEMAPS=1
// (website/deploy/deploy.sh sets it) and there is a release id, and it always deletes every .map, failing the build
// if one survives. `release` must be exactly what that build's error reporting sends.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./sourcemaps.mjs', import.meta.url))

/** @returns {import('vite').Plugin} */
export default function sourcemapsStep({ release }) {
  let dist = ''
  return {
    name: 'shapewall-sourcemaps-step',
    apply: 'build',
    configResolved(config) {
      dist = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const upload = process.env.SHAPEWALL_SOURCEMAPS === '1' && release ? release : ''
      execFileSync(process.execPath, [SCRIPT, '--dist', dist, '--project', 'shapewall', '--release', upload], {
        stdio: 'inherit',
      })
    },
  }
}
