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
import { leavePage } from '../../lib/hooks'
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
// Replaces (or with `push`, adds to the history) the query string of this
// page. A menu or a select that is closing goes Back over its own history
// entry first; the change waits for that to land (lib/hooks.js leavePage).
export const setSearch = (params, options) => leavePage(() => replaceSearch(params.toString(), options))

// The address as an object, with one setter: set({ key: value }) replaces
// keys (null, '' or an empty list removes one). A list is the key repeated
// (agent=a&agent=b), so a value may hold any character: a model's name has
// commas and brackets. Older links with comma lists of ids still read.
export function useAddress() {
  const search = useSearch()
  const params = useMemo(() => new URLSearchParams(search), [search])
  const get = useCallback((key, fallback = '') => params.get(key) ?? fallback, [params])
  const list = useCallback(
    (key) =>
      params
        .getAll(key)
        .flatMap((value) => (UNSPLIT.includes(key) ? [value] : value.split(',')))
        .filter(Boolean),
    [params],
  )
  const set = useCallback((changes, options) => {
    // Read when the change lands, so two changes in a row both hold.
    leavePage(() => {
      const next = new URLSearchParams(currentSearch())
      for (const [key, value] of Object.entries(changes)) {
        next.delete(key)
        for (const item of Array.isArray(value) ? value : [value])
          if (item !== null && item !== undefined && item !== '' && item !== false) next.append(key, String(item))
      }
      replaceSearch(next.toString(), options)
    })
  }, [])
  return { params, search, get, list, set }
}

// Filters whose values are never split on commas (whatever an agent called its model).
const UNSPLIT = ['model']
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
    // What to compare with: the page says, so "this month" compares with last month.
    out.set('prevFrom', period.previous.from.toISOString())
    out.set('prevTo', period.previous.to.toISOString())
    out.set('tz', zone())
    for (const key of FILTER_KEYS)
      for (const value of params.getAll(key).flatMap((item) => (UNSPLIT.includes(key) ? [item] : item.split(','))))
        if (value) out.append(key, value)
    for (const key of [...RANGE_KEYS, 'q']) if (params.get(key)) out.set(key, params.get(key))
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
