// Commands running now, for other Shapewall processes: while a command
// runs (sandbox-exec.js), a file naming its folder sits in a folder only
// this user can open, never one a command can read. `shapewall auth record`
// records no login in a project a command runs in (Q7 C4).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

const realpath = (value) => (fs.realpathSync.native || fs.realpathSync)(value)
const isInside = (parent, child) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function commandMarksDir(env = process.env) {
  const base = env.XDG_RUNTIME_DIR && path.isAbsolute(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : os.tmpdir()
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  return path.join(base, env.XDG_RUNTIME_DIR ? 'shapewall-commands' : `shapewall-commands-${uid}`)
}
export function markCommand(real, env) {
  try {
    const dir = commandMarksDir(env)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(
      dir,
      `${process.pid}-${createHash('sha256').update(real).digest('hex').slice(0, 16)}-${randomBytes(4).toString('hex')}`,
    )
    fs.writeFileSync(file, real, { mode: 0o600, flag: 'wx' })
    return () => fs.rmSync(file, { force: true })
  } catch {
    return () => {}
  }
}
// The folders commands run in now, in, inside or around `dir`, of live processes.
export function commandsRunningIn(dir, env = process.env) {
  let real = dir
  try {
    real = realpath(dir)
  } catch {
    /* compared as given */
  }
  const out = []
  let names = []
  try {
    names = fs.readdirSync(commandMarksDir(env))
  } catch {
    return out
  }
  for (const name of names) {
    const pid = Number(name.split('-')[0])
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') continue
    }
    let root
    try {
      root = fs.readFileSync(path.join(commandMarksDir(env), name), 'utf8')
    } catch {
      continue
    }
    if (isInside(root, real) || isInside(real, root)) out.push(root)
  }
  return out
}
