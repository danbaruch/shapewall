// Vite/Rollup plugin: give every built JS chunk a Sentry debug id, so GlitchTip can
// match a minified stack frame to its uploaded source map (scripts/sourcemaps.mjs).
//
// The id and its runtime registration snippet are appended in renderChunk, before
// Rollup computes content hashes, so a chunk's file name changes whenever its bytes
// do. (Injecting after the build, as `sentry-cli sourcemaps inject` does, changes
// bytes under an unchanged hashed name, which immutable CDN caches then serve stale.)
// Appending moves no code, so the existing source map stays exact.
//
// Active only when the build emits source maps. writeBundle copies each id into the
// matching .map file, which sentry-cli reads at upload time.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DEBUG_ID_COMMENT = /\n\/\/# debugId=([0-9a-f-]{36})\n/

function debugIdFor(code) {
  const hex = createHash('sha256').update(code).digest('hex')
  const variant = ['8', '9', 'a', 'b'][parseInt(hex[16], 16) % 4]
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function registration(id) {
  return (
    '!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof globalThis?globalThis:' +
    '"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},' +
    `e._sentryDebugIds[n]="${id}")}catch(e){}}();`
  )
}

// Vite 8 builds with Rolldown, which minifies after every renderChunk hook: the
// snippet survives (minified) but the comment would be stripped. There the comment
// goes in through output.postFooter instead, which Rolldown appends after
// minification and still covers with the file name hash. Rolldown evaluates
// postFooter before renderChunk, so both derive the id from what each sees: the
// chunk's name and its rendered modules' code.
function rolldownIdFor(chunk) {
  // Code only (not absolute module paths), so the id and the hashed file name do not depend on the checkout path.
  const modules = Object.values(chunk.modules || {}).map((module) => module.code ?? '')
  return debugIdFor(`${chunk.name}\0${modules.join('\0')}`)
}

/** @returns {import('vite').Plugin} */
export default function debugIds() {
  return {
    name: 'glitchtip-debug-ids',
    apply: 'build',
    outputOptions(options) {
      if (!this.meta.rolldownVersion || !options.sourcemap) return null
      const previous = options.postFooter
      return {
        ...options,
        async postFooter(chunk) {
          const before = typeof previous === 'function' ? await previous(chunk) : previous || ''
          return `${before}\n//# debugId=${rolldownIdFor(chunk)}\n`
        },
      }
    },
    // order 'post': with Rollup (Vite 7 and older) this runs after Vite's
    // minifier, which would otherwise move the snippet and strip the comment.
    renderChunk: {
      order: 'post',
      handler(code, chunk, outputOptions) {
        if (!outputOptions.sourcemap) return null
        if (this.meta.rolldownVersion) {
          return { code: `${code}\n;${registration(rolldownIdFor(chunk))}\n`, map: null }
        }
        const id = debugIdFor(code)
        return { code: `${code}\n;${registration(id)}\n//# debugId=${id}\n`, map: null }
      },
    },
    async writeBundle(outputOptions, bundle) {
      if (!outputOptions.sourcemap || !outputOptions.dir) return
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        const match = DEBUG_ID_COMMENT.exec(output.code)
        if (!match) continue
        const mapPath = join(outputOptions.dir, output.sourcemapFileName || `${output.fileName}.map`)
        let map
        try {
          map = JSON.parse(await readFile(mapPath, 'utf8'))
        } catch {
          continue
        }
        map.debug_id = match[1]
        map.debugId = match[1]
        await writeFile(mapPath, JSON.stringify(map))
      }
    },
  }
}
