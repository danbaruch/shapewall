// Starts the public demo's in-browser backend (backend.js) for the board or
// the console: every fetch of /api/..., api/... or /auth/... on this origin
// is answered here; the export's own files (data/...) load as usual. State
// lives in localStorage (one key, shared by the board and console pages);
// a tab opened from a share link is that link's guest (sessionStorage).
// Reset puts the fixtures back.

import { LayoutDashboard, RotateCcw } from 'lucide-react'
import { leavePage } from '../lib/hooks'
import { demoBoardFolders, demoFiles, notifyDemo, setDemoBridge } from '../lib/demo'
import { notifyAgentsChanged } from '../lib/agentEvents'
import { createDemoBackend } from './backend'
import { consoleTitle } from './titles'
import { GUEST_NAME, STATE_VERSION, VIEW_AS, seedState } from './fixtures'

const STATE_KEY = 'shapewall.demo.state.v1'
// Chat images kept across reloads (data URLs), up to this much in total.
const FILES_KEY = 'shapewall.demo.files.v1'
const FILES_BYTES_MAX = 1_500_000
// This tab's share link ({ shareId }), when the tab was opened from one.
const TAB_KEY = 'shapewall.demo.tab.v1'

function readJson(key) {
  try {
    return JSON.parse(window.localStorage.getItem(key) || 'null')
  } catch {
    return null
  }
}
// False when the browser would not keep it (storage full or blocked):
// changes then last for this page only.
function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function readTab() {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(TAB_KEY) || 'null')
    return typeof value?.shareId === 'string' ? value : null
  } catch {
    return null
  }
}
function writeTab(value) {
  try {
    if (value) window.sessionStorage.setItem(TAB_KEY, JSON.stringify(value))
    else window.sessionStorage.removeItem(TAB_KEY)
  } catch {
    /* blocked: the guest lasts for this page only */
  }
}

const base = () => window.location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '')

export async function installDemo(app) {
  const realFetch = window.fetch.bind(window)
  const loadJson = async (url) => {
    const response = await realFetch(new URL(url, base()).href, { cache: 'no-store' })
    if (!response.ok) throw new Error(`demo data ${url}: ${response.status}`)
    return response.json()
  }
  // The export's fixed moment: the backend moves the export's times onto the
  // state's clock (backend.js rebase), so the board needs no fixture clock.
  const info = await loadJson('data/info.json').catch(() => ({}))

  const saved = readJson(STATE_KEY)
  const state = saved?.version === STATE_VERSION ? saved : seedState(Date.now(), { fixturesAt: info.fixturesAt || null })
  const params = new URLSearchParams(window.location.search)

  // A share link opens the board as its guest in this tab only: the tab
  // keeps the link in sessionStorage (so it stays the guest across reloads)
  // while other tabs stay whoever they were. The shared state keeps the
  // other tabs' View as; the link leaves the address bar, as on a server.
  let tab = app === 'board' ? readTab() : null
  if (app === 'board' && params.has('share')) {
    tab = { shareId: params.get('share') || '' }
    writeTab(tab)
    params.delete('share')
    const query = params.toString()
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
  }
  const shared = { viewAs: state.viewAs, guestShareId: state.guestShareId ?? null }
  if (tab) {
    state.viewAs = 'guest'
    state.guestShareId = tab.shareId
  }
  for (const project of state.projects) for (const board of project.boards) demoBoardFolders.set(board.id, board.folder)
  for (const [file, url] of Object.entries(readJson(FILES_KEY) || {})) demoFiles.set(file, url)

  const persist = () => {
    // Someone chose another View as (or signed in) in the guest tab: it is
    // an ordinary tab again.
    if (tab && (state.viewAs !== 'guest' || state.guestShareId !== tab.shareId)) {
      tab = null
      writeTab(null)
    }
    if (!tab) Object.assign(shared, { viewAs: state.viewAs, guestShareId: state.guestShareId ?? null })
    // Said in the console (shell.jsx) while it lasts: the next page would not see these changes.
    bridge.storageFull = !writeJson(STATE_KEY, tab ? { ...state, ...shared } : state)
  }
  // The demo's agents (Agents page, chat picker, Fix with): every open view
  // of this page and the others refetches when they change (lib/agentEvents.js).
  let agentsSeen = JSON.stringify(state.agents ?? null)
  const agentsMoved = () => {
    const now = JSON.stringify(state.agents ?? null)
    if (now === agentsSeen) return
    agentsSeen = now
    notifyAgentsChanged('event')
  }
  const save = () => {
    persist()
    bridge.version += 1
    refreshBridge()
    notifyDemo()
    agentsMoved()
  }
  const bridge = { version: 1, resetAsked: false, storageFull: false }
  const backend = createDemoBackend({
    state,
    loadJson,
    save,
    location: { project: params.get('project'), base: base(), fixturesAt: info.fixturesAt || null },
  })
  if (state !== saved) persist()

  // ---- fetch ----
  window.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : null
    const url = new URL(request ? request.url : String(input), window.location.href)
    const root = new URL(base())
    let path = null
    if (url.origin === window.location.origin) {
      if (url.pathname.startsWith(`${root.pathname}api/`)) path = `/${url.pathname.slice(root.pathname.length)}`
      else if (/^\/(api|auth)\//.test(url.pathname)) path = url.pathname
    }
    if (!path) return realFetch(input, init)
    const method = String(init.method || request?.method || 'GET').toUpperCase()
    let body
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = undefined
      }
    }
    const answer = await backend.handle({ method, path, search: url.search, body, signal: init.signal })
    if (answer.events) {
      for (const attachment of answer.attachments || []) keepFile(attachment)
      return sseResponse(answer.events, init.signal)
    }
    return new Response(JSON.stringify(answer.json), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
  }

  function keepFile(attachment) {
    const url = `data:${attachment.mediaType};base64,${attachment.data}`
    demoFiles.set(attachment.file, url)
    const files = readJson(FILES_KEY) || {}
    const used = Object.values(files).reduce((sum, value) => sum + value.length, 0)
    if (used + url.length <= FILES_BYTES_MAX) writeJson(FILES_KEY, { ...files, [attachment.file]: url })
  }

  // ---- View as, sign-in and Reset, for the profile menu and banner ----
  const roleLabel = (id) => (id === 'self' ? 'You' : VIEW_AS.find((item) => item.id === id)?.label || id)
  const bump = () => {
    bridge.version += 1
    notifyDemo()
  }
  function refreshBridge() {
    const user = backend.me()
    const options = VIEW_AS.map((option) => {
      const persona = option.id === 'guest' ? null : backend.personaFor(option.id)
      return {
        id: option.id,
        label: option.label,
        hint: option.id === 'guest' ? `${GUEST_NAME}, share link` : persona ? persona.displayName : 'nobody',
      }
    })
    if (state.selfUserId) options.push({ id: 'self', label: 'You', hint: 'your new account' })
    const go = (role) => {
      backend.setViewAs(role)
      // The page reloads its data as the new person (and the console its route).
      leavePage(() => window.location.reload())
    }
    Object.assign(bridge, {
      role: state.viewAs,
      roleLabel: roleLabel(state.viewAs),
      personaName: state.viewAs === 'guest' ? `${state.guestName || GUEST_NAME}, through a share link` : user?.displayName || 'signed out',
      signedOut: Boolean(state.signedOut),
      viewAs: { value: state.viewAs, options, onChange: go },
      // This tab's share link when it does not open (DemoShareProblem):
      // { status: 'unknown' | 'revoked' | 'expired' | 'off', at }.
      shareProblem: tab && backend.shareStatus(tab.shareId).status !== 'ok' ? backend.shareStatus(tab.shareId) : null,
      leaveShare: () => {
        writeTab(null)
        leavePage(new URL('index.html', base()).href)
      },
      // Reset asks first (DemoResetDialog); resetNow does it.
      reset: () => {
        bridge.resetAsked = true
        bump()
      },
      cancelReset: () => {
        bridge.resetAsked = false
        bump()
      },
      resetNow: () => {
        try {
          window.localStorage.removeItem(STATE_KEY)
          window.localStorage.removeItem(FILES_KEY)
        } catch {
          /* storage blocked: nothing was kept, the reload starts over anyway */
        }
        writeTab(null)
        // Back to the start: the board, as the owner.
        leavePage(new URL(app === 'board' ? 'index.html' : 'console.html', base()).href)
      },
      resetItem: { id: 'reset', label: 'Reset the demo', icon: RotateCcw, onSelect: () => bridge.reset(), 'data-sw-demo-reset-item': true },
      consoleItems: () => [
        {
          id: 'board',
          label: 'Open the board',
          icon: LayoutDashboard,
          onSelect: () => leavePage(new URL('index.html', base()).href),
        },
      ],
      signIn: async (role) => {
        await backend.handle({ method: 'POST', path: '/auth/demo/signin', body: { role } })
      },
      signUp: async () => {
        await backend.handle({ method: 'POST', path: '/auth/demo/signup', body: {} })
      },
    })
  }
  refreshBridge()
  setDemoBridge(bridge)

  // Another tab changed the demo (a guest commented, a link was revoked, the
  // demo was reset): take its state, so this tab neither shows stale answers
  // nor writes its old copy back over the change on its next save.
  window.addEventListener('storage', (event) => {
    if (event.key !== STATE_KEY && event.key !== null) return
    const next = readJson(STATE_KEY)
    const who = (value) => [value?.viewAs, value?.signedOut ? 1 : 0, value?.selfUserId || ''].join('|')
    // Reset there, or a different person here now: start this page over as them.
    if (next?.version !== STATE_VERSION || (!tab && who(next) !== who(state))) {
      window.location.reload()
      return
    }
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, next)
    Object.assign(shared, { viewAs: next.viewAs, guestShareId: next.guestShareId ?? null })
    if (tab) {
      state.viewAs = 'guest'
      state.guestShareId = tab.shareId
    }
    bridge.version += 1
    refreshBridge()
    notifyDemo()
    agentsMoved()
  })
  if (app === 'console') keepConsoleTitle(state)
}

// The console sets its title after each route change, so this follows the
// <title> element rather than the route.
function keepConsoleTitle(state) {
  const apply = () => {
    const next = consoleTitle(window.location.hash, state)
    if (document.title !== next) document.title = next
  }
  apply()
  new MutationObserver(apply).observe(document.head, { childList: true, subtree: true, characterData: true })
  window.addEventListener('hashchange', apply)
}

// A chat answer as a server-sent event stream.
function sseResponse(events, signal) {
  const encoder = new TextEncoder()
  const iterator = events[Symbol.asyncIterator]()
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next()
        if (done) {
          controller.close()
          return
        }
        const [name, data] = value
        controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`))
      } catch (error) {
        controller.error(error)
      }
    },
    cancel() {
      iterator.return?.()
    },
  })
  signal?.addEventListener('abort', () => iterator.return?.(), { once: true })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
}
