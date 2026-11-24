// Starts the public demo's in-browser backend (backend.js) for the board or
// the console: every fetch of /api/..., api/... or /auth/... on this origin
// is answered here; the export's own files (data/...) load as usual. State
// lives in localStorage (one key, shared by the board and console pages);
// a tab opened from a share link is that link's guest (sessionStorage).
// Reset puts the fixtures back.

import { LayoutDashboard, RotateCcw } from 'lucide-react'
import { leavePage } from '../lib/hooks'
import { demoBoardFolders, demoFiles, notifyDemo, setDemoBridge } from '../lib/demo'
import { notifyAgentsChanged, notifyBatchChanged } from '../lib/agentEvents'
import { createDemoBackend } from './backend'
import { consoleTitle } from './titles'
import { GUEST_NAME, STATE_VERSION, VIEW_AS, seedState } from './fixtures'
import { setDemoWorld } from './world.js'
import { NEEDS, roleAtLeast } from '../../../src/shared/permissions.js'
import { PAGE_COMMENT_KEY, TIP_KEY } from '../board/prefs'
import { TRY_THIS_KEY } from '../board/TryThis'

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

// Set by Reset for the page it loads next (this tab only): that page starts
// from the fixtures even if another tab wrote its old copy back in between.
const RESET_KEY = 'shapewall.demo.reset.v1'
const RESET_FRESH_MS = 30000
function takeResetMark() {
  try {
    const at = Number(window.sessionStorage.getItem(RESET_KEY))
    window.sessionStorage.removeItem(RESET_KEY)
    return Number.isFinite(at) && at > 0 && Date.now() - at < RESET_FRESH_MS
  } catch {
    return false
  }
}
function markReset() {
  try {
    window.sessionStorage.setItem(RESET_KEY, String(Date.now()))
  } catch {
    /* storage blocked: nothing is kept anyway */
  }
}

// What else this browser remembers about the demo's visit, which Reset
// clears so "back to the start" is true: the "Try this" card and the board's
// tip closed, the page bar's Comment hint seen, which threads were read
// (lib/unread.js) and the chat last open on each board (chat/threads.js).
const VISIT_KEYS = [TRY_THIS_KEY, TIP_KEY, PAGE_COMMENT_KEY]
const VISIT_PREFIXES = ['shapewall.seen:']
const TAB_PREFIXES = ['shapewall.lastChat.']

function clearByPrefix(storage, prefixes) {
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index)
    if (key && prefixes.some((prefix) => key.startsWith(prefix))) storage.removeItem(key)
  }
}

// This tab's traces of the visit (sessionStorage), and with `all` the
// browser's too (localStorage, shared by every tab).
export function clearDemoVisit({ all = true } = {}) {
  try {
    clearByPrefix(window.sessionStorage, TAB_PREFIXES)
  } catch {
    /* storage blocked: nothing was kept */
  }
  if (!all) return
  try {
    for (const key of VISIT_KEYS) window.localStorage.removeItem(key)
    clearByPrefix(window.localStorage, VISIT_PREFIXES)
  } catch {
    /* storage blocked: nothing was kept */
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

  // Which fictional product the export is about; a state saved in this
  // browser for another one (an older demo) is seeded again.
  const world = setDemoWorld(info.demoApp).id
  const justReset = takeResetMark()
  const saved = justReset ? null : readJson(STATE_KEY)
  const reuse = saved?.version === STATE_VERSION && (saved.world || 'lumen') === world
  const state = reuse ? saved : seedState(Date.now(), { fixturesAt: info.fixturesAt || null })
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
  for (const [file, url] of Object.entries((justReset ? null : readJson(FILES_KEY)) || {})) demoFiles.set(file, url)

  // Set once this page is on its way out after a Reset (here or in another
  // tab) or another tab's change of person: from then on nothing is written,
  // or a late save (a batch step, a streaming chat turn, a poll, a delete
  // flushed on pagehide) would put the old demo back.
  let leaving = false
  const persist = () => {
    if (leaving) return
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
  // How fixes run (state.agentWork: branch mode, batch fixes) counts too.
  const agentsNow = () => JSON.stringify([state.agents ?? null, state.agentWork ?? null])
  let agentsSeen = agentsNow()
  const agentsMoved = () => {
    const now = agentsNow()
    if (now === agentsSeen) return
    agentsSeen = now
    notifyAgentsChanged('event')
  }
  const save = () => {
    if (leaving) return
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
    onBatch: (boardId) => notifyBatchChanged(boardId),
    // The fictional usage history keeps this visitor's days and working hours.
    zoneOffset: -new Date().getTimezoneOffset(),
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
    // Images on a new comment or reply, kept like chat attachments.
    for (const attachment of answer.attachments || []) keepFile(attachment)
    if (answer.forget?.length) forgetFiles(answer.forget)
    // An export, made in this browser: a download, named as a server names it.
    if (answer.file)
      return new Response(answer.file.text, {
        status: 200,
        headers: { 'Content-Type': answer.file.type, 'Content-Disposition': `attachment; filename="${answer.file.name}"` },
      })
    return new Response(JSON.stringify(answer.json), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
  }

  function keepFile(attachment) {
    if (leaving) return
    const url = `data:${attachment.mediaType};base64,${attachment.data}`
    demoFiles.set(attachment.file, url)
    const files = readJson(FILES_KEY) || {}
    const used = Object.values(files).reduce((sum, value) => sum + value.length, 0)
    if (used + url.length <= FILES_BYTES_MAX) writeJson(FILES_KEY, { ...files, [attachment.file]: url })
  }

  function forgetFiles(list) {
    if (leaving) return
    const files = readJson(FILES_KEY) || {}
    for (const file of list) {
      demoFiles.delete(file)
      delete files[file]
    }
    writeJson(FILES_KEY, files)
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
      // The console's Usage page of the main workspace, for whoever may read
      // it (members and up): the board's "Try this" card leads there.
      usageHref:
        user &&
        roleAtLeast(
          state.memberships.find((item) => item.userId === user.id && item.workspaceId === state.workspaces[0]?.id)?.role,
          NEEDS.usage,
        )
          ? new URL(`console.html#/w/${state.workspaces[0].id}/usage`, base()).href
          : null,
      signedOut: Boolean(state.signedOut),
      viewAs: { value: state.viewAs, options, onChange: go },
      // This tab's share link when it does not open (DemoShareProblem):
      // { status: 'unknown' | 'revoked' | 'expired' | 'off', at }.
      shareProblem: tab && backend.shareStatus(tab.shareId).status !== 'ok' ? backend.shareStatus(tab.shareId) : null,
      leaveShare: () => {
        writeTab(null)
        leavePage(base())
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
        // First, so nothing this page still does writes the old state back.
        leaving = true
        try {
          window.localStorage.removeItem(STATE_KEY)
          window.localStorage.removeItem(FILES_KEY)
        } catch {
          /* storage blocked: nothing was kept, the reload starts over anyway */
        }
        // "Try this" and the tips come back, nothing reads as unread or read.
        clearDemoVisit()
        writeTab(null)
        markReset()
        // Back to the start: the board, as the owner, at the demo's clean address (/demo/, not index.html).
        leavePage(app === 'board' ? base() : new URL('console.html', base()).href)
      },
      resetItem: { id: 'reset', label: 'Reset the demo', icon: RotateCcw, onSelect: () => bridge.reset(), 'data-sw-demo-reset-item': true },
      consoleItems: () => [
        {
          id: 'board',
          label: 'Open the board',
          icon: LayoutDashboard,
          onSelect: () => leavePage(base()),
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
    if (leaving) return
    if (event.key !== STATE_KEY && event.key !== null) return
    const next = readJson(STATE_KEY)
    const who = (value) => [value?.viewAs, value?.signedOut ? 1 : 0, value?.selfUserId || ''].join('|')
    // Reset there, or a different person here now: start this page over as them.
    if (next?.version !== STATE_VERSION || (!tab && who(next) !== who(state))) {
      // Nothing more from this page: its old copy must not land over theirs.
      leaving = true
      // Reset there: this tab's own traces (its last chats) go too.
      if (next?.version !== STATE_VERSION) clearDemoVisit({ all: false })
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
