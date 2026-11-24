// A private, per-user index of local projects. It holds config paths, never
// commands, settings tokens or agent credentials. Each project keeps its
// own server and agent root; switching projects navigates to that server.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { loadConfig } from './config.js'
import { projectKey, userSettingsFile, withSettingsLock } from './agent/user-settings.js'
import { runningBoardUrl } from './serve-state.js'

const MAX_PROJECTS = 100
const MAX_BYTES = 1024 * 1024
export const projectId = (file) => createHash('sha256').update(projectKey(file)).digest('hex').slice(0, 24)

export function projectsFile(env = process.env) {
  const settings = userSettingsFile(env)
  return settings ? path.join(path.dirname(settings), 'projects.json') : null
}

function safe(file) {
  for (const target of [path.dirname(file), file]) {
    let stat
    try {
      stat = fs.lstatSync(target)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error('The local project index must not be a symlink.')
    if (process.platform !== 'win32' && typeof process.getuid === 'function') {
      if (stat.uid !== process.getuid() || stat.mode & 0o022)
        throw new Error('The local project index must be owned and writable only by you.')
    }
    if (target === file && (!stat.isFile() || stat.size > MAX_BYTES))
      throw new Error('The local project index is not a small regular file.')
  }
}

function read(file) {
  safe(file)
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw new Error('The local project index could not be read. Fix projects.json in your Shapewall settings folder.', { cause: error })
  }
  if (data?.version !== 1 || !Array.isArray(data.projects) || data.projects.length > MAX_PROJECTS)
    throw new Error('Invalid local project index.')
  return data.projects.filter(
    (entry) => typeof entry?.file === 'string' && path.isAbsolute(entry.file) && entry.id === projectId(entry.file),
  )
}

// Registration is best-effort at init/serve; a broken index must not stop a
// board. Callers surface a warning instead of silently replacing bad data.
export function registerProject(config, env = process.env) {
  const file = projectsFile(env)
  if (!file || !config.file) return
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  safe(file)
  return withSettingsLock(file, () => {
    const entries = read(file)
    const target = projectKey(config.file)
    const id = projectId(target)
    const projects = [{ id, file: target }, ...entries.filter((entry) => entry.id !== id)].slice(0, MAX_PROJECTS)
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, projects }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      fs.renameSync(temp, file)
    } finally {
      try {
        fs.unlinkSync(temp)
      } catch {
        // Rename normally consumed the temporary file. Preserve the original
        // write error if cleanup was needed but could not finish.
      }
    }
    return id
  })
}

// Never navigate to arbitrary URLs from a registry or serve-state file.
// Remote access has its own identity/pairing model, not this local index.
export function localProjectUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
      ? url.href
      : null
  } catch {
    return null
  }
}

// A live PID is only a hint: PIDs and ports can be reused. Before enabling
// navigation, ask the listener for this exact project's identity. No cookies,
// tokens or redirects; responses are bounded and only loopback is allowed.
function servesProject(url, id) {
  return new Promise((resolve) => {
    if (!localProjectUrl(url)) return resolve(false)
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const request = http.get(new URL('api/local-project-id', url), (response) => {
      let body = ''
      if (response.statusCode !== 200) {
        response.resume()
        finish(false)
        return
      }
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
        if (body.length > 512) request.destroy()
      })
      response.on('error', () => finish(false))
      response.on('end', () => {
        try {
          finish(JSON.parse(body).projectId === id)
        } catch {
          finish(false)
        }
      })
    })
    const timer = setTimeout(() => {
      request.destroy()
      finish(false)
    }, 500)
    request.on('error', () => finish(false))
  })
}

export async function listLocalProjects(config, env = process.env) {
  const file = projectsFile(env)
  const entries = file ? read(file) : []
  const current = config?.file ? projectId(config.file) : null
  if (config?.file && !entries.some((entry) => entry.id === current)) entries.unshift({ id: current, file: config.file })
  const projects = entries
    .flatMap((entry) => {
      try {
        const project = entry.id === current ? config : loadConfig(entry.file)
        const url = localProjectUrl(runningBoardUrl(project))
        return [
          {
            id: entry.id,
            title: project.title,
            current: entry.id === current,
            url,
            running: Boolean(url),
            boardCount: project.boards.length,
          },
        ]
      } catch {
        // Removed folders and invalid configs are not usable projects.
        return []
      }
    })
    .sort((a, b) => a.title.localeCompare(b.title))
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(4, projects.length) }, async () => {
      while (next < projects.length) {
        const project = projects[next++]
        project.running = Boolean(project.url) && (await servesProject(project.url, project.id))
        if (!project.running) project.url = null
      }
    }),
  )
  return projects
}
