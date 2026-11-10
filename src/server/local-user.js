// The name of the person running Shapewall on this machine, as a default
// for the board's profile avatar and the author of new comments:
// SHAPEWALL_USER_NAME, else `git config user.name` as seen from the project
// folder. Only ever sent to a browser on this machine, on a board not shared
// beyond it (src/server/app.js /api/info).
//
// git is found on absolute PATH entries only (src/which.js) and started from
// a neutral folder with `-C <project>`, never with the project as its working
// folder: on Windows a program is looked up in the working folder first, so a
// git.exe at the root of a cloned repo would otherwise run. Hooks, fsmonitor
// and the system config are off, as for the starter agent's git.

import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { SAFE_GIT_FLAGS } from '../agent/starter/worktree.js'
import { absoluteProgram } from '../which.js'

const NAME_MAX = 60
export const USER_NAME_VAR = 'SHAPEWALL_USER_NAME'

function clean(value) {
  const text = String(value || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, NAME_MAX) : null
}

export function gitUserName(dir, env = process.env, { spawn = spawnSync } = {}) {
  const git = absoluteProgram('git', env)
  if (!git) return null
  try {
    const result = spawn(git, [...SAFE_GIT_FLAGS, '-C', dir, 'config', '--get', 'user.name'], {
      cwd: os.tmpdir(),
      env: {
        PATH: env.PATH || '',
        HOME: env.HOME || os.homedir(),
        ...(env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } : {}),
        ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      shell: false,
    })
    return result.status === 0 ? clean(result.stdout) : null
  } catch {
    return null
  }
}

// SHAPEWALL_USER_NAME wins (a name of your choice), then git. null: the board
// asks for a name on the first comment, as before.
export function localUserName(dir, env = process.env) {
  return clean(env[USER_NAME_VAR]) || gitUserName(dir, env)
}
