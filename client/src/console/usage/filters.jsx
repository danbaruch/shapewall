// The filter row of the Usage pages: the period first (presets before a
// custom range), then one picker per dimension, ranges, and a search over
// ids. One row above everything it scopes; every chart, tile and table below
// reads the same filter. Saved views sit at its end.

import { useEffect, useMemo, useState } from 'react'
import { Bookmark, CalendarDays, Check, ChevronDown, Link2, Search, SlidersHorizontal, Trash2, X } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../../components/ui'
import { useMediaQuery } from '../../lib/hooks'
import { cn } from '../../lib/utils'
import { DIMENSION_LABEL, KIND_LABEL, OUTCOME_GROUP_IDS, OUTCOME_GROUP_LABEL, USAGE_KINDS } from '../../../../src/hosted/usage-shape.js'
import { useToast } from '../state'
import { FILTER_KEYS, RANGE_KEYS, VIEW_SKIP, useViews } from './data'
import { PRESETS, dateInput, formatCount } from './format'

const chip =
  'inline-flex h-9 max-w-full items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium outline-none focus-visible:outline-2 focus-visible:outline-accent'
const chipOff = 'border-line bg-surface text-fg hover:bg-surface-2'
const chipOn = 'border-accent/50 bg-accent/10 text-fg'
// The empty value of a dimension (nobody asked, no model reported) in the address.
const toParam = (key) => (key === '' ? '~' : key)
const fromParam = (key) => (key === '~' ? '' : key)

export function PeriodPicker({ period, onChange }) {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  useEffect(() => {
    if (!open) return
    setFrom(dateInput(period.from))
    setTo(dateInput(new Date(period.to.getTime() - 86_400_000)))
  }, [open, period])
  const pick = (changes) => {
    onChange(changes)
    setOpen(false)
  }
  const valid = from && to && from <= to
  return (
    <Popover open={open} onOpenChange={setOpen} history={false}>
      <PopoverTrigger asChild>
        <button type="button" className={cn(chip, chipOff)} data-sw-period>
          <CalendarDays size={14} className="text-muted" aria-hidden="true" />
          <span className="truncate">{period.label}</span>
          <ChevronDown size={13} className="text-muted" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1.5">
        <ul role="listbox" aria-label="Period">
          {PRESETS.map(([id, label]) => (
            <li key={id}>
              <button
                type="button"
                role="option"
                aria-selected={period.range === id}
                onClick={() => pick({ range: id === '30d' ? null : id, from: null, to: null })}
                className="flex h-9 w-full items-center justify-between rounded-md px-2.5 text-sm text-fg outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
                data-sw-period-preset={id}
              >
                {label}
                {period.range === id ? <Check size={16} strokeWidth={3} className="text-accent" aria-hidden="true" /> : null}
              </button>
            </li>
          ))}
        </ul>
        <form
          className="mt-1.5 border-t border-line px-1 pt-2.5 pb-1"
          onSubmit={(event) => {
            event.preventDefault()
            if (valid) pick({ range: 'custom', from, to })
          }}
        >
          <p className="mb-1.5 flex items-center justify-between text-xs font-medium text-fg">
            Custom range
            {period.range === 'custom' ? <Check size={16} strokeWidth={3} className="text-accent" aria-hidden="true" /> : null}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-caption text-muted">
              From
              <Input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(event) => setFrom(event.target.value)}
                className="mt-0.5"
                data-sw-period-from
              />
            </label>
            <label className="text-caption text-muted">
              To
              <Input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(event) => setTo(event.target.value)}
                className="mt-0.5"
                data-sw-period-to
              />
            </label>
          </div>
          <Button type="submit" size="sm" variant="default" disabled={!valid} className="mt-2 w-full" data-sw-period-apply>
            Apply
          </Button>
          <p className="mt-1.5 text-caption text-muted">Days are in your time zone. Up to 400 days.</p>
        </form>
      </PopoverContent>
    </Popover>
  )
}

// One dimension: a list of what there is, with counts, several at once.
export function MultiFilter({ id, label, options, values, onChange }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const picked = new Set(values.map(fromParam))
  const shown = options.filter((option) => !text || option.label.toLowerCase().includes(text.toLowerCase()))
  const toggle = (key) => {
    const next = new Set(picked)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange([...next].map(toParam))
  }
  const first = options.find((option) => picked.has(option.key))
  return (
    <Popover open={open} onOpenChange={setOpen} history={false}>
      <PopoverTrigger asChild>
        <button type="button" className={cn(chip, picked.size ? chipOn : chipOff)} data-sw-filter={id}>
          <span className="truncate">
            {label}
            {picked.size ? `: ${first?.label || [...picked][0] || 'none'}${picked.size > 1 ? ` +${picked.size - 1}` : ''}` : ''}
          </span>
          <ChevronDown size={13} className="shrink-0 text-muted" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1.5">
        {options.length > 8 ? (
          <Input
            icon={Search}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={`Find ${label.toLowerCase()}`}
            aria-label={`Find ${label.toLowerCase()}`}
            className="mb-1"
          />
        ) : null}
        <ul className="max-h-64 overflow-y-auto" role="listbox" aria-label={label} aria-multiselectable="true">
          {shown.map((option) => (
            <li key={option.key}>
              <button
                type="button"
                role="option"
                aria-selected={picked.has(option.key)}
                onClick={() => toggle(option.key)}
                className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-fg outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
                data-sw-filter-option={toParam(option.key)}
              >
                <span
                  className={cn(
                    'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                    picked.has(option.key) ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong bg-surface',
                  )}
                  aria-hidden="true"
                >
                  {picked.has(option.key) ? <Check size={12} strokeWidth={3} /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  {option.hint ? <span className="block truncate text-caption text-muted">{option.hint}</span> : null}
                </span>
                {option.calls !== undefined ? <span className="tabular text-xs text-muted">{formatCount(option.calls)}</span> : null}
              </button>
            </li>
          ))}
          {!shown.length ? <li className="px-2 py-3 text-center text-xs text-muted">Nothing matches.</li> : null}
        </ul>
        {picked.size ? (
          <div className="mt-1 border-t border-line pt-1">
            <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => onChange([])}>
              <X size={13} aria-hidden="true" /> Clear
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

// Tokens and duration, each from and to.
function RangeFilter({ get, set }) {
  const [open, setOpen] = useState(false)
  const read = () => ({
    tokensMin: get('tokensMin'),
    tokensMax: get('tokensMax'),
    // The address keeps milliseconds; people type seconds.
    durationMin: get('durationMin') ? String(Number(get('durationMin')) / 1000) : '',
    durationMax: get('durationMax') ? String(Number(get('durationMax')) / 1000) : '',
  })
  const [draft, setDraft] = useState(read)
  useEffect(() => {
    if (open) setDraft(read())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const active = RANGE_KEYS.filter((key) => get(key)).length
  const number = (text, scale = 1) =>
    text !== '' && Number.isFinite(Number(text)) && Number(text) >= 0 ? String(Math.round(Number(text) * scale)) : null
  const apply = (event) => {
    event.preventDefault()
    set({
      tokensMin: number(draft.tokensMin),
      tokensMax: number(draft.tokensMax),
      durationMin: number(draft.durationMin, 1000),
      durationMax: number(draft.durationMax, 1000),
    })
    setOpen(false)
  }
  const field = (key, label) => (
    <label className="text-caption text-muted">
      {label}
      <Input
        type="number"
        min="0"
        inputMode="numeric"
        value={draft[key]}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
        className="mt-0.5"
        data-sw-range={key}
      />
    </label>
  )
  return (
    <Popover open={open} onOpenChange={setOpen} history={false}>
      <PopoverTrigger asChild>
        <button type="button" className={cn(chip, active ? chipOn : chipOff)} data-sw-filter="ranges">
          <SlidersHorizontal size={14} className="text-muted" aria-hidden="true" />
          Ranges{active ? `: ${active}` : ''}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3">
        <form onSubmit={apply} className="space-y-3">
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-fg">Tokens (input plus output)</legend>
            <div className="grid grid-cols-2 gap-2">
              {field('tokensMin', 'At least')}
              {field('tokensMax', 'At most')}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-fg">Duration, in seconds</legend>
            <div className="grid grid-cols-2 gap-2">
              {field('durationMin', 'At least')}
              {field('durationMax', 'At most')}
            </div>
          </fieldset>
          <p className="text-caption text-muted">A range leaves out turns that did not report the number.</p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="default" className="flex-1" data-sw-range-apply>
              Apply
            </Button>
            {active ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  set(Object.fromEntries(RANGE_KEYS.map((key) => [key, null])))
                  setOpen(false)
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}

function IdSearch({ value, onChange }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  // Search as you type, without a request per key.
  useEffect(() => {
    if (text.trim() === value) return undefined
    const timer = window.setTimeout(() => onChange(text.trim()), 350)
    return () => window.clearTimeout(timer)
  }, [text, value, onChange])
  return (
    <Input
      icon={Search}
      value={text}
      onChange={(event) => setText(event.target.value)}
      placeholder="Search ids"
      aria-label="Search by an id: a turn, an agent, a project, a board or a comment number"
      maxLength={80}
      wrapperClassName="w-full sm:w-44"
      className="h-9"
      data-sw-usage-search
    />
  )
}

// What the pickers offer, from /usage/options, with the fixed lists filled in.
export function useFilterOptions(options) {
  return useMemo(() => {
    const of = (dimension) => options?.[dimension] || []
    return {
      agent: of('agent').map((item) => ({ key: item.key, label: item.label, hint: item.machine || null, calls: item.calls })),
      project: of('project').map((item) => ({ key: item.key, label: item.label, calls: item.calls })),
      person: of('person').map((item) => ({
        key: item.key,
        label: item.label,
        hint: item.handle ? `@${item.handle}` : null,
        calls: item.calls,
      })),
      model: of('model').map((item) => ({ key: item.key, label: item.label, calls: item.calls })),
      kind: USAGE_KINDS.map((key) => ({ key, label: KIND_LABEL[key], calls: of('kind').find((item) => item.key === key)?.calls })),
      outcome: OUTCOME_GROUP_IDS.map((key) => ({
        key,
        label: OUTCOME_GROUP_LABEL[key],
        calls: of('outcome').find((item) => item.key === key)?.calls,
      })),
    }
  }, [options])
}

export function FilterBar({ filter, options, children }) {
  const { period, get, list, set, active } = filter
  const lists = useFilterOptions(options)
  const phone = useMediaQuery('(max-width: 639px)')
  const labelOf = (dimension, key) =>
    lists[dimension].find((option) => option.key === fromParam(key))?.label || (key === '~' ? 'None' : key)
  const chips = []
  for (const dimension of FILTER_KEYS)
    for (const key of list(dimension))
      chips.push({
        id: `${dimension}:${key}`,
        text: `${DIMENSION_LABEL[dimension]}: ${labelOf(dimension, key)}`,
        clear: () => set({ [dimension]: list(dimension).filter((item) => item !== key) }, { push: true }),
      })
  for (const key of RANGE_KEYS)
    if (get(key)) {
      const duration = key.startsWith('duration')
      const text = `${duration ? 'Duration' : 'Tokens'} ${key.endsWith('Min') ? 'at least' : 'at most'} ${duration ? `${Number(get(key)) / 1000} s` : formatCount(Number(get(key)), { exact: true })}`
      chips.push({ id: key, text, clear: () => set({ [key]: null }, { push: true }) })
    }
  if (get('q')) chips.push({ id: 'q', text: `Id contains "${get('q')}"`, clear: () => set({ q: null }, { push: true }) })
  return (
    <div className="mb-4 print:hidden" data-sw-usage-filters>
      {/* On a phone the pickers are one row that scrolls sideways; the search and the views sit under it. */}
      <div className="sw-scroll-x -mx-3 flex items-center gap-1.5 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 [&>*]:shrink-0">
        <PeriodPicker period={period} onChange={(changes) => set(changes, { push: true })} />
        {FILTER_KEYS.map((dimension) => (
          <MultiFilter
            key={dimension}
            id={dimension}
            label={DIMENSION_LABEL[dimension]}
            options={lists[dimension]}
            values={list(dimension)}
            onChange={(values) => set({ [dimension]: values }, { push: true })}
          />
        ))}
        <RangeFilter get={get} set={(changes) => set(changes, { push: true })} />
        {phone ? null : (
          <>
            <IdSearch value={get('q')} onChange={(text) => set({ q: text || null })} />
            <span className="ml-auto flex items-center gap-1.5">{children}</span>
          </>
        )}
      </div>
      {phone ? (
        <div className="mt-1.5 flex items-center gap-1.5">
          <IdSearch value={get('q')} onChange={(text) => set({ q: text || null })} />
          <span className="flex shrink-0 items-center gap-1.5">{children}</span>
        </div>
      ) : null}
      {chips.length ? (
        <ul className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Filters in effect" data-sw-usage-chips>
          {chips.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={item.clear}
                className="inline-flex h-7 max-w-[16rem] items-center gap-1 rounded-full border border-line bg-surface-2 pr-1.5 pl-2.5 text-xs text-fg outline-none hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent"
                aria-label={`Remove the filter ${item.text}`}
                data-sw-chip={item.id}
              >
                <span className="truncate">{item.text}</span>
                <X size={12} className="shrink-0 text-muted" aria-hidden="true" />
              </button>
            </li>
          ))}
          <li>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => set(Object.fromEntries(active.map((key) => [key, null])), { push: true })}
              data-sw-usage-clear
            >
              Clear all
            </Button>
          </li>
        </ul>
      ) : null}
    </div>
  )
}

// A person's saved views of a page: open one, save the address as one,
// remove one, or copy the address as a link. A view is the page's query
// string; whoever opens the link sees what they themselves may see.
export function ViewsMenu({ workspaceId, page, search, onOpen }) {
  const { views, save, remove } = useViews(workspaceId, page)
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const current = useMemo(() => {
    const params = new URLSearchParams(search)
    for (const key of VIEW_SKIP) params.delete(key)
    return params.toString()
  }, [search])
  const active = views.find((view) => view.query === current)
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}${current ? `?${current}` : ''}`)
      toast('Link copied. It carries the filters, not your access.')
    } catch {
      toast('This browser did not allow copying', 'bad')
    }
  }
  const submit = async (event) => {
    event.preventDefault()
    try {
      await save.mutateAsync({ name, query: current })
      toast(`Saved the view "${name.trim()}"`)
      setNaming(false)
      setName('')
    } catch (error) {
      toast(error.message, 'bad')
    }
  }
  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn(chip, active ? chipOn : chipOff)} data-sw-views>
            <Bookmark size={14} className="text-muted" aria-hidden="true" />
            <span className="max-w-[9rem] truncate">{active ? active.name : 'Views'}</span>
            <ChevronDown size={13} className="text-muted" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64">
          <DropdownMenuLabel>Your saved views</DropdownMenuLabel>
          {views.length ? (
            views.map((view) => (
              <div key={view.id} className="flex items-center">
                <DropdownMenuItem className="min-w-0 flex-1" onSelect={() => onOpen(view.query)} data-sw-view={view.name}>
                  <span className="truncate">{view.name}</span>
                  {active?.id === view.id ? <Check size={14} className="ml-auto text-accent" aria-hidden="true" /> : null}
                </DropdownMenuItem>
                <button
                  type="button"
                  aria-label={`Delete the view ${view.name}`}
                  onClick={() => remove.mutate(view.id)}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted outline-none hover:bg-surface-2 hover:text-bad focus-visible:outline-2 focus-visible:outline-accent"
                  data-sw-view-delete={view.name}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </div>
            ))
          ) : (
            <p className="px-2.5 pb-1.5 text-xs text-muted">None yet. Set the filters you want, then save them here.</p>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setNaming(true)} data-sw-view-save>
            <Bookmark size={14} aria-hidden="true" /> Save this view
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={copyLink} data-sw-view-link>
            <Link2 size={14} aria-hidden="true" /> Copy a link to this view
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {naming ? (
        <form onSubmit={submit} className="flex items-center gap-1.5" data-sw-view-form>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name this view"
            aria-label="Name this view"
            maxLength={60}
            className="h-9"
            wrapperClassName="w-40"
            onKeyDown={(event) => (event.key === 'Escape' ? setNaming(false) : null)}
          />
          <Button type="submit" size="md" variant="default" className="h-9" disabled={!name.trim() || save.isPending}>
            Save
          </Button>
          <Button size="md" variant="ghost" className="h-9" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </form>
      ) : null}
    </>
  )
}
