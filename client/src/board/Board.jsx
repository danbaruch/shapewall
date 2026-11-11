import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Background, ReactFlow, useNodesInitialized, useNodesState, useReactFlow } from '@xyflow/react'
import { BROWSER_COMMENTS, fileUrl, STATIC } from '../lib/api'
import { resetBrowserComments } from '../lib/browserComments'
import { useMediaQuery, useOverlayEntry, useParams, useResource } from '../lib/hooks'
import { cn, savedAuthor } from '../lib/utils'
import { Spinner } from '../components/ui'
import { BoardContext, NODE_TYPES } from './nodes'
import { EDGE_TYPES } from './edges'
import { layoutBoard, nativeSize, pinPoint } from './layout'
import { cardKeyDown, useCanvasNavigation } from './navigation'
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
import { threadForComment } from '../chat/threads'
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
import { minimapDefault, minimapSaved, rememberMinimap, rememberTipDismissed, tipDismissed } from './prefs'
import { CommandPalette } from './PageFinder'
import { useSidebarExpanded } from '../components/app-rail'
import { BrokenLinks } from './BrokenLinks'
import { BoardToolbar } from './BoardToolbar'
import { BoardMenu } from './BoardMenu'
import { CanvasNotes } from './CanvasNotes'
import { DrawingMode, useDrawingMode } from './DrawingMode'
import { drawing } from './drawing'
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
import { useFlyToPending, usePhoneStartView, useRefitOnChange } from './hooks/useCameraMoves'
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
  const focusedCommentId = focusEntry && ['working', 'waiting'].includes(focusEntry.state) ? Number(focusEntry.commentId) || null : null
  const agentFocus = useMemo(() => (focusedCommentId ? new Set([focusedCommentId]) : NO_IDS), [focusedCommentId])
  const [busy, setBusy] = useState(false)
  const [pendingFocus, setPendingFocus] = useState(null)
  const [hoverPage, setHoverPage] = useState(null)
  const [builder, setBuilder] = useState(null)
  // Opening a comment on the other viewport switches the viewport: said out loud.
  const [viewportNotice, setViewportNotice] = useState(null)
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
      threadFromList.current = false
      setDraft(null)
      updateParams({ c: comment.id })
      if (!wide) {
        setSheetOpen(false)
        setThreadSheet(true)
      }
    },
    [updateParams, wide],
  )
  const closeThread = useCallback(() => {
    setThreadSheet(false)
    updateParams({ c: null })
    if (threadFromList.current && !wide) setSheetOpen(true)
    threadFromList.current = false
  }, [updateParams, wide])

  // Pan to a comment's pin, switching viewport first when it is not on screen.
  // The switch is said out loud (a note with a way back, the toggle flashes),
  // so the board never changes viewport behind the user's back. On a phone
  // the list closes and the comment shows as a card at its pin; Back returns
  // to the list.
  const focusComment = useCallback(
    (comment) => {
      const switching = mode !== 'all' && comment.viewport !== mode && Boolean(viewports[comment.viewport])
      setDraft(null)
      setPendingFocus(comment)
      updateParams({ c: comment.id, ...(switching ? { vp: comment.viewport === defaultMode ? null : comment.viewport } : {}) })
      if (switching) setViewportNotice({ from: mode, to: comment.viewport, id: comment.id, at: Date.now() })
      if (!wide) {
        setSheetOpen(false)
        setThreadSheet(true)
      }
    },
    [defaultMode, mode, updateParams, viewports, wide],
  )
  useEffect(() => {
    if (!viewportNotice) return undefined
    const timer = window.setTimeout(() => setViewportNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [viewportNotice])
  useFlyToPending({ pendingFocus, setPendingFocus, targets: layout.targets, viewports, flow, canvasRef, wide, setSettledZoom })
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

  // ---- Journeys ------------------------------------------------------------
  const { openJourney, closeJourney, goStep, chooseJourneyBranch, startBuilder, addBuilderStep, saveBuilder, removeJourney } =
    useJourneyActions({
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

  const jumpToPage = (pageId) => {
    const target = layout.targets[pageId]
    if (!target) return
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
    // For the actions, read when one runs.
    selectedCommentId,
    closeThread,
    builder,
    addBuilderStep,
    layout,
    flow,
    canvasRef,
    setSettledZoom,
    setFocusedKey,
    setToast,
    setDraft,
    draftFilled,
    checkDraft,
    setCheckDraft,
    authorName,
    selectComment,
    openCluster,
    openChecks,
    openHistory,
    updateParams,
    defaultMode,
    onImageError,
  })

  const { commentsUrl, applyComment, setStatus, replyTo, editComment, reactTo, copyLink, githubIssue, removeComment, sendToAgent } =
    useCommentActions({
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
  const navigation = useCanvasNavigation({ canvasRef, flow, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, onRest: cameraRested })
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

  useCommentModeKeys({ commentMode, setCommentMode, canComment, comparePair, setDraft })
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

  // An open thread counts as read.
  useEffect(() => {
    if (selectedComment) markSeen(selectedComment)
  }, [markSeen, selectedComment])
  useEffect(() => {
    if (selectedComment) markTried('open')
    if (commentMode) markTried('comment')
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
    setViewportNotice(null)
    updateParams({ vp: value === defaultMode ? null : value })
  }
  const allOpen = comments.filter((item) => item.status === 'open').length
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
  // The step a comment is at, one at a time (data-sw-comment-state on the
  // canvas): drawing (a tool is on), composing (a target is picked, the
  // composer is open), picking (comment mode, nothing picked yet), else off.
  const commentState = drawingOn ? 'drawing' : draft && wide ? 'composing' : commentMode && canComment && !comparePair ? 'picking' : 'off'
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

  // Board actions in the command palette.
  const paletteActions = boardPaletteActions({
    canComment,
    comparePair,
    commentMode,
    markPicked,
    setDraft,
    setCommentMode,
    showLinks,
    toggleLinks,
    canCompare,
    toggleCompare,
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
    toggleCompare,
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
        {info?.hosted && data?.agentApprove ? <HostedApprovals boardId={boardId} /> : null}
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
              viewportNotice={viewportNotice}
              canComment={canComment}
              commentMode={commentMode}
              setCommentMode={setCommentMode}
              openPalette={() => setPaletteOpen(true)}
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
                className={cn('relative min-w-0 flex-1 outline-none', commentState === 'picking' && 'sw-commenting')}
                onKeyDown={onCanvasKeyDown}
                data-sw-canvas="true"
                data-sw-comment-state={commentState}
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
                    titleFor={(pageId, viewport) => `${targetTitle(pageId)} · ${viewportLabel(viewport)}`}
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
                    readyKeys={readyKeys}
                    setCommentMode={setCommentMode}
                    composing={commentState === 'composing' ? draftTarget : null}
                    onCancelDraft={() => (busy ? null : setDraft(null))}
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
                    viewportNotice={viewportNotice}
                    dismissTip={dismissTip}
                    modes={modes}
                    setMode={setMode}
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
                    zoomOnDoubleClick={!commentMode}
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
                      onHistory={openHistory}
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
                    />
                    {wide && draft && !modalOpen ? (
                      <ComposerPopover
                        point={pinPoint(layout.targets, draft)}
                        stowed={drawingOn}
                        onClose={() => (busy ? null : setDraft(null))}
                      >
                        <CommentComposer {...composerProps} touch={false} description={draftDescription} />
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
                      hideMinimap={Boolean(journey || builder)}
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
                    }}
                  />
                ) : null}
                {tryOpen && data && !journey && !builder && !drawingOn && !(commentMode && !wide) ? (
                  <TryThis
                    touch={!wide}
                    done={tryDone}
                    onOpenComment={() => {
                      const open = visibleComments.filter((item) => item.status === 'open')
                      const pick = open.find((item) => mode === 'all' || item.viewport === mode) || open[0] || visibleComments[0]
                      if (pick) focusComment(pick)
                    }}
                    onComment={
                      canComment && !comparePair
                        ? () => {
                            setDraft(null)
                            setCommentMode(true)
                          }
                        : null
                    }
                    onAgent={chatAvailable ? reopenChat : null}
                    onClose={closeTry}
                  />
                ) : null}
                <BoardToast toast={toast} setToast={setToast} onHold={holdToast} wide={wide} raised={Boolean(journey || builder)} />
                {comparePair && changedOnly && compareData && !layoutPages.length ? (
                  <p className="absolute inset-x-0 top-1/3 mx-auto w-max max-w-[90%] rounded-lg bg-surface px-4 py-3 text-sm text-muted shadow-pop">
                    No visual changes between these two environments.
                  </p>
                ) : null}
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
              />
            </div>
          </div>
        </div>
        <AppUpdates ref={updates} />
      </div>

      {!wide ? (
        <>
          <PhoneSheets
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
          />
          <BoardMenu {...barProps} menuOpen={menuOpen} />
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
