// Finding a program on PATH the careful way, for programs Shapewall runs on
// its own (git for the local name) or offers to run (the agents found for
// one-click Connect):
//
// - only absolute PATH entries: an empty entry, `.` or any relative folder
//   would make the current folder (a project, a cloned repo) decide what
//   runs;
// - on Windows, only `.exe` and `.com` count as runnable. A `.cmd` or `.bat`
//   wrapper (what npm installs) needs a shell, which Shapewall never uses, so
//   it is reported as found but not runnable.
//
// { path, runnable } or null. Never runs anything.

import fs from 'node:fs'
import path from 'node:path'

const WINDOWS_RUNNABLE = ['.exe', '.com']
const WINDOWS_SCRIPTS = ['.cmd', '.bat']

function isFile(file, { executable }) {
  try {
    if (executable) fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

export function lookupProgram(name, env = process.env, { platform = process.platform } = {}) {
  const windows = platform === 'win32'
  const pathOf = windows ? env.Path || env.PATH : env.PATH
  const dirs = String(pathOf || '')
    .split(windows ? ';' : ':')
    .filter((dir) => dir && (windows ? path.win32.isAbsolute(dir) : path.posix.isAbsolute(dir)))
  let script = null
  for (const dir of dirs) {
    if (!windows) {
      const file = path.join(dir, name)
      if (isFile(file, { executable: true })) return { path: file, runnable: true }
      continue
    }
    for (const ext of WINDOWS_RUNNABLE) {
      const file = path.join(dir, name + ext)
      if (isFile(file, { executable: false })) return { path: file, runnable: true }
    }
    for (const ext of WINDOWS_SCRIPTS) {
      const file = path.join(dir, name + ext)
      if (!script && isFile(file, { executable: false })) script = { path: file, runnable: false }
    }
  }
  return script
}

// The absolute path of a runnable program, or null.
export function absoluteProgram(name, env = process.env, options = {}) {
  const found = lookupProgram(name, env, options)
  return found?.runnable ? found.path : null
}
