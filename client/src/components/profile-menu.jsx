// The profile menu in the main nav of the board and the console: who you are,
// account links, the workspace switcher (console), View as (the public demo
// only), Appearance (light, dark or system, and a theme), remembered in this
// browser for every Shapewall page, About Shapewall and updates, and Contact.

import { Fragment, useRef } from 'react'
import { Check, Info, Mail, Monitor, Moon, Sun } from 'lucide-react'
import {
  Avatar,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui'
import { MODES, THEMES, useAppearance } from '../lib/theme'
import { cn } from '../lib/utils'
import { BUILD, CONTACT_URL } from '../lib/app-version'
import { openAbout } from './app-updates'

// Appearance picks apply at once and leave the menu open to compare.
const keepOpen = (event) => event.preventDefault()
const MODE_ICONS = { light: Sun, dark: Moon, system: Monitor }
const tile =
  'h-11 justify-center gap-1.5 rounded-md border border-transparent px-1 text-xs lg:h-9 data-[state=checked]:border-accent data-[state=checked]:bg-accent/10 data-[state=checked]:text-fg'

// items: [{ id, label, icon, onSelect, tone, disabled, hint, ...data attributes }]; a hint is a line under the item
// workspaces: { list: [{ id, name, role, roleLabel }], current, onPick }
// viewAs: { value, options: [{ id, label, hint }], onChange }
export function ProfileMenu({
  name,
  avatarUrl = null,
  detail = null,
  items = [],
  workspaces = null,
  viewAs = null,
  showName = false,
  label = 'Profile and appearance',
  about = true,
  triggerClassName,
  // Where the menu opens: under the trigger (the top bars) or beside it (the app rail).
  side = 'bottom',
  align = 'end',
  ...triggerProps
}) {
  const [appearance, setAppearance] = useAppearance()
  const trigger = useRef(null)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          variant="ghost"
          size="touch"
          className={cn('shrink-0 gap-2 px-1.5 lg:h-10', triggerClassName)}
          aria-label={name ? `${label}: ${name}` : label}
          data-sw-profile-menu
          {...triggerProps}
        >
          <Avatar name={name || '?'} src={avatarUrl} className="h-8 w-8" />
          {showName && name ? <span className="hidden max-w-40 truncate text-sm text-fg md:inline">{name}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72" side={side} align={align} data-sw-profile-content>
        {name || detail ? (
          <DropdownMenuLabel className="normal-case">
            {name ? <span className="block truncate text-[13px] font-medium tracking-normal text-fg">{name}</span> : null}
            {detail ? <span className="block truncate text-xs font-normal tracking-normal text-muted">{detail}</span> : null}
          </DropdownMenuLabel>
        ) : null}
        {items.length ? (
          <>
            {name || detail ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup>
              {items.map(({ id, label: itemLabel, icon: Icon, onSelect, tone, hint, ...rest }) => (
                <Fragment key={id}>
                  <DropdownMenuItem
                    onSelect={onSelect}
                    tone={tone}
                    data-sw-profile-item={id}
                    aria-describedby={hint ? 'sw-profile-hint-' + id : undefined}
                    {...rest}
                  >
                    {Icon ? <Icon size={14} aria-hidden="true" /> : null} {itemLabel}
                  </DropdownMenuItem>
                  {/* Outside the (possibly disabled, dimmed) item, so it stays readable. */}
                  {hint ? (
                    <p id={'sw-profile-hint-' + id} className="px-2 pb-1.5 text-xs text-muted" data-sw-profile-hint={id}>
                      {hint}
                    </p>
                  ) : null}
                </Fragment>
              ))}
            </DropdownMenuGroup>
          </>
        ) : null}
        {workspaces?.list?.length ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Workspace</DropdownMenuLabel>
            {workspaces.list.map((item) => (
              <DropdownMenuItem key={item.id} onSelect={() => workspaces.onPick(item.id)} data-sw-profile-workspace={item.id}>
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                {item.roleLabel ? <span className="text-xs text-faint">{item.roleLabel}</span> : null}
                {item.id === workspaces.current ? <Check size={14} className="!text-accent" aria-label="Current" /> : null}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        {viewAs ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>View as (demo)</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={viewAs.value} onValueChange={viewAs.onChange}>
              {viewAs.options.map((option) => (
                <DropdownMenuRadioItem key={option.id} value={option.id} data-sw-view-as={option.id}>
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.hint ? <span className="truncate text-xs text-faint">{option.hint}</span> : null}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={appearance.mode}
          onValueChange={(mode) => setAppearance({ mode })}
          className="grid grid-cols-3 gap-1 px-1 pb-1"
          aria-label="Mode"
        >
          {MODES.map((mode) => {
            const Icon = MODE_ICONS[mode.id]
            return (
              <DropdownMenuRadioItem
                key={mode.id}
                value={mode.id}
                indicator={false}
                className={tile}
                onSelect={keepOpen}
                data-sw-appearance-mode={mode.id}
              >
                <Icon size={14} aria-hidden="true" /> {mode.label}
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
        <DropdownMenuRadioGroup
          value={appearance.theme}
          onValueChange={(theme) => setAppearance({ theme })}
          className="grid grid-cols-2 gap-1 px-1 pb-1"
          aria-label="Theme"
        >
          {THEMES.map((theme) => (
            <DropdownMenuRadioItem
              key={theme.id}
              value={theme.id}
              indicator={false}
              className={cn(tile, 'justify-start px-2')}
              onSelect={keepOpen}
              data-sw-theme-option={theme.id}
            >
              <span className={cn('h-4 w-4 shrink-0 rounded-full ring-1 ring-line', `sw-swatch-${theme.id}`)} aria-hidden="true" />
              <span className="truncate">{theme.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {about ? (
          <>
            <DropdownMenuSeparator />
            {/* The dialog lives in AppUpdates, mounted by the board and the console. */}
            <DropdownMenuItem onSelect={() => openAbout(trigger.current)} data-sw-app-about="menu">
              <Info size={14} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">About Shapewall and updates</span>
              <span className="text-caption text-faint tabular-nums" data-sw-app-version>
                v{BUILD.version}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem asChild data-sw-app-contact="menu">
              <a href={CONTACT_URL} target="_blank" rel="noopener noreferrer">
                <Mail size={14} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">Contact</span>
              </a>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
