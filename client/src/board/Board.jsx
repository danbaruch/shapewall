import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Background, ReactFlow, useNodesInitialized, useNodesState, useReactFlow } from '@xyflow/react'
import { api, BROWSER_COMMENTS, fileUrl, STATIC } from '../lib/api'
import { resetBrowserComments } from '../lib/browserComments'
import { leavePage, useMediaQuery, useOverlayEntry, useParams, useResource } from '../lib/hooks'
import { cn, savedAuthor } from '../lib/utils'
import { Spinner } from '../components/ui'
import { BoardContext, NODE_TYPES } from './nodes'
import { EDGE_TYPES } from './edges'
import { layoutBoard, nativeSize, pinPoint } from './layout'
import { revealPlan } from './commentReveal'
import { cardKeyDown, isEditable, useCanvasNavigation } from './navigation'
import { COMMENT_STATES, beforeAfter, entryVersion, historyCount, pageChange } from './flow'
import { FILTERS } from './CommentsPanel'
import { JourneyBar, JourneyBuilder } from './JourneyBar'
import CompareBar from './CompareBar'
import { BoardPeople } from './Mentions'
import { CommentComposer } from './CommentComposer'
import { ThreadView } from './Thread'
import { ComposerPopover, ThreadPopover } from './ThreadPopover'
import { isUnread, useSeen } from '../lib/unread'
import { canDeleteComment, canEditComment } from '../../../src/hosted/permissions.js'
import { boardPeople } from '../../../src/mentions.js'
import { newChatId, threadForComment } from '../chat/threads'
import { useAgentFocus } from '../chat/agentFocus'
import { AppUpdates } from '../components/app-updates'
import { BoardLoadError } from '../components/app-states'
import { DemoBanner } from '../components/demo-banner'
import { HostedApprovals } from './HostedApprovals'
import { AccessLostBanner } from './HostedNotes'
import { DEMO, useDemo } from '../lib/demo'
import { PresenceLayer } from './presence/Presence'
import { useResolvedMode } from '../lib/theme'
const MigrationBanner = lazy(() => import('../share/ShareDialog').then((module) => ({ default: module.MigrationBanner })))
import { TryThis, useTryThis } from './TryThis'

import { FIT_OPTIONS, MAX_ZOOM, MIN_ZOOM, clusterBounds, flyToPage, parseCamera, startViewport } from './camera'
import { useSettledZoom } from './hooks/useSettledZoom'
import { minimapDefault, minimapSaved, rememberMinimap, rememberPageCommentSeen, rememberTipDismissed, tipDismissed } from './prefs'
import { CommandPalette } from './PageFinder'
import { useSidebarExpanded } from '../components/app-rail'
import { BrokenLinks } from './BrokenLinks'
import { BoardToolbar } from './BoardToolbar'
import { BoardMenu } from './BoardMenu'
import { CanvasNotes } from './CanvasNotes'
import { DrawingBar, DrawingMode, useDrawingMode } from './DrawingMode'
import { BoardTools, ToolDock, ToolNote, useCanvasWidth, useKeyboardUp } from './BoardTools'
import { DOCK, NOTE_ROOM, placeTools, toolsWidth } from './toolDock'
import { activeTool as toolInUse, hasDivider, toolForKey, toolList } from './tools'
import { isIgnoredTypeahead } from '../components/ui'
import { drawing } from './drawing'
import { nudgeComposer } from './composerNudge'
import { BoardToast, NoticeBar, useToast } from './Toast'
import { PhoneSheets, SidePanel } from './BoardPanels'
import { BoardRail } from './BoardRail'
import { BoardDialogs } from './BoardDialogs'
import { useLiveFrames } from './hooks/useLiveFrames'
import { useCommentModeKeys, useJourneyCycleKey } from './hooks/useShortcuts'
import { useJourneyActions } from './hooks/useJourneyActions'
import { useCommentActions } from './hooks/useCommentActions'
import { useBoardData } from './hooks/useBoardData'
import { useJourneyState } from './hooks/useJourneyState'
import { LANDED_MS, useFlyToPending, usePhoneStartView, useRefitOnChange } from './hooks/useCameraMoves'
import { useCommentLink } from './hooks/useCommentLink'
import { useThreadNav } from './hooks/useThreadNav'
import { useChecks } from './hooks/useChecks'
import { useAgentParams } from './hooks/useAgentParams'
import { useCompare } from './hooks/useCompare'
import { useCommentLists } from './hooks/useCommentLists'
import { useArrows } from './hooks/useArrows'
import { useBoardContext } from './hooks/useBoardContext'
import { useCapture } from './hooks/useCapture'
import { useCommentDraft } from './hooks/useCommentDraft'
import { boardPaletteActions } from './paletteActions'
import { agentActivity } from './agentActivity'
import { rememberHostedAgents } from '../lib/agentIdentity'
import { BoardViewContext } from './boardView'
import { splitFrameKey, viewportLabel } from './viewports'
import { CanvasControls } from './CanvasControls'
import { FocusedFrameBar } from './FrameBar'
import { BatchConfirm, useBatchFixes } from './BatchFixes'
import { motionDuration } from '../lib/motion'

const noop = () => {}
const NO_IDS = new Set()

function byId(list, key) {
  const map = new Map()
  for (const item of list || []) if (!map.has(key(item))) map.set(key(item), item)
  return map
}

export default function Board({ boardId, boards, info, onPickBoard, onInfoChanged, onOpenBuzz }) {
  const wide = useMediaQuery('(min-width: 1024px)')
  // Phone-width screens open on the phone captures (when the board has them).
  const phoneWidth = useMediaQuery('(max-width: 640px)')
  const flow = useReactFlow()
  const demo = useDemo()
  // The canvas, minimap and controls follow the picked mode, not only the OS.
  const colorMode = useResolvedMode()
  const [params, updateParams] = useParams()
  // One param as it is right now, for a callback that must not be rebuilt on
  // every param change (focusComment, which remembers what to go back to).
  const paramsRef = useRef(params)
  paramsRef.current = params
  const was = useCallback((key) => paramsRef.current.get(key), [])
  // A static export is read-only, unless it keeps comments in the browser.
  const [shareOpen, setShareOpen] = useState(false)
  const canAct = !info?.readOnly && (!STATIC || BROWSER_COMMENTS)
  const canEditJourneys = canAct && !STATIC && !info?.hosted
  const canCapture = canAct && info?.allowCapture
  // Hosted servers say what this person may do (a share link guest comments
  // and replies but never resolves, edits or deletes); missing means allowed.
  const allowed = (key) => info?.permissions?.[key] !== false

  const { view, commentsQuery, data, capture, comments, fixRequest, setFixRequest, setPolling, deletingIds, setDeletingIds } =
    useBoardData(boardId)
  const projectQuery = useResource(info?.localProjectsEnabled ? '/api/local-projects' : null, { pollMs: 30000 })
  const localProjects = projectQuery.data?.projects || []
  const viewports = useMemo(() => data?.viewports || {}, [data?.viewports])
  const viewportNames = Object.keys(viewports)

  const modes = useMemo(() => {
    const list = viewportNames.map((name) => ({ id: name, label: viewportLabel(name) }))
    if (list.length > 1) list.push({ id: 'all', label: list.length === 2 ? 'Both' : 'All' })
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportNames.join(',')])
  const defaultMode = phoneWidth && viewportNames.includes('phone') ? 'phone' : viewportNames[0] || 'desktop'
  const mode = modes.some((item) => item.id === params.get('vp')) ? params.get('vp') : defaultMode
  const filter = FILTERS.some((item) => item.id === params.get('filter')) ? params.get('filter') : 'open'
  const selectedCommentId = Number(params.get('c')) || null
  const query = (params.get('q') || '').slice(0, 120)
  const stateFilter = COMMENT_STATES.some((item) => item.id === params.get('st')) ? params.get('st') : null
  const mentionFilter = /^[a-z][\w.-]{0,39}$/.test(params.get('m') || '') ? params.get('m') : null
  const panelHidden = params.get('panel') === 'off'
  const {
    canChecks,
    checksOpen,
    checksPage,
    checksViewport,
    checksQuery,
    openChecks,
    closeChecks,
    checksCounts,
    checksPanelProps,
    checksRun,
  } = useChecks({ boardId, info, params, updateParams, pages: data?.board?.pages })
  const [checkDraft, setCheckDraft] = useState('')
  const {
    chatAvailable,
    chatThread,
    settingsAvailable,
    localSettingsAvailable,
    generalSettingsOpen,
    settingsOpen,
    openSettings,
    openChat,
    reopenChat,
  } = useAgentParams({ boardId, info, params, updateParams })
  const updates = useRef(null)
  const initialCamera = useRef(parseCamera(params.get('v')))
  const canvasRef = useRef(null)

  const [commentMode, setCommentMode] = useState(false)
  // The Draw tool, before a page is picked: comment mode whose next click
  // starts a comment on that page and goes straight to drawing on it.
  const [drawArmed, setDrawArmed] = useState(false)
  useEffect(() => {
    if (!commentMode) setDrawArmed(false)
  }, [commentMode])
  // "Comment" on a page's bar (FrameBar.jsx): comment mode with that page as
  // its target ({ key, keyboard }). The note names the page and the page
  // takes Enter; a click anywhere else is comment mode's as ever.
  const [commentTarget, setCommentTarget] = useState(null)
  const [draft, setDraft] = useState(null)
  // Whether the comment being written has anything in it yet: text, an image
  // or a drawing. Read when a click or a key needs to know (never rendered).
  const draftRef = useRef(null)
  draftRef.current = draft
  const draftImages = useRef(0)
  const draftFilled = useCallback(() => {
    const drawn = drawing.get()
    return (
      Boolean(draftRef.current) &&
      (Boolean(draftRef.current.body.trim()) || draftImages.current > 0 || (drawn?.owner === 'composer' && drawn.shapes.length > 0))
    )
  }, [])
  // The rule for everything that would open another thread or start another
  // comment (a click on the page, a pin, a row in the list, a link to a
  // comment, the palette, C): a comment with something in it is never
  // replaced. True when it was kept; the composer nudges to say so.
  const reopenParked = useRef(null)
  const keepDraft = useCallback(() => {
    if (!draftFilled()) return false
    // Put aside by a navigation (see leaveForNavigation): it comes back.
    if (reopenParked.current?.()) return true
    nudgeComposer()
    return true
  }, [draftFilled])
  // Esc on a comment that holds a drawing or images asks first (text alone
  // goes at once, as before; Cancel is explicit and never asks).
  const [discardAsk, setDiscardAsk] = useState(false)
  useEffect(() => {
    if (!draft) setDiscardAsk(false)
  }, [draft])
  const draftHasMedia = useCallback(() => {
    const drawn = drawing.get()
    return Boolean(draftRef.current) && (draftImages.current > 0 || (drawn?.owner === 'composer' && drawn.shapes.length > 0))
  }, [])
  const [sheetOpen, setSheetOpen] = useState(false)
  // Phone: the open thread as a bottom sheet.
  const [threadSheet, setThreadSheet] = useState(false)
  // The name a local board signs comments with (saved in this browser).
  // The name typed on a comment in this browser, else the server's guess for
  // this machine (git user.name or the account's full name), so the avatar
  // and new comments have a name from the start.
  const defaultName = info?.localUser?.name || ''
  const [typedName, setLocalName] = useState(() => savedAuthor())
  const localName = typedName || defaultName
  const authorName = useCallback(() => savedAuthor() || defaultName, [defaultName])
  // Set by the open thread while its text is being edited (Escape cancels that first).
  const editingRef = useRef(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [notice, setNotice] = useState(null)
  // A short-lived note with Undo (resolve, delete), over the canvas.
  const [toast, setToast, holdToast] = useToast()
  // The minimap: as chosen in this browser, else on for big boards only.
  const [minimapChoice, setMinimapChoice] = useState(() => minimapSaved())
  const minimapOn = minimapChoice ?? minimapDefault(data?.board?.pages?.length || 0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // The comment an agent is working on right now (chat/agentFocus.js): its
  // pin and card ring. One per board; waiting on a permission still counts.
  const focusEntry = useAgentFocus(boardId)
  // Hosted boards: shell commands waiting for an admin's OK (HostedApprovals).
  const [approvalRows, setApprovalRows] = useState([])
  const focusedCommentId = focusEntry && ['working', 'waiting'].includes(focusEntry.state) ? Number(focusEntry.commentId) || null : null
  const agentFocus = useMemo(() => (focusedCommentId ? new Set([focusedCommentId]) : NO_IDS), [focusedCommentId])
  const [busy, setBusy] = useState(false)
  const [pendingFocus, setPendingFocus] = useState(null)
  const [hoverPage, setHoverPage] = useState(null)
  const [builder, setBuilder] = useState(null)
  // Opening a comment the current view hides moves the view out of the way --
  // another viewport, compare mode, "Changed pages only" -- and says so, with
  // one way back (commentReveal.js, CanvasNotes.jsx).
  const [viewNotice, setViewNotice] = useState(null)
  const [tipOpen, setTipOpen] = useState(() => !tipDismissed())
  // The demo's "Try this" card, and which of its steps were done.
  const [tryOpen, closeTryCard] = useTryThis(Boolean(demo))
  const [tryDone, setTryDone] = useState(() => new Set())
  const markTried = useCallback((id) => setTryDone((current) => (current.has(id) ? current : new Set(current).add(id))), [])
  const dismissTip = useCallback(() => {
    setTipOpen(false)
    rememberTipDismissed()
  }, [])
  // One onboarding surface: closing the demo's checklist closes the tip too.
  const closeTry = () => {
    closeTryCard()
    dismissTip()
  }
  const historyPageId = params.get('hist')
  const historyViewportParam = params.get('hv')

  // ---- Journeys, links, compare: URL state ----------------------------------
  const { journeys, journey, route, routeGraph, routePages, step, journeyComments } = useJourneyState({ params, data, builder })
  const showLinks = params.get('links') === '1'
  // The broken links list over the canvas, also opened from the Views menu.
  const [brokenOpen, setBrokenOpen] = useState(false)
  useEffect(() => {
    if (!showLinks) setBrokenOpen(false)
  }, [showLinks])
  const brokenLinks = Array.isArray(data?.brokenLinks) ? data.brokenLinks : []
  const linksTip = brokenLinks.length
    ? `Arrows for the links between pages; ${brokenLinks.length} ${brokenLinks.length === 1 ? 'link leads' : 'links lead'} to an error`
    : 'Arrows for the links between pages'
  const {
    environments,
    comparePair,
    changedOnly,
    showDiff,
    compareQuery,
    compareData,
    compareView,
    setCompare,
    canCompare,
    toggleCompare,
    setChangedOnly,
  } = useCompare({
    boardId,
    params,
    updateParams,
    environmentList: data?.environments,
    setCommentMode,
    pageCount: data?.board?.pages?.length || 0,
  })

  const layoutPages = useMemo(() => {
    const pages = data?.board?.pages || []
    if (!changedOnly || !compareData) return pages
    return pages.filter((page) => (pageChange(compareData, page.id) || 0) > 0)
  }, [changedOnly, compareData, data?.board?.pages])

  const layout = useMemo(
    () =>
      data?.board && viewportNames.length
        ? layoutBoard({
            pages: layoutPages,
            groups: data.board.groups,
            variants: comparePair ? [] : data.variants,
            viewports,
            mode,
            compare: comparePair,
          })
        : { nodes: [], edges: [], targets: {} },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data?.board, data?.variants, layoutPages, viewports, mode, comparePair],
  )
  const [nodes, setNodes, onNodesChange] = useNodesState(layout.nodes)
  useEffect(() => {
    setNodes(layout.nodes)
  }, [layout.nodes, setNodes])
  const nodesReady = useNodesInitialized()
  const [settledZoom, setSettledZoom] = useSettledZoom(nodesReady)
  // The selected card (its frame bar) and "select text" belong to one view:
  // switching viewport, compare, a journey or fitting the board clears them.
  const [focusedKey, setFocusedKey] = useState(null)
  const [selectingKey, setSelectingKey] = useState(null)
  const clearFocus = useCallback(() => {
    setFocusedKey(null)
    setSelectingKey(null)
  }, [])
  const fitBoard = useCallback(() => {
    clearFocus()
    setSettledZoom(null)
    flow.fitView({ ...FIT_OPTIONS, duration: motionDuration(400) })
  }, [clearFocus, flow, setSettledZoom])

  // Entering or leaving compare mode, or filtering to changed pages, reshapes
  // the board: refit.
  const shapeKey = `${comparePair?.join('_') || ''}|${changedOnly && compareData ? layoutPages.length : 'all'}`
  useRefitOnChange({ mode, pendingFocus, shapeKey, clearFocus, fitBoard })

  // Search, state and mention narrow the list (and the pins); the
  // Open/Resolved counts are of what is left.
  // Pages and variants by id (the first wins, as a find would), for the
  // title and live-file lookups below.
  const pagesById = useMemo(() => byId(data?.board?.pages, (page) => page.id), [data?.board?.pages])
  const variantsById = useMemo(() => byId(data?.variants, (item) => `variant:${item.id}`), [data?.variants])
  const titleOfPage = useCallback(
    (pageId) => {
      if (String(pageId).startsWith('variant:')) return variantsById.get(pageId)?.title || ''
      return pagesById.get(pageId)?.title || ''
    },
    [pagesById, variantsById],
  )
  const { visibleComments, pinsByTarget, counts } = useCommentLists({
    comments,
    query,
    stateFilter,
    mentionFilter,
    titleOfPage,
    filter,
    journey,
    journeyComments,
  })
  const people = useMemo(() => boardPeople(comments), [comments])
  // Who is looking: the account on hosted boards, the saved name on local ones.
  const me = useMemo(
    () => ({ name: info?.user?.name || localName || '', handle: info?.user?.handle || null }),
    [info?.user?.name, info?.user?.handle, localName],
  )
  const canComment = canAct && !data?.migratedTo?.readOnly && allowed('comment')
  // What this person may do with one comment. Hosted boards: only the author
  // edits; the author or an admin deletes (src/hosted/permissions.js).
  const threadCan = (comment) => {
    const isAuthor = Boolean(me.handle) && comment.authorHandle === me.handle
    return {
      reply: canAct && !data?.migratedTo?.readOnly && allowed('reply'),
      resolve: canAct && !data?.migratedTo?.readOnly && allowed('resolve'),
      react: canAct && !data?.migratedTo?.readOnly && allowed('react'),
      edit: canAct && !data?.migratedTo?.readOnly && allowed('edit') && (!info?.hosted || canEditComment({ isAuthor })),
      delete:
        canAct && !data?.migratedTo?.readOnly && allowed('delete') && (!info?.hosted || canDeleteComment({ role: info.role, isAuthor })),
    }
  }
  const { seen, markSeen, markAllSeen } = useSeen(boardId)
  const unread = useMemo(
    () => new Set(comments.filter((comment) => isUnread(comment, seen, me)).map((comment) => comment.id)),
    [comments, me, seen],
  )
  const selectedComment = comments.find((comment) => comment.id === selectedCommentId) || null
  // Desktop: a drawing tool is on (DrawingMode.jsx).
  const drawingOn = useDrawingMode(wide)
  // Cards with a comment an agent is working on.
  const agentWorkingPages = useMemo(() => {
    const pages = new Set()
    for (const comment of comments) {
      if (comment.status !== 'resolved' && (comment.agentStatus === 'working' || agentFocus.has(comment.id))) pages.add(comment.pageId)
    }
    return pages
  }, [agentFocus, comments])

  const findPage = useCallback((pageId) => pagesById.get(pageId) || null, [pagesById])
  const targetTitle = useCallback(
    (pageId) => {
      if (pageId.startsWith('variant:')) {
        const variant = variantsById.get(pageId)
        return variant ? `Variant: ${variant.title}` : 'Removed variant'
      }
      return findPage(pageId)?.title || pageId
    },
    [variantsById, findPage],
  )

  const imageVersion = data?.manifest?.capturedAt || 'none'
  // An image that is gone (recaptured, pruned, or a redeployed export since
  // this tab loaded) refetches the board once per board state, so the next
  // render asks for the files that exist now.
  const refetchedFor = useRef(null)
  const { refetch: refetchView } = view
  const { refetch: refetchComments } = commentsQuery
  const { refetch: refetchCompare } = compareQuery
  const onImageError = useCallback(() => {
    const key = `${imageVersion}|${data?.environments?.map((env) => env.capturedAt).join(',') || ''}`
    if (refetchedFor.current === key) return
    refetchedFor.current = key
    refetchView()
    refetchComments()
    refetchCompare()
  }, [data?.environments, imageVersion, refetchComments, refetchCompare, refetchView])
  // A pin opens its thread: at the pin on desktop, as a sheet on a phone.
  // A thread picked from the phone list returns to the list when it closes.
  const threadFromList = useRef(false)
  const selectComment = useCallback(
    (comment) => {
      if (keepDraft()) return
      threadFromList.current = false
      setDraft(null)
      updateParams({ c: comment.id })
      if (!wide) {
        setSheetOpen(false)
        setThreadSheet(true)
      }
    },
    [keepDraft, updateParams, wide],
  )
  const closeThread = useCallback(() => {
    setThreadSheet(false)
    updateParams({ c: null })
    if (threadFromList.current && !wide) setSheetOpen(true)
    threadFromList.current = false
  }, [updateParams, wide])

  // When an open comment closes on its own. A thread, and the new-comment
  // composer, belong to the spot they point at:
  //   they STAY while you look around it: pan, zoom, scroll the comments
  //   list, open, close or resize the side panel, switch between Comments,
  //   Agent and Checks, toggle comment mode;
  //   they CLOSE when you deliberately go somewhere else or change what the
  //   canvas shows: opening or stepping a journey (or building one), going
  //   to a page from the sidebar, the search or a chat link, switching to a
  //   screen size the comment is not on, entering compare, opening a page's
  //   history from its card. "Go to this comment" is not leaving: it opens
  //   that comment instead (focusComment).
  // The thread's `c` leaves the address too, so a reload does not bring it
  // back. An unsent reply is kept with its thread (replyDrafts.js), so
  // closing is safe. A new comment with something in it is never dropped:
  // it is put aside (`draftParked`) and a note on the canvas offers it back.
  const [draftParked, setDraftParked] = useState(false)
  useEffect(() => {
    if (!draft) setDraftParked(false)
  }, [draft])
  const openThreadId = useRef(null)
  openThreadId.current = selectedCommentId
  const leaveForNavigation = useCallback(() => {
    if (openThreadId.current) {
      threadFromList.current = false
      setThreadSheet(false)
      updateParams({ c: null })
    }
    // Desktop only: on a phone the composer is a sheet over everything.
    if (wide && draftRef.current) {
      if (draftFilled()) setDraftParked(true)
      else setDraft(null)
    }
  }, [draftFilled, updateParams, wide])
  const reopenDraft = useCallback(() => {
    const kept = draftRef.current
    if (!kept) return
    setDraftParked(false)
    // Back to where it points, on the screen size it was made on.
    if (mode !== 'all' && kept.viewport !== mode && viewports[kept.viewport]) {
      updateParams({ vp: kept.viewport === defaultMode ? null : kept.viewport })
    }
    setPendingFocus({ pageId: kept.pageId, viewport: kept.viewport, x: kept.x, y: kept.y })
  }, [defaultMode, mode, updateParams, viewports])

  // Pan to a comment's pin, moving the view out of the way first when it is
  // hiding the comment: another screen size, compare mode (which lays out no
  // variants), "Changed pages only" (which drops unchanged pages). Every one
  // of those is said out loud (a note with a way back, the viewport toggle
  // flashes), so the board never changes what it shows behind the user's
  // back, and all of it goes through the URL, so a reload lands here too. On
  // a phone the list closes and the comment shows as a card at its pin; Back
  // returns to the list.
  const focusComment = useCallback(
    (comment) => {
      if (keepDraft()) return
      const switching = mode !== 'all' && comment.viewport !== mode && Boolean(viewports[comment.viewport])
      const onVariant = String(comment.pageId).startsWith('variant:')
      const variant = onVariant ? variantsById.get(comment.pageId) : null
      const ownerPageId = onVariant ? variant?.pageId : comment.pageId
      const plan = revealPlan({
        hasTarget: Boolean(layout.targets[comment.pageId]),
        known: Boolean(ownerPageId && pagesById.has(ownerPageId) && (!onVariant || variant)),
        onVariant,
        compare: Boolean(comparePair),
        changedOnly: changedOnly && Boolean(compareData),
        pageChanged: (pageChange(compareData, ownerPageId) || 0) > 0,
      })
      const leaveCompare = Boolean(plan?.leaveCompare)
      const showAllPages = Boolean(plan?.showAllPages)
      setDraft(null)
      setPendingFocus(comment)
      updateParams({
        c: comment.id,
        ...(switching ? { vp: comment.viewport === defaultMode ? null : comment.viewport } : {}),
        // Leaving compare takes its own params with it, as the Compare button does.
        ...(leaveCompare ? { cmp: null, changed: null, diff: null } : showAllPages ? { changed: '0' } : {}),
      })
      const changes = [...(switching ? ['viewport'] : []), ...(leaveCompare ? ['compare'] : []), ...(showAllPages ? ['changed'] : [])]
      if (changes.length) {
        setViewNotice({
          id: comment.id,
          at: Date.now(),
          changes,
          from: mode,
          to: comment.viewport,
          // One way back: the params exactly as they were before the jump.
          back: {
            ...(switching ? { vp: was('vp') } : {}),
            ...(leaveCompare ? { cmp: was('cmp'), changed: was('changed'), diff: was('diff') } : {}),
            ...(showAllPages && !leaveCompare ? { changed: was('changed') } : {}),
          },
        })
      }
      if (!wide) {
        setSheetOpen(false)
        setThreadSheet(true)
      }
    },
    [
      changedOnly,
      compareData,
      comparePair,
      defaultMode,
      keepDraft,
      layout.targets,
      mode,
      pagesById,
      was,
      updateParams,
      variantsById,
      viewports,
      wide,
    ],
  )
  // The note goes after a moment, as a note does. Back puts the view as it was.
  useEffect(() => {
    if (!viewNotice) return undefined
    const timer = window.setTimeout(() => setViewNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [viewNotice])
  const undoViewNotice = useCallback(() => {
    if (!viewNotice) return
    updateParams(viewNotice.back)
    setViewNotice(null)
  }, [updateParams, viewNotice])
  // A comment whose pin the board cannot show: its page is left out of the
  // current view (a variant while comparing, or a page "Changed pages only"
  // drops). The thread still opens; the board says why it did not move
  // rather than looking broken.
  const onFocusHidden = useCallback(
    (comment) => {
      if (comment?.id == null) return
      setToast({ at: Date.now(), text: `Comment #${comment.id} is on a page this view is not showing, so the board stayed put.` })
    },
    [setToast],
  )
  // The pin the board has just flown to rings for a moment, so a jump
  // between two cards that look alike still reads as an arrival, and a jump
  // that moved nothing (the camera was already there) still answers the
  // click. The ring lives in the view store (set below, once it exists), so
  // only that pin re-renders.
  const landedTimer = useRef(0)
  const ringLanded = useRef(() => {})
  const onFocusLanded = useCallback((comment) => ringLanded.current(comment), [])
  useEffect(() => () => window.clearTimeout(landedTimer.current), [])
  useFlyToPending({
    pendingFocus,
    setPendingFocus,
    targets: layout.targets,
    viewports,
    mode,
    flow,
    canvasRef,
    wide,
    setSettledZoom,
    onHidden: onFocusHidden,
    onLanded: onFocusLanded,
  })
  usePhoneStartView({ wide, nodesReady, initialCamera, selectedCommentId, canvasRef, nodes: layout.nodes, flow, setSettledZoom })
  // The first view on a desktop: a board that fits at a readable zoom is
  // fitted whole, a big one opens on its first group (camera.js). Hidden
  // until placed, so it never flashes at 100%.
  // A link to a journey step flies to that step instead (useJourneyActions).
  const startPending = useRef(!initialCamera.current && !selectedCommentId && !params.get('j'))
  const fitOnMount = useRef(!initialCamera.current && Boolean(selectedCommentId))
  const [startShown, setStartShown] = useState(() => !wide || !startPending.current)
  useEffect(() => {
    if (!startPending.current || !nodesReady || !layout.nodes.length) return
    startPending.current = false
    if (!wide) {
      setStartShown(true)
      return
    }
    const view = startViewport(layout.nodes, canvasRef.current?.getBoundingClientRect())
    setSettledZoom(null)
    // React Flow runs a fitView on a later frame: show the board once it is
    // placed, or the frame in between paints it at 100%.
    const placed = view ? flow.setViewport(view) : flow.fitView(FIT_OPTIONS)
    Promise.resolve(placed).finally(() => setStartShown(true))
  }, [flow, layout.nodes, nodesReady, setSettledZoom, wide])

  // After a pick from a toolbar list, focus goes back to the canvas (not the
  // trigger), so the next shortcut (C, the arrows) reaches the board.
  const picked = useRef(false)
  const markPicked = () => {
    picked.current = true
  }
  const backToCanvas = useCallback((event) => {
    if (!picked.current) return
    picked.current = false
    event.preventDefault()
    canvasRef.current?.focus({ preventScroll: true })
  }, [])
  // ---- Live HTML (useLiveFrames) ---------------------------------------------
  const { liveKeys, readyKeys, setLiveReady, liveFileFor, recomputeLive, openLive } = useLiveFrames({
    canvasRef,
    flow,
    targets: layout.targets,
    viewports,
    settledZoom,
    setSettledZoom,
    comparePair,
    captures: data?.captures,
    variantsById,
  })
  useEffect(() => {
    if (selectingKey && !liveKeys.has(selectingKey)) setSelectingKey(null)
  }, [liveKeys, selectingKey])
  // One tool at a time: Comment or Draw (the tools, C, the palette) takes over from "Select text".
  useEffect(() => {
    if (commentMode) setSelectingKey(null)
  }, [commentMode])

  // ---- Journeys ------------------------------------------------------------
  const { openJourney, closeJourney, goStep, chooseJourneyBranch, startBuilder, addBuilderStep, saveBuilder, removeJourney } =
    useJourneyActions({
      onLeave: leaveForNavigation,
      boardId,
      view,
      updateParams,
      clearFocus,
      setCommentMode,
      journey,
      route,
      routePages,
      step,
      builder,
      setBuilder,
      busy,
      setBusy,
      setNotice,
      flow,
      targets: layout.targets,
      nodesReady,
      mode,
      comparePair,
      setSettledZoom,
    })

  // ---- Arrows: links and journey steps ----------------------------------------
  // The selected card's page and viewport (not a variant's).
  const focusedFrame = focusedKey && !focusedKey.startsWith('variant:') ? splitFrameKey(focusedKey) : null
  const focusedPage = focusedFrame?.targetId || null
  const activePage = hoverPage || focusedPage
  const showAllLinks = params.get('la') === '1'
  const { presentPages, shownSteps, hiddenLinkTargets, edges, journeyView } = useArrows({
    targets: layout.targets,
    layoutEdges: layout.edges,
    links: data?.links,
    showLinks,
    showAllLinks,
    activePage,
    builder,
    route,
    routeGraph,
    routePages,
    step,
    journey,
    targetTitle,
  })

  // ---- Page history and jumping to a page ------------------------------------------
  const openHistory = useCallback(
    (pageId, viewport = null) => {
      if (!pageId || String(pageId).startsWith('variant:')) return
      const fallback = mode === 'all' ? viewportNames[0] : mode
      updateParams({ hist: pageId, hv: viewport && viewport !== fallback ? viewport : null })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, updateParams, viewportNames.join(',')],
  )
  const historyPage = historyPageId ? data?.board?.pages.find((page) => page.id === historyPageId) || null : null
  const historyViewport =
    historyViewportParam && viewports[historyViewportParam] ? historyViewportParam : mode === 'all' ? viewportNames[0] : mode
  const closeHistory = useCallback(() => updateParams({ hist: null, hv: null }), [updateParams])

  reopenParked.current = () => {
    if (!draftParked) return false
    reopenDraft()
    return true
  }
  const jumpToPage = (pageId) => {
    const target = layout.targets[pageId]
    if (!target) return
    leaveForNavigation()
    setSettledZoom(null)
    const frame = target.frames[0]
    const shots = target.frames.map((item) => data?.captures?.[pageId]?.[item.viewport]).filter((image) => image?.thumb || image?.file)
    flyToPage(flow, target, canvasRef.current?.getBoundingClientRect(), {
      phoneCompare: Boolean(comparePair) && !wide,
      shotUrls: shots.map((image) => fileUrl(boardId, 'captures', image.thumb || image.file, imageVersion)),
    })
    if (frame) setFocusedKey(`${pageId}|${frame.viewport}`)
  }
  const groupedPages = useMemo(() => {
    const pages = layoutPages
    const groups = [...new Set(pages.map((page) => page.group))]
    return groups.map((group) => ({ group, pages: pages.filter((page) => page.group === group) }))
  }, [layoutPages])

  // Where the comment being written goes (not its text, so typing does not
  // re-render the board).
  const draftSpot = useMemo(
    () => (draft ? { pageId: draft.pageId, viewport: draft.viewport, x: draft.x, y: draft.y, anchor: draft.anchor } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft?.pageId, draft?.viewport, draft?.x, draft?.y, draft?.anchor],
  )
  // A cluster of pins: zoom in until they come apart; at the closest zoom,
  // open the first one (the thread's arrows reach the rest).
  const openCluster = useCallback(
    (targetId, viewport, items) => {
      const target = layout.targets[targetId]
      const frame = target?.frames.find((item) => item.viewport === viewport)
      if (!frame) return
      if (flow.getZoom() >= 3.9) {
        selectComment(items[0].comment)
        return
      }
      setSettledZoom(null)
      flow.fitBounds(clusterBounds(target, frame, items), { padding: 0.3, duration: motionDuration(450) })
    },
    [flow, layout.targets, selectComment, setSettledZoom],
  )

  // What the cards read: a context that stays put through clicks and camera
  // moves, and a store for what does not (hooks/useBoardContext.js).
  const { board: boardContext, view: boardView } = useBoardContext({
    boardId,
    data,
    viewports,
    journeyView,
    compareView,
    commentMode,
    canComment,
    wide,
    hosted: info?.hosted,
    imageVersion,
    pinsByTarget,
    me,
    checksCounts,
    canChecks,
    agentFocus,
    agentWorkingPages,
    setLiveReady,
    focusedKey,
    selectingKey,
    settledZoom,
    selectedComment,
    draftSpot,
    unread,
    liveKeys,
    commentTargetKey: commentTarget?.key || null,
    // For the actions, read when one runs.
    selectedCommentId,
    closeThread,
    builder,
    addBuilderStep,
    goStep,
    layout,
    flow,
    canvasRef,
    setSettledZoom,
    setFocusedKey,
    setToast,
    setDraft,
    keepDraft,
    checkDraft,
    setCheckDraft,
    authorName,
    selectComment,
    openCluster,
    openChecks,
    // From a page's card: the open comment makes way (its own History link keeps it).
    openHistory: (...args) => {
      leaveForNavigation()
      openHistory(...args)
    },
    updateParams,
    defaultMode,
    onImageError,
  })
  // The arrival ring for "jump to comment" (onFocusLanded above): the view
  // store only exists from here on.
  ringLanded.current = (comment) => {
    window.clearTimeout(landedTimer.current)
    boardView.set({ landedId: comment?.id ?? null })
    if (comment?.id == null) return
    landedTimer.current = window.setTimeout(() => boardView.set({ landedId: null }), LANDED_MS)
  }

  // Hosted boards: the project's agents as this person may see and use them
  // (src/hosted/agents.js), for the Agent panel, "Send to <agent>" on a
  // thread and the faces on agents' replies. Members only; refreshed on a
  // timer, since an agent going offline is nobody's write.
  const hostedMember = Boolean(info?.hosted && !DEMO && !info?.guest && info?.role && boardId)
  const agentsQuery = useResource(hostedMember ? `/api/boards/${encodeURIComponent(boardId)}/agents` : null, { pollMs: 15000 })
  const agentList = hostedMember ? agentsQuery.data || null : null
  useEffect(() => rememberHostedAgents(agentList?.agents || []), [agentList])
  const {
    commentsUrl,
    applyComment,
    setStatus,
    replyTo,
    editComment,
    reactTo,
    copyLink,
    githubIssue,
    removeComment,
    sendToAgent,
    releaseAgent,
  } = useCommentActions({
    onAgentsChanged: agentsQuery.refetch,
    boardId,
    commentsQuery,
    view,
    info,
    localName,
    authorName,
    setBusy,
    setNotice,
    setToast,
    setDeletingIds,
    selectedCommentId,
    closeThread,
    wide,
    filter,
    allowed,
  })
  const commentMedia = useMemo(
    () => ({
      attach: canComment && !STATIC && !info?.guest,
      draw: canComment && !STATIC,
      attachNote:
        canComment && !STATIC && info?.guest ? 'Guests on a share link cannot attach images. You can still draw on the page.' : null,
    }),
    [canComment, info?.guest],
  )
  // The screenshot of a frame, for drawing on it in the phone's sheet.
  const pageImage = useCallback(
    (pageId, viewport) => {
      const image = data?.captures?.[pageId]?.[viewport]
      if (!image?.file) return null
      const variant = String(pageId).startsWith('variant:') ? variantsById.get(pageId) : null
      const page = pagesById.get(variant ? variant.pageId : pageId)
      const native = nativeSize(viewports, viewport, page?.frameHeight)
      return native ? { src: fileUrl(boardId, 'captures', image.file, imageVersion), native } : null
    },
    [boardId, data?.captures, imageVersion, pagesById, variantsById, viewports],
  )
  // The comment being written: its description and what its composer needs.
  const { draftDescription, draftTarget, composerProps } = useCommentDraft({
    draft,
    setDraft,
    busy,
    setBusy,
    commentsUrl,
    applyComment,
    markSeen,
    setLocalName,
    setNotice,
    updateParams,
    wide,
    filter,
    targetTitle,
    people,
    info,
    // Images go up to the board's server (or the demo's); a static export
    // that keeps comments in this browser takes neither images nor drawings.
    // Share link guests may draw but not upload (src/hosted).
    media: commentMedia,
    pageImage,
  })

  // The Draw tool picked a page: its comment is open, so the drawing starts
  // (after useCommentDraft's own effect, which makes the drawing). On a phone
  // the composer opens its drawing sheet instead (`startDraw` below).
  const [sheetDraw, setSheetDraw] = useState(false)
  useEffect(() => {
    if (!draft) setSheetDraw(false)
    if (!drawArmed || !draft) return
    setDrawArmed(false)
    if (!wide) setSheetDraw(true)
    else if (drawing.get()?.owner === 'composer') drawing.set({ tool: 'box' })
  }, [drawArmed, draft, wide])
  const { captureConfirm, setCaptureConfirm, startCapture } = useCapture({ boardId, view, setBusy, setNotice, setPolling })

  const cameraRested = useCallback(
    (viewport) => {
      updateParams({ v: `${Math.round(viewport.x)},${Math.round(viewport.y)},${viewport.zoom.toFixed(3)}` })
      // The camera has rested: this is the settled zoom, even when a fly-to
      // ended at the zoom it started from (which the zoom watcher never sees).
      setSettledZoom(viewport.zoom)
      // A pan without a zoom change does not move settledZoom; re-check live frames here.
      recomputeLive()
    },
    [recomputeLive, setSettledZoom, updateParams],
  )
  // Wheel, Space+drag and middle-drag move the camera in many small steps;
  // the camera rests once, when they stop (navigation.js).
  // The Hand tool (desktop): a drag anywhere pans and a click opens nothing
  // (navigation.js reads the ref when a press starts).
  const [hand, setHand] = useState(false)
  const handRef = useRef(false)
  const navigation = useCanvasNavigation({ canvasRef, flow, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, onRest: cameraRested, handRef })
  const onMoveEnd = useCallback(
    (event, viewport) => {
      if (!navigation.moving()) cameraRested(viewport)
    },
    [cameraRested, navigation],
  )

  // Back closes the topmost overlay: dialogs (their own entries), then the
  // sheet and menu, then the selected card.
  useOverlayEntry(Boolean(focusedKey), clearFocus)
  // The tip says "tap a page for its actions": once someone has, it is done.
  useEffect(() => {
    if (focusedKey && tipOpen) dismissTip()
  }, [dismissTip, focusedKey, tipOpen])
  useOverlayEntry(commentMode, () => setCommentMode(false))
  useOverlayEntry(Boolean(journey), closeJourney)
  useOverlayEntry(Boolean(builder), () => setBuilder(null))

  useCommentModeKeys({ commentMode, setCommentMode, canComment, comparePair, setDraft, keepDraft })
  useJourneyCycleKey({ journeys, journey, builder, openJourney, closeJourney })
  // The app sidebar (desktop): expanded or collapsed, Ctrl/Cmd+B, remembered.
  const [sidebarOpen, toggleSidebar] = useSidebarExpanded(wide, false)
  // Ctrl/Cmd+K: the command palette (pages, journeys, comments, actions).
  useEffect(() => {
    const onKey = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return
      if (document.querySelector('[role="dialog"]:not([data-sw-thread-popover]):not([data-sw-palette])')) return
      event.preventDefault()
      setPaletteOpen((open) => !open)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // Leaving comment mode drops a draft with nothing in it; text, a drawing
  // or an image keeps it.
  draftImages.current = composerProps.media.images.images.length
  useEffect(() => {
    if (!commentMode && !draftFilled()) setDraft(null)
  }, [commentMode, draftFilled])

  // A link that names both a comment and a journey: the comment wins. Its
  // thread opens at its pin and the journey leaves the address (on load only:
  // a comment opened while stepping a journey is fine, the next step closes it).
  useEffect(() => {
    const now = new URLSearchParams(window.location.search)
    if (Number(now.get('c')) && now.get('j')) updateParams({ j: null, step: null, jc: null, jb: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // An open thread counts as read.
  useEffect(() => {
    if (selectedComment) markSeen(selectedComment)
  }, [markSeen, selectedComment])
  useEffect(() => {
    if (selectedComment) markTried('open')
    if (commentMode) {
      markTried('comment')
      // They found comments: the page bar's Comment needs no pointing out.
      rememberPageCommentSeen()
    }
    if (chatThread) markTried('agent')
  }, [chatThread, commentMode, markTried, selectedComment])
  useCommentLink({
    nodesReady,
    data,
    commentsLoaded: commentsQuery.data,
    selectedCommentId,
    selectedComment,
    initialCamera,
    focusComment,
    deletingIds,
    setNotice,
    updateParams,
  })

  const { threadList, threadIndex, stepThread, neighborNote } = useThreadNav({
    selectedComment,
    visibleComments,
    focusComment,
    mode,
    viewports,
    modes,
  })

  // The thread under the mouse in the list or on the canvas lives in the
  // view store, so hovering renders nothing here: a hovered row lights up its
  // pin by an attribute, and the row reads the store itself (CommentsPanel).
  useEffect(() => {
    let lit = null
    const apply = () => {
      const { hoveredId } = boardView.get()
      const pin = hoveredId === null ? null : canvasRef.current?.querySelector(`[data-sw-pin="${hoveredId}"]`) || null
      if (pin === lit) return
      lit?.removeAttribute('data-sw-pin-hover')
      pin?.setAttribute('data-sw-pin-hover', 'true')
      lit = pin
    }
    const unsubscribe = boardView.subscribe(apply)
    return () => {
      unsubscribe()
      lit?.removeAttribute('data-sw-pin-hover')
    }
  }, [boardView])

  const setMode = (value) => {
    // A screen size the open comment (or the one being written) is not on.
    const pointsAt = selectedComment || draft
    if (pointsAt && value !== 'all' && pointsAt.viewport !== value) leaveForNavigation()
    setViewNotice(null)
    updateParams({ vp: value === defaultMode ? null : value })
  }
  // Hosted boards: people who can send comments to an agent get the Agent
  // control, which opens a panel that lists the project's agents, their
  // state and what each is doing (HostedAgentPanel.jsx): beside the canvas
  // on desktop, a sheet from the More menu on a phone; `ha=1` in the
  // address. An agent connected with `shapewall agent connect` can be
  // chatted with from there: the chat (`chat=`) then takes the panel's
  // place, and closing it comes back to the list.
  const hostedAgent = Boolean(info?.hosted && !DEMO && data?.agentDispatch)
  const hostedAgentOpen = hostedAgent && wide && params.get('ha') === '1' && !checksOpen
  const hostedAgentSheet = hostedAgent && !wide && params.get('ha') === '1' && !checksOpen && !chatThread
  const openHostedAgent = () => updateParams({ ha: '1', checks: null, cv: null })
  // A new chat of this person's own with one connected agent.
  const openHostedChat = async (agent) => {
    const threadId = newChatId()
    try {
      await api.post(`/api/agent/boards/${encodeURIComponent(boardId)}/threads/${threadId}/profile`, { profileId: agent.id })
      openChat(threadId)
    } catch (error) {
      setToast({ at: Date.now(), text: error.message || `Could not open a chat with ${agent.name}.` })
    }
  }
  // The server says a shared chat or the agents changed (presence): the list follows.
  const refetchAgents = agentsQuery.refetch
  useEffect(() => {
    if (!hostedMember) return undefined
    const onChange = (event) => {
      if (!event.detail?.thread) refetchAgents()
    }
    window.addEventListener('shapewall:hosted-agents', onChange)
    return () => window.removeEventListener('shapewall:hosted-agents', onChange)
  }, [hostedMember, refetchAgents])
  const allOpen = comments.filter((item) => item.status === 'open').length
  // What the agents are doing, board-wide, for the toolbar (agentActivity.js):
  // from the comments' agent statuses (the events stream and the comments
  // poll keep them fresh), the chat turn in progress and hosted approvals.
  const activity = useMemo(
    () =>
      agentActivity({
        comments,
        focus: focusEntry,
        approvals: approvalRows,
        titleOf: titleOfPage,
        // Only for people who can send comments to an agent here: nobody
        // else needs to hear that none is online.
        agents: info?.hosted && data?.agentDispatch ? agentList : null,
        listening: info?.hosted && data?.agentDispatch ? data?.agentListening || null : null,
      }),
    [agentList, approvalRows, comments, data?.agentDispatch, data?.agentListening, focusEntry, info?.hosted, titleOfPage],
  )
  // The hosted Agent panel, beside the canvas or as a phone's sheet.
  const hostedAgentProps = hostedAgent
    ? {
        agents: agentList,
        listening: data?.agentListening || null,
        activity,
        approvals: approvalRows.length,
        titleOf: (id) => titleOfPage(comments.find((item) => item.id === id)?.pageId),
        // Admins manage agents in the console (the project's Agents page).
        manageUrl:
          ['admin', 'owner'].includes(info?.role) && info?.workspace?.id && info?.project?.id
            ? `/w/${info.workspace.id}/agents/${info.project.id}`
            : null,
        onOpenComment: (id) => {
          const comment = comments.find((item) => item.id === id)
          if (!comment) return
          // On a phone the sheet makes way for the thread.
          if (!wide) updateParams({ ha: null })
          focusComment(comment)
        },
        // Chat with a connected agent (only where the server offers it).
        onChat: chatAvailable ? openHostedChat : null,
        onBoardChat: chatAvailable ? () => openChat('board') : null,
        admin: ['admin', 'owner'].includes(info?.role),
      }
    : null
  // Batch fixes: offered only when Fix with agent is, and turned on in Agents.
  const fixAvailable = Boolean(
    chatAvailable && !data?.migratedTo?.readOnly && info?.agent?.fixWithAgent && info?.agent?.configured && (!info?.hosted || DEMO),
  )
  const batchFixes = useBatchFixes({
    boardId,
    enabled: fixAvailable,
    // Each fix moves its comment and recaptures its page: both follow.
    onProgress: () => {
      commentsQuery.refetch()
      view.refetch()
    },
  })
  const [batchConfirm, setBatchConfirm] = useState(null)
  const openBatchThread = (commentId) => {
    const comment = comments.find((item) => item.id === commentId)
    if (comment) focusComment(comment)
    else openChat(threadForComment(commentId))
  }
  const batchProps = {
    ...batchFixes,
    agentName: info?.agent?.label || 'agent',
    boardId,
    onOpenThread: openBatchThread,
    onConfirm: (ids) => setBatchConfirm(ids),
  }
  const panelProps = {
    batch: batchProps,
    comments: visibleComments,
    filter,
    counts,
    onFilter: (value) => updateParams({ filter: value === 'open' ? null : value }),
    selectedId: selectedCommentId,
    onHover: boardContext.onHoverComment,
    onFocus: (comment) => {
      threadFromList.current = !wide
      focusComment(comment)
    },
    unread,
    onMarkAllRead: () => markAllSeen(comments),
    people,
    narrow: {
      query,
      state: stateFilter,
      mention: mentionFilter,
      onQuery: (value) => updateParams({ q: value || null }),
      onState: (value) => updateParams({ st: value }),
      onMention: (value) => updateParams({ m: value }),
      onClear: () => updateParams({ q: null, st: null, m: null }),
    },
    canAct: canComment,
    targetTitle,
    touch: !wide,
    // Demo exports: say where comments go, and let visitors start over.
    onResetBrowserComments: BROWSER_COMMENTS
      ? () => {
          resetBrowserComments(boardId)
          updateParams({ c: null })
          commentsQuery.refetch()
          view.refetch()
        }
      : null,
    journeyFilter: journey
      ? { name: journey.name, on: journeyComments, onToggle: () => updateParams({ jc: journeyComments ? null : '1' }) }
      : null,
  }
  // The open thread (popover at its pin on desktop, sheet on a phone).
  const threadProps = selectedComment
    ? {
        comment: selectedComment,
        page: findPage(selectedComment.pageId),
        title: targetTitle(selectedComment.pageId),
        people,
        me,
        can: threadCan(selectedComment),
        // Who is asking, for "Viewers can't reply" and the name a local board asks for once.
        role: info?.guest ? 'guest' : info?.role || null,
        hosted: Boolean(info?.hosted),
        // Hosted: the project's agents, for "Send to <agent>" (null: not known).
        agents: info?.hosted && data?.agentDispatch ? agentList : null,
        onSaveName: setLocalName,
        // Images and drawings on its messages and in the reply box.
        media: {
          ...commentMedia,
          boardId,
          pageImage,
          pageTitle: targetTitle(selectedComment.pageId),
          currentVersion: (comment) =>
            String(comment.pageId).startsWith('variant:')
              ? null
              : entryVersion(data?.manifest?.pages?.[comment.pageId]?.[comment.viewport], data?.manifest),
        },
        busy,
        touch: !wide,
        editingRef,
        actions: {
          onReply: replyTo,
          onSendToAgent:
            info?.hosted && data?.agentDispatch && !selectedComment.authorGuest && !selectedComment.authorAgent ? sendToAgent : null,
          onReleaseAgent: info?.hosted && data?.agentDispatch ? releaseAgent : null,
          onStatus: setStatus,
          onEdit: editComment,
          onDelete: removeComment,
          onReact: reactTo,
          onCopyLink: copyLink,
          onFixAgent:
            chatAvailable && !data?.migratedTo?.readOnly && info?.agent?.fixWithAgent && info?.agent?.configured
              ? (comment) => {
                  setFixRequest({ commentId: comment.id, nonce: Date.now() })
                  if (!wide) setThreadSheet(false)
                  openChat(threadForComment(comment.id))
                }
              : null,
          // Hosted: "Fix with <agent>" (HostedFix.jsx). The server takes the
          // comment as it reads on screen at the click (`dispatchHash`), for
          // the agent named; the comment's chat opens and shows the turn.
          onHostedFix:
            info?.hosted &&
            !DEMO &&
            chatAvailable &&
            data?.agentDispatch &&
            !data?.migratedTo?.readOnly &&
            !selectedComment.authorGuest &&
            !selectedComment.authorAgent
              ? (comment, agentId) => {
                  setFixRequest({
                    commentId: comment.id,
                    nonce: Date.now(),
                    hosted: { agentId, dispatchHash: comment.dispatchHash },
                  })
                  if (!wide) setThreadSheet(false)
                  openChat(threadForComment(comment.id))
                }
              : null,
          onAskAgent: chatAvailable
            ? (comment) => {
                if (!wide) setThreadSheet(false)
                openChat(threadForComment(comment.id))
              }
            : null,
          onGithubIssue: !STATIC && info?.github?.ready ? githubIssue : null,
          onHistory: (comment) => {
            if (!wide) setThreadSheet(false)
            openHistory(comment.pageId, comment.viewport)
          },
        },
        nav: {
          index: threadIndex,
          total: threadList.length,
          onPrev: () => stepThread(-1),
          onNext: () => stepThread(1),
          prevNote: neighborNote(-1),
          nextNote: neighborNote(1),
        },
        beforeAfter: data
          ? {
              pairFor: (comment) => beforeAfter(comment, { manifest: data.manifest, captures: data.captures, versions: data.versions }),
              // The frame the comment was made on: its page may set its own height.
              nativeFor: (comment) => {
                const variant = String(comment.pageId).startsWith('variant:') ? variantsById.get(comment.pageId) : null
                const page = pagesById.get(variant ? variant.pageId : comment.pageId)
                return nativeSize(viewports, comment.viewport, page?.frameHeight) || null
              },
              urlFor: (side) => fileUrl(boardId, side.kind, side.file, side.version),
              onImageError,
            }
          : null,
      }
    : null
  const chatProps = {
    boardId,
    batch: batchProps,
    fixRequest,
    onFixDone: () => {
      setFixRequest(null)
      agentsQuery.refetch()
      view.refetch()
      commentsQuery.refetch()
    },
    agent: info?.agent,
    threadId: chatThread || 'board',
    onThread: openChat,
    comments,
    pages: data?.board?.pages || [],
    captures: data?.captures || {},
    imageVersion,
    defaultViewport: mode === 'all' ? defaultMode : mode,
    focused: focusedFrame ? { pageId: focusedFrame.targetId, viewport: focusedFrame.viewport } : null,
    touch: !wide,
    onOpenSettings: settingsAvailable ? openSettings : null,
    // Settings would open here with the link from the terminal.
    settingsLocked: Boolean(chatAvailable && !settingsAvailable && info?.agent?.settingsLocked),
    onAgentChanged: onInfoChanged,
    // The chat composer's "@" list and its /checks and /recapture commands.
    people,
    onRunChecks: checksRun
      ? async () => {
          const started = await checksRun.start({ seo: checksRun.seoDefault })
          openChecks()
          return started
        }
      : null,
    // A reference chip in an answer (chat/refs.js) jumps the canvas there, as
    // the Ctrl/Cmd+K palette does; on a phone the chat sheet steps aside.
    journeys,
    checksCounts: canChecks ? checksCounts : null,
    onBoardChanged: () => {
      view.refetch()
      commentsQuery.refetch()
    },
    onNavigate: (ref) => {
      if (!wide && ref.kind !== 'check') updateParams({ chat: null })
      if (ref.kind === 'comment') {
        const item = comments.find((entry) => entry.id === ref.id)
        if (item) focusComment(item)
      } else if (ref.kind === 'page') jumpToPage(ref.id)
      else if (ref.kind === 'journey') openJourney(ref.id)
      else if (ref.kind === 'check') openChecks(ref.id)
    },
    onRecapture:
      canCapture && !comparePair
        ? // A page id (the composer's /recapture) or a list (a run summary's pages); none: the whole board.
          (pages) => (pages ? startCapture(null, Array.isArray(pages) ? pages : [pages]) : setCaptureConfirm(true))
        : DEMO
          ? () =>
              setNotice({ tone: 'info', text: 'The demo does not take new captures. On your own board this recaptures the changed pages.' })
          : null,
  }
  // The step a comment is at, one at a time (data-sw-comment-flow on the
  // canvas): drawing (a tool is on), composing (a target is picked, the
  // composer is open), picking (comment mode, nothing picked yet), else off.
  const commentState = drawingOn
    ? 'drawing'
    : draft && wide && !draftParked
      ? 'composing'
      : commentMode && canComment && !comparePair
        ? 'picking'
        : 'off'
  // ---- The board's tools (BoardTools.jsx) --------------------------------------
  // Only what this person may use here; with Select alone there is no toolbar.
  const commenting = canComment && !comparePair
  const hasLive = useMemo(
    () =>
      !comparePair &&
      (Object.values(data?.captures || {}).some((sizes) => Object.values(sizes || {}).some((image) => image?.live)) ||
        (data?.variants || []).some((variant) => Object.values(variant.files || {}).some((file) => file?.live))),
    [comparePair, data?.captures, data?.variants],
  )
  // Select text: beside Comment and Draw whenever the board has live pages;
  // for someone who may not comment, only while a page is live (a pointer
  // and a tool that cannot be used yet would be noise).
  const tools = toolList({
    wide,
    commenting,
    draw: commentMedia.draw,
    liveBoard: hasLive,
    livePage: liveKeys.size > 0 || Boolean(selectingKey),
  })
  const activeTool = toolInUse({
    drawing: drawingOn,
    commentMode: commentMode && commenting,
    drawArmed,
    selecting: Boolean(selectingKey) && wide,
    hand: hand && wide,
  })
  handRef.current = activeTool === 'hand'
  // One tool at a time: Comment, Draw or Select text takes over from Hand.
  useEffect(() => {
    if (commentMode || selectingKey || drawingOn) setHand(false)
  }, [commentMode, selectingKey, drawingOn])
  // The page bar's Comment: on for that page, and off again from the same
  // button. A comment with something in it is never dropped for it.
  const commentOnPage = (key, event) => {
    if (!commenting) return
    if (commentMode && !drawArmed && commentTarget?.key === key) {
      setCommentMode(false)
      return
    }
    if (keepDraft()) return
    setDraft(null)
    setDrawArmed(false)
    setCommentMode(true)
    // Enter or Space on the button (no pointer): the page takes the keyboard.
    setCommentTarget({ key, keyboard: event?.detail === 0 })
  }
  // The target lasts while comment mode is aimed at that selected page: not
  // past Draw, another page's comment, or the page being let go.
  const draftKey = draft ? `${draft.pageId}|${draft.viewport}` : null
  useEffect(() => {
    if (!commentTarget) return
    if (!commentMode || drawArmed || focusedKey !== commentTarget.key || (draftKey && draftKey !== commentTarget.key))
      setCommentTarget(null)
  }, [commentMode, commentTarget, draftKey, drawArmed, focusedKey])
  // Started from the keyboard: the page is focused (Enter pins, Frame.jsx),
  // and when it is over the focus goes back to the button.
  const keyboardTarget = commentTarget?.keyboard ? commentTarget.key : null
  useEffect(() => {
    if (!keyboardTarget) return undefined
    const { targetId, viewport } = splitFrameKey(keyboardTarget)
    const canvas = canvasRef.current
    const frame = window.requestAnimationFrame(() => {
      canvas?.querySelector(`[data-sw-frame=${JSON.stringify(`${targetId}:${viewport}`)}]`)?.focus({ preventScroll: true })
    })
    return () => {
      window.cancelAnimationFrame(frame)
      window.requestAnimationFrame(() => {
        const active = document.activeElement
        // The page gave the keyboard up (to the body, or its card): nothing else took it.
        if (active && active !== document.body && !active.matches('[data-sw-frame], .react-flow__node')) return
        canvas?.querySelector(`[data-sw-frame-comment=${JSON.stringify(keyboardTarget)}]`)?.focus({ preventScroll: true })
      })
    }
  }, [keyboardTarget])
  const pickTool = (id) => {
    const session = drawing.get()
    if (id === 'select' || id === 'hand') {
      if (session?.tool) drawing.set({ tool: null })
      setSelectingKey(null)
      setCommentMode(false)
      setHand(id === 'hand')
      // Hand selects nothing: the selected card lets go.
      if (id === 'hand') clearFocus()
    } else if (id === 'comment') {
      // From drawing: one step back, to the comment. From Draw with no page
      // picked: the same click now pins a comment. Else on and off, as C.
      if (session?.tool) {
        drawing.set({ tool: null })
        setDrawArmed(false)
        setCommentMode(true)
      } else if (commentMode && drawArmed) setDrawArmed(false)
      else setCommentMode((value) => !value)
    } else if (id === 'draw') {
      // A comment or a reply is open: draw on its page (again: back to it).
      if (wide && session) drawing.set({ tool: session.tool ? null : 'box' })
      else if (commentMode && drawArmed) setCommentMode(false)
      else if (!keepDraft()) {
        setDraft(null)
        setCommentMode(true)
        setDrawArmed(true)
      }
    } else if (id === 'text') {
      if (selectingKey) setSelectingKey(null)
      else if (focusedKey && liveKeys.has(focusedKey) && readyKeys.has(focusedKey)) {
        if (session?.tool) drawing.set({ tool: null })
        setCommentMode(false)
        setSelectingKey(focusedKey)
      } else {
        setToast({
          at: Date.now(),
          text: 'Select text works on a live page: click a page, then Open live (or zoom in until it goes live).',
        })
      }
    }
  }
  // Esc leaves "Select text" (back to Select), unless it closes something
  // first. Read in the capture phase and used up, as comment mode's Esc is
  // (useCommentModeKeys), so the same key does not also leave a journey.
  // Esc from Hand goes to Select the same way.
  useEffect(() => {
    if ((!selectingKey && !hand) || commentMode) return undefined
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isEditable(event.target)) return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      event.preventDefault()
      setSelectingKey(null)
      setHand(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selectingKey, hand, commentMode])
  // V is Select, H is Hand (tools.js: not while typing or with a dialog,
  // menu or list open; the same guard as C).
  const pickToolRef = useRef(pickTool)
  pickToolRef.current = pickTool
  const toolKeys = tools.join(',')
  useEffect(() => {
    const onKey = (event) => {
      const tool = toolForKey(event, {
        tools: toolKeys.split(','),
        busy: Boolean(document.querySelector('[role="dialog"]:not([data-sw-thread-popover]), [role="menu"], [role="listbox"]')),
        handled: event.defaultPrevented && !isIgnoredTypeahead(event),
      })
      if (!tool) return
      event.preventDefault()
      pickToolRef.current(tool)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toolKeys])
  // The note for the tool in use, above the tools: one at a time.
  const toolNote = drawingOn
    ? 'drawing'
    : commentState === 'composing'
      ? 'composing'
      : commentMode && commenting
        ? 'picking'
        : selectingKey && wide
          ? 'text'
          : null
  // Phones: the tools are the bottom bar; they step aside for a sheet (the
  // composer, a thread, the lists, the menu) and for the keyboard.
  const keyboardUp = useKeyboardUp(!wide)
  const phoneCovered =
    !wide && (Boolean(draft) || threadSheet || sheetOpen || menuOpen || Boolean(checksOpen) || Boolean(chatThread) || hostedAgentSheet)
  const toolsOffered = Boolean(data) && tools.length > 1
  const toolsShown = toolsOffered && !phoneCovered && !keyboardUp
  const canvasWidth = useCanvasWidth(canvasRef)
  const noteSqueezed = Boolean(toolNote) && canvasWidth < NOTE_ROOM
  const minimapWanted = wide && minimapOn && !liveKeys.size && !journey && !builder && !noteSqueezed
  const toolsPlace = !toolsShown
    ? { shift: 0, compact: 0, right: true }
    : wide
      ? placeTools({
          width: canvasWidth,
          tools: toolsWidth(tools.length, false, hasDivider(tools)),
          left: [DOCK.zoomFull, DOCK.zoomCompact, 0],
          right: minimapWanted ? DOCK.minimap : 0,
        })
      : placeTools({
          width: canvasWidth,
          tools: toolsWidth(tools.length, true),
          left: journey || builder ? [] : [DOCK.fit],
          margin: DOCK.touchMargin,
        })
  const toggleLinks = () => updateParams({ links: showLinks ? null : '1' })
  const toggleMinimap = () => {
    const next = !minimapOn
    setMinimapChoice(next)
    rememberMinimap(next)
  }
  // A dialog over the board: thread and composer popovers step aside.
  const modalOpen = Boolean(historyPage) || settingsOpen || generalSettingsOpen || captureConfirm || (!wide && checksOpen)
  const checksProps = {
    data: checksQuery.data,
    error: checksQuery.error,
    loading: checksQuery.loading,
    pages: data?.board?.pages || [],
    pageId: checksPage,
    viewport: checksViewport,
    onSelect: openChecks,
    onClose: closeChecks,
    onRefresh: checksQuery.refetch,
    onEnvironment: (id) => updateParams({ ce: id }),
    canComment,
    local: !STATIC && !info?.hosted,
    onView: (pageId, viewport) => {
      closeChecks()
      updateParams({ vp: viewport, page: pageId })
      setPendingFocus({ pageId, viewport, x: 50, y: 50 })
    },
    onDraft: (view, report, finding) => {
      setCheckDraft(
        `${finding.title}\n\n${finding.observation}\n${finding.nextAction}\n\nCheck report ${report.id} (${view.viewport}, ${report.auditedAt}). Separately sampled; review before sending to an agent.`.slice(
          0,
          1800,
        ),
      )
      closeChecks()
      updateParams({ vp: view.viewport })
      setPendingFocus({ pageId: view.pageId, viewport: view.viewport, x: 50, y: 50 })
      setSheetOpen(false)
      setCommentMode(true)
      setToast({ at: Date.now(), text: 'Choose a pin on the page, then review and save your comment.' })
    },
    // Tab, SEO previews, run controls and the command (owned by useChecks).
    ...checksPanelProps,
  }

  const skipToComments = (event) => {
    event.preventDefault()
    closeChecks()
    if (!wide) {
      setSheetOpen(true)
      return
    }
    if (panelHidden || chatThread) updateParams({ panel: null, chat: null })
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => document.getElementById('sw-comments')?.focus()))
  }
  // Keyboard on the canvas: each card is one tab stop (React Flow focuses
  // the node); the arrow keys move through its pins and buttons, Esc goes
  // back to the card, and Enter or Space on the card opens its actions.
  const onCanvasKeyDown = (event) =>
    cardKeyDown(event, (id) => {
      const frame = layout.targets[id]?.frames[0]
      if (frame) boardContext.onFocusFrame(id, frame.viewport)
    })

  const toggleCompareLeaving = () => {
    if (!comparePair) leaveForNavigation()
    toggleCompare()
  }
  // Board actions in the command palette.
  const paletteActions = boardPaletteActions({
    canComment,
    comparePair,
    commentMode,
    markPicked,
    setDraft,
    keepDraft,
    setCommentMode,
    showLinks,
    toggleLinks,
    canCompare,
    toggleCompare: toggleCompareLeaving,
    wide,
    fitBoard,
    minimapOn,
    toggleMinimap,
    chatAvailable,
    reopenChat,
    canChecks,
    openChecks,
  })

  // What the toolbar and the phone menu both need.
  const barProps = {
    setMenuOpen,
    data,
    chatAvailable,
    chatThread,
    reopenChat,
    activity,
    openAgentThread: (commentId) => openChat(threadForComment(commentId)),
    updateParams,
    groupedPages,
    jumpToPage,
    modes,
    mode,
    setMode,
    journeys,
    journey,
    canEditJourneys,
    openJourney,
    closeJourney,
    startBuilder,
    openBrokenLinks: () => setBrokenOpen(true),
    canChecks,
    openChecks,
    showLinks,
    toggleLinks,
    brokenLinks,
    canCompare,
    comparePair,
    toggleCompare: toggleCompareLeaving,
    settingsAvailable,
    openSettings,
    capture,
    canCapture,
    busy,
    setCaptureConfirm,
  }
  return (
    <BoardProviders board={boardContext} view={boardView} people={people}>
      <div className="flex h-full flex-col" data-sw-board={boardId} style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <DemoBanner />
        <AccessLostBanner />
        {info?.hosted && data?.agentApprove ? (
          <HostedApprovals
            boardId={boardId}
            onRows={setApprovalRows}
            onOpenThread={chatAvailable ? openChat : null}
            openThread={chatThread || null}
          />
        ) : null}
        <a
          href="#sw-comments"
          className="sr-only z-[80] rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
          onClick={skipToComments}
          data-sw-skip-comments="true"
        >
          Skip to comments
        </a>
        <div className="flex min-h-0 flex-1">
          {wide ? (
            <BoardRail
              {...barProps}
              info={info}
              localName={localName}
              onOpenBuzz={onOpenBuzz}
              demo={demo}
              localSettingsAvailable={localSettingsAvailable}
              setShareOpen={setShareOpen}
              expanded={sidebarOpen}
              onToggle={toggleSidebar}
              openPalette={() => setPaletteOpen(true)}
              quiet={drawingOn}
              pages={
                data
                  ? {
                      groups: groupedPages,
                      journeys,
                      comments,
                      activePage,
                      journeyId: journey?.id || null,
                      onPage: jumpToPage,
                      onJourney: openJourney,
                      canEditJourneys,
                      onNewJourney: () => startBuilder(),
                    }
                  : null
              }
            />
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col">
            <BoardToolbar
              {...barProps}
              {...(wide && hostedAgent
                ? {
                    chatAvailable: true,
                    chatThread: chatThread || (hostedAgentOpen ? 'hosted' : null),
                    reopenChat: openHostedAgent,
                    openAgentThread: openHostedAgent,
                  }
                : {})}
              wide={wide}
              info={info}
              boardId={boardId}
              boards={boards}
              localProjects={localProjects}
              projectsError={projectQuery.error}
              localName={localName}
              onPickBoard={onPickBoard}
              onOpenBuzz={onOpenBuzz}
              demo={demo}
              localSettingsAvailable={localSettingsAvailable}
              setShareOpen={setShareOpen}
              viewNotice={viewNotice}
              canComment={canComment}
              minimapOn={minimapOn}
              toggleMinimap={toggleMinimap}
              linksTip={linksTip}
              panelHidden={panelHidden}
              checksOpen={checksOpen}
              allOpen={allOpen}
              closeChecks={closeChecks}
              setSheetOpen={setSheetOpen}
              sidebarTitled={wide && sidebarOpen}
            />
            {!info?.hosted && data?.migratedTo ? (
              <Suspense fallback={null}>
                <MigrationBanner
                  marker={data.migratedTo}
                  boardId={boardId}
                  editable={Boolean(info?.shareEnabled)}
                  onChange={view.refetch}
                />
              </Suspense>
            ) : null}
            <NoticeBar notice={notice} setNotice={setNotice} wide={wide} />
            {comparePair ? (
              <CompareBar
                environments={environments}
                pair={comparePair}
                loading={compareQuery.loading || !compareData}
                error={compareQuery.error ? compareQuery.error.message : null}
                changedPages={compareData?.changedPages ?? 0}
                totalPages={data?.board?.pages?.length || 0}
                changedOnly={changedOnly}
                showDiff={showDiff}
                canCapture={canCapture}
                captureBusy={busy || Boolean(capture?.running)}
                touch={!wide}
                onPair={(pair) => setCompare(pair)}
                onChangedOnly={setChangedOnly}
                onShowDiff={(value) => updateParams({ diff: value ? null : 'off' })}
                onCapture={(env) => startCapture(env)}
                onClose={() => setCompare(null)}
              />
            ) : null}
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <div
                ref={canvasRef}
                tabIndex={-1}
                className={cn(
                  'relative min-w-0 flex-1 outline-none',
                  commentState === 'picking' && 'sw-commenting',
                  activeTool === 'hand' && 'sw-hand',
                )}
                onKeyDown={onCanvasKeyDown}
                data-sw-canvas="true"
                data-sw-comment-flow={commentState}
              >
                {showLinks && brokenLinks.length ? (
                  <BrokenLinks items={brokenLinks} open={brokenOpen} onOpenChange={setBrokenOpen} />
                ) : null}
                {wide && data ? (
                  <DrawingMode
                    flow={flow}
                    canvasRef={canvasRef}
                    targets={layout.targets}
                    focusFor={(owner) => ((owner === 'composer' ? draft?.y : selectedComment?.y) ?? 50) / 100}
                    shotFor={(pageId, viewport) => {
                      const image = data.captures?.[pageId]?.[viewport]
                      return image?.file ? fileUrl(boardId, 'captures', image.thumb || image.file, imageVersion) : null
                    }}
                  />
                ) : null}
                {drawingOn ? null : (
                  <CanvasNotes
                    wide={wide}
                    commentMode={commentMode}
                    canComment={canComment}
                    composing={commentState === 'composing'}
                    parkedDraft={
                      draft && draftParked
                        ? { title: targetTitle(draft.pageId), onReopen: reopenDraft, onDiscard: () => setDraft(null) }
                        : null
                    }
                    showLinks={showLinks}
                    activePage={activePage}
                    shownSteps={shownSteps}
                    data={data}
                    presentPages={presentPages}
                    hiddenLinkTargets={hiddenLinkTargets}
                    showAllLinks={showAllLinks}
                    targetTitle={targetTitle}
                    updateParams={updateParams}
                    tipOpen={tipOpen}
                    tryOpen={tryOpen}
                    journey={journey}
                    builder={builder}
                    viewNotice={viewNotice}
                    undoViewNotice={undoViewNotice}
                    dismissTip={dismissTip}
                    modes={modes}
                    comparePair={comparePair}
                  />
                )}
                {!data && view.error ? (
                  <BoardLoadError error={view.error} onRetry={view.refetch} />
                ) : !data ? (
                  <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
                    <Spinner /> Loading board
                  </div>
                ) : (
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    edgeTypes={EDGE_TYPES}
                    // Hovering a card shows only its own link arrows.
                    onNodeMouseEnter={showLinks ? (event, node) => setHoverPage(node.type === 'page' ? node.id : null) : undefined}
                    onNodeMouseLeave={showLinks ? () => setHoverPage(null) : undefined}
                    onNodesChange={onNodesChange}
                    // React Flow drops pointer events on nodes with no interaction
                    // at all; a click handler keeps pins, links and comment clicks alive.
                    onNodeClick={noop}
                    nodeTypes={NODE_TYPES}
                    colorMode={colorMode}
                    defaultViewport={initialCamera.current || undefined}
                    // Only on mount (a link to a comment, which then flies to it):
                    // the prop flipping later would refit the board.
                    fitView={fitOnMount.current}
                    style={startShown ? undefined : { opacity: 0 }}
                    edgesFocusable={false}
                    fitViewOptions={FIT_OPTIONS}
                    minZoom={MIN_ZOOM}
                    maxZoom={MAX_ZOOM}
                    // Wheel, pinch-on-trackpad, Space and middle-drag are ours
                    // (navigation.js); React Flow keeps touch and left-drag.
                    panOnScroll={false}
                    zoomOnScroll={false}
                    panActivationKeyCode={null}
                    zoomActivationKeyCode={null}
                    onlyRenderVisibleElements
                    nodesDraggable={false}
                    nodesConnectable={false}
                    elementsSelectable={false}
                    zoomOnDoubleClick={!commentMode && activeTool !== 'hand'}
                    onMoveEnd={onMoveEnd}
                    onPaneClick={() => {
                      clearFocus()
                      if (selectedCommentId) closeThread()
                    }}
                    proOptions={{ hideAttribution: true }}
                  >
                    <Background gap={40} size={1} />
                    <FocusedFrameBar
                      onChecks={canChecks ? openChecks : null}
                      onHistory={(...args) => {
                        leaveForNavigation()
                        openHistory(...args)
                      }}
                      historyCountFor={(pageId) => historyCount(data?.versions, pageId)}
                      focusedKey={drawingOn ? null : focusedKey}
                      layout={layout}
                      data={data}
                      liveKeys={liveKeys}
                      readyKeys={readyKeys}
                      selectingKey={selectingKey}
                      touch={!wide}
                      liveFileFor={liveFileFor}
                      onOpenLive={openLive}
                      onToggleSelect={(key) => setSelectingKey((current) => (current === key ? null : key))}
                      onClose={clearFocus}
                      onCapture={canCapture && !comparePair ? (pageId) => startCapture(null, [pageId]) : null}
                      captureBusy={busy || Boolean(capture?.running)}
                      onComment={commenting ? commentOnPage : null}
                      commentTargetKey={commentMode && !drawArmed ? commentTarget?.key || null : null}
                    />
                    {wide && draft && !draftParked && !modalOpen ? (
                      <ComposerPopover
                        point={pinPoint(layout.targets, draft)}
                        // Re-aimed at another spot: a card that was dragged goes back to its pin.
                        resetKey={`${draft.pageId}|${draft.viewport}|${draft.x}|${draft.y}`}
                        stowed={drawingOn}
                        onClose={() => (busy ? null : setDraft(null))}
                        onEscape={() => {
                          // Esc while being asked is "Keep".
                          if (discardAsk) {
                            setDiscardAsk(false)
                            return false
                          }
                          if (!draftHasMedia()) return true
                          setDiscardAsk(true)
                          return false
                        }}
                      >
                        <CommentComposer
                          {...composerProps}
                          touch={false}
                          description={draftDescription}
                          discard={discardAsk ? { onDiscard: () => setDraft(null), onKeep: () => setDiscardAsk(false) } : null}
                        />
                      </ComposerPopover>
                    ) : null}
                    {wide && threadProps && !draft && !modalOpen ? (
                      <ThreadPopover
                        comment={selectedComment}
                        point={pinPoint(layout.targets, selectedComment)}
                        onClose={closeThread}
                        stowed={drawingOn}
                        onPrev={() => stepThread(-1)}
                        onNext={() => stepThread(1)}
                        editingRef={editingRef}
                      >
                        <ThreadView {...threadProps} onClose={closeThread} />
                      </ThreadPopover>
                    ) : null}
                    <CanvasControls
                      wide={wide}
                      clearFocus={clearFocus}
                      setSettledZoom={setSettledZoom}
                      minimapOn={minimapOn}
                      liveKeys={liveKeys}
                      toggleMinimap={toggleMinimap}
                      hideFit={Boolean(journey || builder)}
                      hideMinimap={Boolean(journey || builder) || noteSqueezed || !toolsPlace.right}
                      compact={toolsPlace.compact === 1}
                      hideZoom={wide && toolsPlace.compact === 2}
                      fitBoard={fitBoard}
                    />
                  </ReactFlow>
                )}
                {info?.hosted && !DEMO ? (
                  <PresenceLayer
                    touch={!wide}
                    enabled={Boolean(data) && !STATIC}
                    boardId={boardId}
                    canvasRef={canvasRef}
                    flow={flow}
                    selection={selectedCommentId}
                    mode={mode}
                    onMode={(value) => updateParams({ vp: value })}
                    onInvalidate={() => {
                      commentsQuery.refetch()
                      view.refetch()
                      // An agent took or finished something.
                      agentsQuery.refetch()
                    }}
                  />
                ) : null}
                {tryOpen && data && !journey && !builder && !drawingOn && !(commentMode && !wide) && !noteSqueezed ? (
                  <TryThis
                    touch={!wide}
                    // A tool's note is up: the card folds to its chip, clear of it.
                    chip={Boolean(toolNote)}
                    done={tryDone}
                    onOpenComment={() => {
                      const open = visibleComments.filter((item) => item.status === 'open')
                      const pick = open.find((item) => mode === 'all' || item.viewport === mode) || open[0] || visibleComments[0]
                      if (pick) focusComment(pick)
                    }}
                    onComment={
                      canComment && !comparePair
                        ? () => {
                            if (keepDraft()) return
                            setDraft(null)
                            setCommentMode(true)
                          }
                        : null
                    }
                    onAgent={chatAvailable ? reopenChat : null}
                    // The console's Usage page, for whoever may read it (demo/install.js).
                    onUsage={demo?.usageHref ? () => leavePage(demo.usageHref) : null}
                    onClose={closeTry}
                  />
                ) : null}
                {comparePair && changedOnly && compareData && !layoutPages.length ? (
                  <p className="absolute inset-x-0 top-1/3 mx-auto w-max max-w-[90%] rounded-lg bg-surface px-4 py-3 text-sm text-muted shadow-pop">
                    No visual changes between these two environments.
                  </p>
                ) : null}
                <ToolDock touch={!wide}>
                  <BoardToast toast={toast} setToast={setToast} onHold={holdToast} wide={wide} />
                  {builder ? (
                    <JourneyBuilder
                      draft={builder}
                      pages={data?.board?.pages || []}
                      onChange={setBuilder}
                      onSave={saveBuilder}
                      onCancel={() => setBuilder(null)}
                      pageTitle={(pageId) => findPage(pageId)?.title || pageId}
                      busy={busy}
                      touch={!wide}
                    />
                  ) : journey && !drawingOn ? (
                    <JourneyBar
                      key={journey.id}
                      journey={journey}
                      route={route}
                      step={step}
                      pageTitle={(pageId) => findPage(pageId)?.title || pageId}
                      onStep={goStep}
                      onChoose={chooseJourneyBranch}
                      onClose={closeJourney}
                      onEdit={() => startBuilder(journey)}
                      onDelete={removeJourney}
                      canEdit={canEditJourneys && journey.source === 'board'}
                      busy={busy}
                      touch={!wide}
                    />
                  ) : null}
                  {toolNote === 'drawing' ? (
                    <DrawingBar titleFor={(pageId, viewport) => `${targetTitle(pageId)} · ${viewportLabel(viewport)}`} />
                  ) : toolNote && !phoneCovered ? (
                    <ToolNote
                      wide={wide}
                      composing={toolNote === 'composing' ? { target: draftTarget, onCancel: () => (busy ? null : setDraft(null)) } : null}
                      picking={
                        toolNote === 'picking'
                          ? {
                              live: commentTarget ? readyKeys.has(commentTarget.key) : readyKeys.size > 0,
                              draw: drawArmed,
                              page: commentTarget
                                ? {
                                    key: commentTarget.key,
                                    title: targetTitle(splitFrameKey(commentTarget.key).targetId),
                                    keyboard: commentTarget.keyboard,
                                  }
                                : null,
                            }
                          : null
                      }
                      selectText={
                        toolNote === 'text'
                          ? {
                              title: `${targetTitle(splitFrameKey(selectingKey).targetId)} · ${viewportLabel(splitFrameKey(selectingKey).viewport)}`,
                              onDone: () => setSelectingKey(null),
                            }
                          : null
                      }
                      onDone={() => setCommentMode(false)}
                    />
                  ) : null}
                  {toolsShown ? (
                    <BoardTools tools={tools} active={activeTool} onTool={pickTool} touch={!wide} shift={toolsPlace.shift} />
                  ) : toolsOffered && !wide ? (
                    // Under a sheet or the keyboard: the room stays, so a toast keeps its place above the sheet's own controls.
                    <div className="h-[52px] shrink-0" aria-hidden="true" />
                  ) : null}
                </ToolDock>
              </div>
              <SidePanel
                wide={wide}
                checksOpen={checksOpen}
                checksProps={checksProps}
                chatThread={chatThread}
                chatProps={chatProps}
                panelHidden={panelHidden}
                panelProps={panelProps}
                updateParams={updateParams}
                hostedAgent={hostedAgentOpen ? hostedAgentProps : null}
              />
            </div>
          </div>
        </div>
        <AppUpdates ref={updates} />
      </div>

      {!wide ? (
        <>
          <PhoneSheets
            hostedAgent={hostedAgentSheet ? hostedAgentProps : null}
            checksOpen={checksOpen}
            closeChecks={closeChecks}
            checksProps={checksProps}
            chatAvailable={chatAvailable}
            chatThread={chatThread}
            chatProps={chatProps}
            updateParams={updateParams}
            sheetOpen={sheetOpen}
            setSheetOpen={setSheetOpen}
            panelProps={panelProps}
            threadSheet={threadSheet}
            threadProps={threadProps}
            closeThread={closeThread}
            selectedComment={selectedComment}
            targetTitle={targetTitle}
            draft={draft}
            busy={busy}
            setDraft={setDraft}
            draftDescription={draftDescription}
            composerProps={composerProps}
            startDraw={sheetDraw}
          />
          <BoardMenu
            {...barProps}
            // The Agents entry leads to the chat on a hosted board.
            chatAvailable={hostedAgent ? false : chatAvailable}
            menuOpen={menuOpen}
            hostedAgents={hostedAgent ? { open: openHostedAgent, list: agentList } : null}
          />
        </>
      ) : null}

      {batchFixes.offered ? (
        <BatchConfirm
          open={Boolean(batchConfirm)}
          onClose={() => {
            setBatchConfirm(null)
            batchFixes.setError(null)
          }}
          ids={batchConfirm || []}
          comments={comments}
          max={batchFixes.max}
          agentName={batchProps.agentName}
          targetTitle={targetTitle}
          busy={batchFixes.busy}
          error={batchFixes.error}
          touch={!wide}
          onStart={async (ids) => {
            if (await batchFixes.start(ids)) setBatchConfirm(null)
          }}
        />
      ) : null}
      <BoardDialogs
        info={info}
        boardId={boardId}
        boards={boards}
        wide={wide}
        shareOpen={shareOpen}
        setShareOpen={setShareOpen}
        refetchView={refetchView}
        settingsAvailable={settingsAvailable}
        settingsOpen={settingsOpen}
        updateParams={updateParams}
        onInfoChanged={onInfoChanged}
        generalSettingsOpen={generalSettingsOpen}
        updates={updates}
        historyPage={historyPage}
        closeHistory={closeHistory}
        historyViewport={historyViewport}
        historyPageId={historyPageId}
        data={data}
        comments={comments}
        filter={filter}
        focusComment={focusComment}
        onImageError={onImageError}
        captureConfirm={captureConfirm}
        setCaptureConfirm={setCaptureConfirm}
        busy={busy}
        focusedPage={focusedPage}
        findPage={findPage}
        startCapture={startCapture}
      />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        groups={groupedPages}
        journeys={journeys}
        canEditJourneys={canEditJourneys}
        comments={comments}
        titleOf={targetTitle}
        actions={paletteActions}
        onPage={(pageId) => {
          markPicked()
          jumpToPage(pageId)
        }}
        onJourney={(id) => {
          markPicked()
          openJourney(id)
        }}
        onNewJourney={() => {
          markPicked()
          startBuilder()
        }}
        onComment={(comment) => {
          markPicked()
          focusComment(comment)
        }}
        onCloseAutoFocus={backToCanvas}
      />
    </BoardProviders>
  )
}

// The board's context for its nodes, and its people for mentions.
function BoardProviders({ board, view, people, children }) {
  return (
    <BoardContext.Provider value={board}>
      <BoardViewContext.Provider value={view}>
        <BoardPeople.Provider value={people}>{children}</BoardPeople.Provider>
      </BoardViewContext.Provider>
    </BoardContext.Provider>
  )
}
