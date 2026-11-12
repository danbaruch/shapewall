// `shapewall login --remote URL`: gets a project token through the browser
// instead of copying one. It starts a login on the server, shows a short
// code and opens the console's /device page; someone with the admin role
// types the code there, picks the project and approves (with a passkey
// check). The server makes a token named after this machine and hands it
// over once; it goes into the credentials file (0600, see credentials.js)
// and is never printed. `push`, `comments`, `watch` and `mcp --remote` use
// it from then on.

import os from 'node:os'
import { spawn } from 'node:child_process'
import { credentialsFile, saveCredential } from './credentials.js'
import { readBounded, remoteOrigin } from './remote.js'
import { safeOut, terminalSafe } from './terminal.js'

// No shell anywhere: on Windows `cmd /c start` would run `&`, `|` or `^` in
// the URL as commands, so the URL goes to the URL handler directly.
const OPENERS = { darwin: ['open'], win32: ['rundll32', 'url.dll,FileProtocolHandler'] }

// The console's approval page for an origin from remoteOrigin (https, or
// http to this machine). The CLI builds it itself: never a URL the server
// sent, which could point anywhere or carry characters a shell would run.
// Null when the origin is not a plain http(s) origin with an ordinary host.
export function deviceLoginUrl(origin) {
  let url
  try {
    url = new URL(String(origin))
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password || url.origin !== String(origin).replace(/\/+$/, '')) return null
  // Hostnames (letters, digits, dots, dashes; IDNs are punycode by now) and IP literals only.
  if (!/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?|\[[0-9a-f:.]+\])$/i.test(url.hostname)) return null
  return `${url.origin}/device`
}

// The command and arguments that open a URL on a platform (no shell).
export function openerFor(url, platform = process.platform) {
  const [command, ...args] = OPENERS[platform] || ['xdg-open']
  return [command, [...args, url]]
}

// Opens the URL in a browser, quietly; failing is fine (the URL is printed).
function openBrowser(url, env) {
  if (env.SHAPEWALL_NO_BROWSER === '1' || env.CI) return false
  if (process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false
  // Only the page this CLI built (deviceLoginUrl), never anything else.
  if (typeof url !== 'string' || !/^https?:\/\/[A-Za-z0-9.:[\]-]+\/device$/.test(url)) return false
  const [command, args] = openerFor(url)
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

async function post(fetchImpl, origin, pathname, body) {
  const response = await fetchImpl(`${origin}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
  })
  let data = null
  try {
    // A login answer is small: a server cannot stream this process full.
    data = JSON.parse((await readBounded(response, 65536)).toString('utf8'))
  } catch {
    data = null
  }
  return { status: response.status, data }
}

export async function login(
  flags,
  out,
  {
    env = process.env,
    fetchImpl = fetch,
    open = openBrowser,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    signal = null,
    purpose = null,
    // `shapewall agent connect`: what this machine will run ({ kind, name }),
    // shown on the approval page, and what to do with the approved token
    // in place of saving it as this server's login.
    agent = null,
    onApproved = null,
    // The command that was run, for "run it again" (`shapewall agent connect`, `shapewall import`).
    command = 'shapewall login',
  } = {},
) {
  out = safeOut(out)
  const origin = remoteOrigin(flags, env)
  const machine = os.hostname().split('.')[0] || 'this computer'
  const started = await post(fetchImpl, origin, '/api/v1/device/start', {
    name: machine,
    ...(['import', 'agent'].includes(purpose) ? { purpose } : {}),
    ...(purpose === 'agent' && agent ? { agent } : {}),
  })
  if (started.status !== 201 || !started.data?.deviceCode) {
    throw new Error(
      terminalSafe(started.data?.error?.message) || `Could not start a login on ${origin} (${started.status}). Is it a Shapewall server?`,
    )
  }
  const { deviceCode, interval = 3, expiresIn = 600 } = started.data
  const userCode = terminalSafe(started.data.userCode)
  if (!/^[A-Z]{4}-[A-Z]{4}$/.test(userCode)) throw new Error('The server sent no usable login code.')
  // The page is ours to build: the server's verificationUrl is not used.
  const page = deviceLoginUrl(origin)
  if (!page) throw new Error(`Cannot build a login page for ${origin}; open its /device page yourself.`)
  out(`${purpose === 'agent' ? 'To connect this agent' : 'To log in'}, open ${page} and enter this code:`)
  out('')
  out(`    ${userCode}`)
  out('')
  out(`Check that the console shows the same code and "${machine}". It expires in ${Math.round(Number(expiresIn) / 60) || 10} minutes.`)
  if (open(page, env)) out('(Opened it in your browser.)')
  const deadline = Date.now() + Math.min(Math.max(Number(expiresIn) || 600, 1), 3600) * 1000
  for (;;) {
    if (signal?.aborted) throw new Error('Login cancelled.')
    if (Date.now() > deadline) throw new Error(`The code expired before anyone approved it. Run ${command} again for a new one.`)
    // 1 to 30 seconds whatever the server says (NaN would poll in a tight loop).
    await sleep(Math.min(Math.max(Number(interval) || 3, 1), 30) * 1000)
    let polled
    try {
      polled = await post(fetchImpl, origin, '/api/v1/device/poll', { deviceCode })
    } catch {
      continue // the network blinked: try again on the next tick
    }
    if (polled.status === 202) continue
    if (polled.status === 429) {
      await sleep(5000)
      continue
    }
    if (polled.status !== 200 || polled.data?.status !== 'approved') {
      // The server's words name "shapewall login"; an expired code names the command that was run.
      if (polled.status === 410 && polled.data?.error?.code === 'login_expired')
        throw new Error(`The code expired before anyone approved it. Run ${command} again for a new one.`)
      throw new Error(terminalSafe(polled.data?.error?.message) || `The login did not finish (${polled.status}).`)
    }
    const result = polled.data
    if (typeof result.token !== 'string' || !/^swp_[A-Za-z0-9_-]{43}$/.test(result.token)) throw new Error('The server sent no token.')
    if (onApproved) return onApproved(result, { origin, machine })
    const file = saveCredential(
      origin,
      {
        token: result.token,
        tokenName: result.tokenName || null,
        workspace: result.workspace || null,
        project: result.project || null,
        scopes: Array.isArray(result.scopes) ? result.scopes : [],
        expiresAt: result.expiresAt || null,
        savedAt: new Date().toISOString(),
      },
      env,
    )
    out(
      `Logged in to ${result.workspace?.name || 'the workspace'} / ${result.project?.name || 'the project'} as the token "${result.tokenName}" (${(result.scopes || []).join(', ')}).`,
    )
    out(`Saved to ${file} (only you can read it). push, comments, watch and mcp with --remote ${origin} use it.`)
    if (env.SHAPEWALL_TOKEN) out('Note: SHAPEWALL_TOKEN is set in this shell, and it wins over the saved login.')
    return { file }
  }
}

export { credentialsFile }
