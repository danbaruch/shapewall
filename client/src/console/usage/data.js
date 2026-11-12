// The Usage and Activity pages' data layer: TanStack Query over the console
// API, and the page's state kept in the address.
//
// Everything a page shows follows from its address: the period, the filters,
// the chart's switches, the table's sort, columns and open row. So a link is
// a view, Back undoes a filter, and a saved view is just a query string. The
// server scopes every query to what its reader may see, so a link never
// shows more to the person who opens it.

import { useCallback, useMemo } from 'react'
import { QueryClient, keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, wsUrl } from '../lib/api'
import { currentSearch, setSearch as replaceSearch, useSearch } from '../lib/router'
import { periodOf, zone } from './format'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      // A refused request (no access, a bad filter) is an answer, not a blip.
      retry: (count, error) => count < 1 && (!error?.status || error.status >= 500),
    },
  },
})

// ---- The address ----

export { useSearch }
// Replaces (or with `push`, adds to the history) the query string of this page.
export const setSearch = (params, options) => replaceSearch(params.toString(), options)

// The address as an object, with one setter: set({ key: value }) replaces
// keys (null, '' or an empty list removes one). List values are comma lists.
export function useAddress() {
  const search = useSearch()
  const params = useMemo(() => new URLSearchParams(search), [search])
  const get = useCallback((key, fallback = '') => params.get(key) ?? fallback, [params])
  const list = useCallback((key) => (params.get(key) ? params.get(key).split(',').filter(Boolean) : []), [params])
  const set = useCallback((changes, options) => {
    const next = new URLSearchParams(currentSearch())
    for (const [key, value] of Object.entries(changes)) {
      const text = Array.isArray(value) ? value.join(',') : value
      if (text === null || text === undefined || text === '' || text === false) next.delete(key)
      else next.set(key, String(text))
    }
    setSearch(next, options)
  }, [])
  return { params, search, get, list, set }
}

// The filter keys of the Usage pages, as the address and the API name them.
export const FILTER_KEYS = ['agent', 'project', 'person', 'kind', 'model', 'outcome']
export const RANGE_KEYS = ['tokensMin', 'tokensMax', 'durationMin', 'durationMax']
// What a saved view keeps: everything but the open row.
export const VIEW_SKIP = ['row']

// The period and filters of the address, as API parameters.
export function useUsageFilter() {
  const address = useAddress()
  const { params } = address
  const period = useMemo(() => periodOf({ range: params.get('range') || '30d', from: params.get('from'), to: params.get('to') }), [params])
  const query = useMemo(() => {
    const out = new URLSearchParams()
    out.set('from', period.from.toISOString())
    out.set('to', period.to.toISOString())
    out.set('tz', zone())
    for (const key of [...FILTER_KEYS, ...RANGE_KEYS, 'q']) if (params.get(key)) out.set(key, params.get(key))
    return out.toString()
  }, [params, period])
  const active = [...FILTER_KEYS, ...RANGE_KEYS, 'q'].filter((key) => params.get(key))
  return { ...address, period, query, active }
}

// ---- Queries ----

const fetcher = (url) => () => api.get(url)
// One GET of the workspace's console API, cached by its address. While a
// refetch runs the previous answer stays on screen (charts keep their frame).
export function useWs(workspaceId, path, { enabled = true, keep = true } = {}) {
  const url = wsUrl(workspaceId, path)
  return useQuery({ queryKey: [url], queryFn: fetcher(url), enabled, placeholderData: keep ? keepPreviousData : undefined })
}
// Pages of a list that hands out a cursor: `next(page)` reads it.
export function useWsPages(workspaceId, pathFor, { next, enabled = true, key }) {
  return useInfiniteQuery({
    queryKey: [wsUrl(workspaceId, pathFor(null)), ...(key || [])],
    queryFn: ({ pageParam }) => api.get(wsUrl(workspaceId, pathFor(pageParam))),
    initialPageParam: null,
    getNextPageParam: (page) => next(page) ?? undefined,
    enabled,
    placeholderData: keepPreviousData,
  })
}

// A person's saved views on a page, with save and remove.
export function useViews(workspaceId, page) {
  const client = useQueryClient()
  const url = wsUrl(workspaceId, `/views?page=${page}`)
  const views = useQuery({ queryKey: [url], queryFn: fetcher(url) })
  const refresh = () => client.invalidateQueries({ queryKey: [url] })
  const save = useMutation({ mutationFn: (view) => api.post(wsUrl(workspaceId, '/views'), { page, ...view }), onSuccess: refresh })
  const remove = useMutation({ mutationFn: (id) => api.delete(wsUrl(workspaceId, `/views/${id}`)), onSuccess: refresh })
  return { views: views.data?.views || [], loading: views.isLoading, save, remove }
}
