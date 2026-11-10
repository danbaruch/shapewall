import { useMemo } from 'react'
import { useResource } from '../../lib/hooks'

// Compare mode from the URL (`cmp=a_b`, `changed`, `diff`): the two
// environments, their comparison from the server and what the cards need.
// Boards this big open compare on "Changed pages only" (`changed=0` shows all).
export const CHANGED_ONLY_MIN_PAGES = 30

export function useCompare({ boardId, params, updateParams, environmentList, setCommentMode, pageCount = 0 }) {
  const environments = useMemo(() => (Array.isArray(environmentList) ? environmentList : []), [environmentList])
  const comparePair = useMemo(() => {
    const [a, b] = String(params.get('cmp') || '').split('_')
    const ids = environments.map((env) => env.id)
    return a && b && a !== b && ids.includes(a) && ids.includes(b) ? [a, b] : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('cmp'), environments])
  const changedParam = params.get('changed')
  const changedDefault = pageCount >= CHANGED_ONLY_MIN_PAGES
  const changedOnly = Boolean(comparePair) && (changedParam === '1' || (changedParam !== '0' && changedDefault))
  // The URL keeps `changed` only when it differs from the board's default.
  const setChangedOnly = (value) => updateParams({ changed: value === changedDefault ? null : value ? '1' : '0' })
  const showDiff = params.get('diff') !== 'off'
  const compareQuery = useResource(
    comparePair ? `/api/boards/${encodeURIComponent(boardId)}/compare?a=${comparePair[0]}&b=${comparePair[1]}` : null,
  )
  const compareData =
    comparePair && compareQuery.data?.a === comparePair[0] && compareQuery.data?.b === comparePair[1] ? compareQuery.data : null
  const compareView = useMemo(() => {
    if (!comparePair) return null
    const [a, b] = comparePair
    const byId = new Map(environments.map((env) => [env.id, env]))
    const defaultId = environments.find((env) => env.default)?.id
    return {
      a,
      b,
      files: compareData?.files || {},
      failures: compareData?.failures || {},
      pages: compareData?.pages || {},
      showDiff,
      kindOf: (env) => (env === defaultId ? 'captures' : `envs/${env}`),
      versionOf: (env) => byId.get(env)?.capturedAt || 'none',
      titleOf: (env) => byId.get(env)?.title || env,
      diffKind: `diffs/${a}_${b}`,
      diffVersion: `${byId.get(a)?.capturedAt}|${byId.get(b)?.capturedAt}`,
    }
  }, [compareData, comparePair, environments, showDiff])
  const setCompare = (pair) => {
    setCommentMode(false)
    updateParams({
      cmp: pair ? pair.join('_') : null,
      changed: pair ? params.get('changed') : null,
      diff: pair ? params.get('diff') : null,
    })
  }
  const canCompare = environments.length > 1
  const toggleCompare = () => setCompare(comparePair ? null : [environments[0].id, environments[1].id])
  return {
    environments,
    comparePair,
    changedOnly,
    setChangedOnly,
    showDiff,
    compareQuery,
    compareData,
    compareView,
    setCompare,
    canCompare,
    toggleCompare,
  }
}
