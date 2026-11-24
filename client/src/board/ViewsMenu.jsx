import { Check, Eye, GitCompare, Link2Off, Map as MapIcon, Plus, Route, Search, Waypoints, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { cn } from '../lib/utils'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Input,
  Kbd,
  Tooltip,
} from '../components/ui'
import { KeyTip } from './KeyTip'

// More journeys than this: the list scrolls inside the menu and gets a filter.
export const JOURNEY_LIST_MAX = 8
export const JOURNEY_KEY = 'J'
const NONE = '__none'

// "4 steps", or the number of paths of a journey that forks.
export function journeyMeta(item) {
  if (item.branching) return `${item.paths?.length || 2} paths`
  const count = item.steps?.length || 0
  return `${count} ${count === 1 ? 'step' : 'steps'}`
}

// The board's Views menu, the one place for what the canvas shows: which
// journey (none, or one by name), then the layers to show (links between
// pages, compare, the minimap), then the broken links of the last capture.
// While a journey is open the button carries its name and a clear button,
// so the state shows without opening anything. The journey itself lives in
// the URL (`j`), shared with the sidebar's Journeys list and the palette.
export function ViewsMenu({
  journeys = [],
  journey,
  openJourney,
  closeJourney,
  canEditJourneys,
  startBuilder,
  showLinks,
  toggleLinks,
  linksTip,
  brokenLinks,
  openBrokenLinks,
  canCompare,
  comparePair,
  toggleCompare,
  minimapOn,
  toggleMinimap,
  compact,
  // The toolbar's quiet box (BoardToolbar BOXED), worn while no journey is open.
  boxed = 'text-fg',
  labelMax = 160,
}) {
  const [query, setQuery] = useState('')
  const afterClose = useRef(null)
  const on = [showLinks, Boolean(comparePair)].filter(Boolean).length
  const broken = brokenLinks.length
  const filtering = journeys.length > JOURNEY_LIST_MAX
  const needle = query.trim().toLowerCase()
  const shown = filtering && needle ? journeys.filter((item) => item.name.toLowerCase().includes(needle)) : journeys
  const listRef = useRef(null)
  const item = 'pr-2'
  const check = (value) => (
    <span className={cn('ml-auto inline-flex h-4 w-4 items-center justify-center', value ? '!text-accent' : 'opacity-0')}>
      <Check size={14} className="!text-accent" aria-hidden="true" />
    </span>
  )
  const brokenText = broken ? `${broken} broken link${broken === 1 ? '' : 's'}` : null
  const state = [on ? `${on} on` : null, brokenText].filter(Boolean).join(', ')
  // With a journey open its full name leads, also when the button truncates
  // it (the tooltip says it in full too).
  const label = journey ? `Journey: ${journey.name}. Views` : state ? `Views, ${state}` : 'Views'
  const tip = journey ? (
    <KeyTip label={`Journey: ${journey.name}. Open Views to switch`} keys={[JOURNEY_KEY]} />
  ) : journeys.length ? (
    <KeyTip label="Views: journeys, links between pages, compare, minimap" keys={[JOURNEY_KEY]} />
  ) : (
    'Views: links between pages, compare, minimap'
  )
  const active = Boolean(journey)
  const trigger = (
    <Button
      variant={active ? 'soft' : 'ghost'}
      className={cn(
        'relative h-8 shrink-0 text-[13px]',
        compact ? 'w-8 px-0' : 'px-2.5',
        active ? (compact ? '' : 'rounded-r-none') : boxed,
      )}
      aria-label={label}
      data-sw-view-menu="true"
      data-sw-view-journey={journey?.id}
    >
      {active ? <Route size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
      {compact ? null : active ? (
        <span className="block truncate" style={{ maxWidth: labelMax }} data-sw-view-journey-name="true">
          {journey.name}
        </span>
      ) : (
        'Views'
      )}
      {broken ? (
        // Broken links found by the last capture: the one alarm on the button.
        <span
          className="pointer-events-none absolute -top-1.5 -right-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-bad px-1 text-[10px] leading-4 font-semibold text-bad-fg tabular"
          aria-hidden="true"
          data-sw-broken-links-badge={broken}
        >
          {broken}
        </span>
      ) : active && compact ? (
        <span
          className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-surface"
          aria-hidden="true"
          data-sw-view-on="journey"
        />
      ) : on && !active ? (
        // Something under Show is on: a quiet dot, not a count.
        <span
          className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-muted ring-2 ring-surface"
          aria-hidden="true"
          data-sw-view-on={on}
        />
      ) : null}
    </Button>
  )
  return (
    <div className="flex shrink-0 items-center" data-sw-views="true">
      <DropdownMenu onOpenChange={(open) => (open ? null : setQuery(''))}>
        <Tooltip content={tip} side="bottom">
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          className="w-80"
          onCloseAutoFocus={(event) => {
            // Back to the canvas, so the next shortcut reaches the board, or
            // on to what the chosen item opens.
            event.preventDefault()
            const next = afterClose.current
            afterClose.current = null
            if (next) next()
            else document.querySelector('[data-sw-canvas]')?.focus({ preventScroll: true })
          }}
          data-sw-views-menu="true"
        >
          {journeys.length || canEditJourneys ? (
            <>
              <DropdownMenuLabel className="flex items-center gap-2">
                Journeys
                {journeys.length ? (
                  <span className="ml-auto inline-flex items-center gap-1 font-normal tracking-normal normal-case">
                    Next <Kbd>{JOURNEY_KEY}</Kbd>
                  </span>
                ) : null}
              </DropdownMenuLabel>
              {filtering ? (
                <div className="px-1 pb-1">
                  <Input
                    size="xs"
                    icon={Search}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Filter journeys"
                    aria-label="Filter journeys"
                    data-sw-views-filter="true"
                    onKeyDown={(event) => {
                      // Typing stays in the field (the menu would jump to an item).
                      if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        listRef.current?.querySelector('[role="menuitemradio"]')?.focus()
                      } else if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation()
                    }}
                  />
                </div>
              ) : null}
              <DropdownMenuRadioGroup
                ref={listRef}
                value={journey?.id || NONE}
                onValueChange={(value) => (value === NONE ? closeJourney() : openJourney(value))}
                className={filtering ? 'max-h-72 overflow-y-auto' : undefined}
                aria-label="Journeys"
                data-sw-views-journeys={journeys.length}
              >
                {!needle ? (
                  <DropdownMenuRadioItem value={NONE} data-sw-views-journey="none">
                    <Eye size={15} aria-hidden="true" /> None
                    <span className="ml-auto text-caption text-faint">All pages</span>
                  </DropdownMenuRadioItem>
                ) : null}
                {shown.map((entry) => (
                  <DropdownMenuRadioItem key={entry.id} value={entry.id} data-sw-views-journey={entry.id}>
                    <Route size={15} aria-hidden="true" />
                    <span className="min-w-0 truncate">{entry.name}</span>
                    <span className="ml-auto shrink-0 pl-2 text-caption text-faint tabular-nums">{journeyMeta(entry)}</span>
                  </DropdownMenuRadioItem>
                ))}
                {needle && !shown.length ? <p className="px-2 py-1.5 text-xs text-muted">No journey matches.</p> : null}
              </DropdownMenuRadioGroup>
              {canEditJourneys ? (
                <DropdownMenuItem className={item} onSelect={() => startBuilder()} data-sw-views-new-journey="true">
                  <Plus size={15} aria-hidden="true" /> New journey
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuLabel>Show</DropdownMenuLabel>
          <DropdownMenuItem
            className={item}
            role="menuitemcheckbox"
            aria-checked={showLinks}
            onSelect={toggleLinks}
            data-sw-links-toggle="true"
          >
            <Waypoints size={15} aria-hidden="true" />
            Links between pages
            {check(showLinks)}
          </DropdownMenuItem>
          {canCompare ? (
            <DropdownMenuItem
              className={item}
              role="menuitemcheckbox"
              aria-checked={Boolean(comparePair)}
              onSelect={toggleCompare}
              data-sw-compare-toggle="true"
            >
              <GitCompare size={15} aria-hidden="true" /> Compare environments
              {check(Boolean(comparePair))}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem className={item} role="menuitemcheckbox" aria-checked={minimapOn} onSelect={toggleMinimap}>
            <MapIcon size={15} aria-hidden="true" /> Minimap
            {check(minimapOn)}
          </DropdownMenuItem>
          {broken ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className={item}
                onSelect={() => {
                  if (!showLinks) toggleLinks()
                  afterClose.current = openBrokenLinks
                }}
                data-sw-broken-links-open="true"
              >
                <Link2Off size={15} className="!text-bad" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block">Broken links</span>
                  <span className="block text-caption text-muted">
                    {broken} {broken === 1 ? 'link leads' : 'links lead'} to an error
                  </span>
                </span>
                <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-bad px-1.5 text-[11px] leading-5 font-semibold text-bad-fg tabular">
                  {broken}
                </span>
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuSeparator />
          <p className="px-2 py-1.5 text-xs text-muted">{linksTip}.</p>
        </DropdownMenuContent>
      </DropdownMenu>
      {active && !compact ? (
        <IconButton
          variant="soft"
          className="h-8 w-7 shrink-0 -ml-px rounded-l-none"
          onClick={closeJourney}
          label="Leave journey"
          tooltip={<KeyTip label="Leave the journey" keys={['Esc']} />}
          side="bottom"
          data-sw-view-journey-clear="true"
        >
          <X size={14} aria-hidden="true" />
        </IconButton>
      ) : null}
    </div>
  )
}
