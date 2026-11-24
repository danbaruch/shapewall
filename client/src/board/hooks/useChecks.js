import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { STATIC, api } from '../../lib/api'
import { useResource } from '../../lib/hooks'

export const CHECKS_TABS = ['issues', 'pages', 'seo', 'performance', 'history']
const tabParam = (tab) => (CHECKS_TABS.includes(tab) && tab !== 'issues' ? tab : null)

// Checks from the URL (`checks` = a page id or `all`, `cv`, `ce`, `ct` = the
// panel tab), their results from the server, the actionable count per page,
// the local search previews and a checks run started from the board.
// `checksPanelProps` are the ChecksPanel props this hook owns; the board
// spreads them into the panel's props.
export function useChecks({ boardId, info, params, updateParams, pages }) {
  const canChecks = Boolean(info?.checksAvailable)
  const checksOpen = canChecks && Boolean(params.get('checks'))
  const checksPage = pages?.some((p) => p.id === params.get('checks')) ? params.get('checks') : null
  const checksViewport = params.get('cv') || null
  const checksTab = CHECKS_TABS.includes(params.get('ct')) ? params.get('ct') : 'issues'
  const checksEnvironment = /^[a-z0-9][a-z0-9-]{0,63}$/.test(params.get('ce') || '') ? params.get('ce') : null
  const base = `/api/boards/${encodeURIComponent(boardId)}/checks`
  const envQuery = checksEnvironment ? `?env=${encodeURIComponent(checksEnvironment)}` : ''
  const checksQuery = useResource(canChecks ? `${base}${envQuery}` : null, { pollMs: STATIC ? 0 : 30000 })
  // Search previews live only on the installation that ran the checks; a
  // hosted board or an export has none and the SEO tab shows issues only.
  const seoQuery = useResource(canChecks && checksOpen && !STATIC ? `${base}/seo${envQuery}` : null)
  // Only a local board can start a run; hosted boards never execute checks.
  const local = canChecks && !STATIC && !info?.hosted
  const [runPolling, setRunPolling] = useState(false)
  const runQuery = useResource(local && checksOpen ? `${base}/run` : null, { pollMs: runPolling ? 1500 : 0 })
  const run = runQuery.data?.run || null
  const running = run?.state === 'running'
  useEffect(() => setRunPolling(running), [running])
  // When a run finishes, show its reports.
  const wasRunning = useRef(false)
  const { refetch: refetchChecks } = checksQuery
  const { refetch: refetchSeo } = seoQuery
  useEffect(() => {
    if (wasRunning.current && !running) {
      refetchChecks()
      refetchSeo()
    }
    wasRunning.current = running
  }, [running, refetchChecks, refetchSeo])
  const [runError, setRunError] = useState(null)
  const [starting, setStarting] = useState(false)
  const startRun = useCallback(
    async ({ pages: only = null, seo = true } = {}) => {
      setStarting(true)
      setRunError(null)
      try {
        await api.post(`${base}/run`, { seo, ...(only ? { pages: only } : {}), ...(checksEnvironment ? { env: checksEnvironment } : {}) })
        setRunPolling(true)
        await runQuery.refetch()
        return true
      } catch (error) {
        setRunError(error.message || 'The checks run did not start.')
        runQuery.refetch()
        return false
      } finally {
        setStarting(false)
      }
    },
    [base, checksEnvironment, runQuery],
  )
  const [stopping, setStopping] = useState(false)
  const stopRun = useCallback(async () => {
    setStopping(true)
    setRunError(null)
    try {
      await api.delete(`${base}/run`)
    } catch (error) {
      setRunError(error.message || 'The checks run could not be stopped.')
    } finally {
      setStopping(false)
      runQuery.refetch()
    }
  }, [base, runQuery])
  const openChecks = useCallback(
    (pageId = null, viewport = null, tab = null) =>
      updateParams({ checks: pageId || 'all', cv: viewport, chat: null, ...(tab ? { ct: tabParam(tab) } : {}) }),
    [updateParams],
  )
  const setChecksTab = useCallback((tab) => updateParams({ ct: tabParam(tab) }), [updateParams])
  const closeChecks = useCallback(() => updateParams({ checks: null, cv: null, ct: null }), [updateParams])
  // Actionable checks per page, counted once per checks response (each page
  // card asks for its own count).
  const checksCounts = useMemo(() => {
    const counts = new Map()
    for (const v of checksQuery.data?.views || []) {
      if (['stale', 'failed'].includes(v.state)) continue
      const n = v.runs?.reduce((sum, r) => sum + (r.state === 'stale' ? 0 : r.actionable), 0) ?? v.actionable
      counts.set(v.pageId, (counts.get(v.pageId) || 0) + n)
    }
    return counts
  }, [checksQuery.data])
  const checksRun = local
    ? {
        loading: runQuery.loading,
        canRun: Boolean(runQuery.data?.canRun),
        reason: runQuery.data?.reason || null,
        limit: runQuery.data?.limit || 100,
        privatePages: runQuery.data?.privatePages || [],
        seoDefault: runQuery.data?.seoDefault !== false,
        run,
        starting,
        error: runError,
        start: startRun,
        stop: stopRun,
        stopping,
      }
    : null
  // The terminal command for what the panel shows; SEO on in the SEO tab.
  const command = [
    'shapewall checks run',
    `--board ${boardId}`,
    checksPage ? `--only ${checksPage}` : null,
    checksEnvironment ? `--env ${checksEnvironment}` : null,
    checksTab === 'seo' ? '--seo' : null,
    '--limit 100',
  ]
    .filter(Boolean)
    .join(' ')
  const checksPanelProps = {
    tab: checksTab,
    onTab: setChecksTab,
    seo: seoQuery.error ? null : seoQuery.data,
    run: checksRun,
    command,
  }
  return {
    canChecks,
    checksOpen,
    checksPage,
    checksViewport,
    checksEnvironment,
    checksTab,
    setChecksTab,
    checksQuery,
    seoQuery,
    checksRun,
    checksPanelProps,
    openChecks,
    closeChecks,
    checksCounts,
  }
}
