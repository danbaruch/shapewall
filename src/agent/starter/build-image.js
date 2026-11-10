// `shapewall agent build-image`: builds the starter agent's image from the
// Dockerfile.agent that ships in this package, so an npm install is enough
// (no clone of the source). The image is built on this machine and never
// pulled or pushed; `agent run` starts it with --pull never.
//
// The build context is a folder made for the build with only what the
// Dockerfile copies: package.json, the lockfile, LICENSE, NOTICE, bin and
// src. npm never puts package-lock.json in a package, so the package ships
// a copy in dist/agent/ (the prepack script); a clone has its own. The
// image always installs the locked versions: the Playwright in it must
// match the browsers of its base image.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// The installed package's own folder (or the clone's).
export const PACKAGE_DIR = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)))
export const DOCKERFILE = 'Dockerfile.agent'
export const CONTEXT_FILES = ['package.json', 'LICENSE', 'NOTICE', DOCKERFILE]
export const CONTEXT_DIRS = ['bin', 'src']
// Where the lockfile is: a clone's own, else the package's copy.
export const LOCKFILES = ['package-lock.json', path.join('dist', 'agent', 'package-lock.json')]

export function buildImageArgs({ image, context }) {
  return ['build', '-f', path.join(context, DOCKERFILE), '-t', image, context]
}

// A fresh build context under the cache folder (on disk), from `dir`.
export function prepareContext({ dir = PACKAGE_DIR, env = process.env } = {}) {
  if (!fs.existsSync(path.join(dir, DOCKERFILE))) {
    throw new Error(`${DOCKERFILE} is not in ${dir}: reinstall shapewall, or build from a clone of the repository`)
  }
  const lock = LOCKFILES.map((rel) => path.join(dir, rel)).find((file) => fs.existsSync(file))
  if (!lock) throw new Error(`no package-lock.json in ${dir} (nor its dist/agent copy): reinstall shapewall, or build from a clone`)
  const cache =
    env.XDG_CACHE_HOME || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches') : path.join(os.homedir(), '.cache'))
  const context = path.join(cache, 'shapewall', `agent-image-${randomBytes(4).toString('hex')}`)
  fs.mkdirSync(context, { recursive: true, mode: 0o700 })
  try {
    for (const name of CONTEXT_FILES) fs.copyFileSync(path.join(dir, name), path.join(context, name))
    for (const name of CONTEXT_DIRS) fs.cpSync(path.join(dir, name), path.join(context, name), { recursive: true, verbatimSymlinks: true })
    fs.copyFileSync(lock, path.join(context, 'package-lock.json'))
  } catch (error) {
    fs.rmSync(context, { recursive: true, force: true })
    throw error
  }
  return context
}

// Runs `<runtime> build` without a shell, its output streamed as it comes,
// then removes the context. Resolves the exit code.
export async function buildImage({
  runtime,
  image,
  dir = PACKAGE_DIR,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  spawnImpl = spawn,
  onArgs = () => {},
}) {
  const context = prepareContext({ dir, env })
  const args = buildImageArgs({ image, context })
  onArgs(args)
  try {
    return await new Promise((resolve) => {
      let child
      try {
        child = spawnImpl(runtime.bin, args, { cwd: context, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
      } catch (error) {
        stderr.write(`could not start ${runtime.name}: ${error.message}\n`)
        resolve(1)
        return
      }
      child.stdout.on('data', (chunk) => stdout.write(chunk))
      child.stderr.on('data', (chunk) => stderr.write(chunk))
      child.once('error', (error) => {
        stderr.write(`could not start ${runtime.name}: ${error.message}\n`)
        resolve(1)
      })
      child.once('close', (code) => resolve(code ?? 1))
    })
  } finally {
    fs.rmSync(context, { recursive: true, force: true })
  }
}
