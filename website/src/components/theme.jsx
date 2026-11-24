import { useEffect, useId, useRef, useState } from 'react'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { IconButton, cx } from './ui.jsx'
import { setChoice, useThemeChoice } from '../theme.js'

const OPTIONS = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
]

// Three labelled buttons in a row (footer and mobile menu). The pressed one is the current choice.
export function ThemeSwitch({ className }) {
  const choice = useThemeChoice()
  return (
    <div
      className={cx('inline-flex rounded-xl border border-line bg-sunk p-1 text-[13.5px] font-medium', className)}
      role="group"
      aria-label="Theme"
    >
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={choice === option.id}
          onClick={() => setChoice(option.id)}
          className={cx(
            'inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 transition-colors',
            choice === option.id ? 'bg-card text-ink shadow-sm ring-1 ring-line-strong' : 'text-slate hover:text-ink',
          )}
        >
          <option.icon className="size-4" aria-hidden="true" />
          {option.label}
        </button>
      ))}
    </div>
  )
}

// The header control: an icon button that opens a small menu of the three choices.
export function ThemeMenu({ className }) {
  const choice = useThemeChoice()
  const [open, setOpen] = useState(false)
  const wrap = useRef(null)
  const button = useRef(null)
  const menu = useRef(null)
  const id = useId()
  const current = OPTIONS.find((option) => option.id === choice) || OPTIONS[0]

  useEffect(() => {
    if (!open) return
    const items = () => [...menu.current.querySelectorAll('[role="menuitemradio"]')]
    ;(items().find((item) => item.getAttribute('aria-checked') === 'true') || items()[0])?.focus()
    const close = (refocus) => {
      setOpen(false)
      if (refocus) button.current?.focus()
    }
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close(true)
        return
      }
      if (event.key === 'Tab') return close(false)
      const list = items()
      const at = list.indexOf(document.activeElement)
      let next = null
      if (event.key === 'ArrowDown') next = list[(at + 1) % list.length]
      if (event.key === 'ArrowUp') next = list[(at - 1 + list.length) % list.length]
      if (event.key === 'Home') next = list[0]
      if (event.key === 'End') next = list[list.length - 1]
      if (next) {
        event.preventDefault()
        next.focus()
      }
    }
    const onPointer = (event) => {
      if (!wrap.current?.contains(event.target)) close(false)
    }
    const node = wrap.current
    node.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      node.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open])

  return (
    <div ref={wrap} className={cx('relative', className)}>
      <IconButton
        ref={button}
        variant="ghost"
        size="icon"
        label={'Theme: ' + current.label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <current.icon className="size-[18px]" aria-hidden="true" />
      </IconButton>
      <div
        ref={menu}
        id={id}
        role="menu"
        aria-label="Theme"
        hidden={!open}
        className="absolute top-12 right-0 z-50 w-40 rounded-xl border border-line bg-card p-1.5 shadow-xl shadow-black/10"
      >
        {OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="menuitemradio"
            aria-checked={choice === option.id}
            onClick={() => {
              setChoice(option.id)
              setOpen(false)
              button.current?.focus()
            }}
            className={cx(
              'flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14.5px] font-medium hover:bg-ink/5',
              choice === option.id ? 'text-ink' : 'text-slate hover:text-ink',
            )}
          >
            <option.icon className="size-4" aria-hidden="true" />
            <span className="flex-1">{option.label}</span>
            {choice === option.id ? <Check className="size-4 text-wall" aria-hidden="true" /> : null}
          </button>
        ))}
      </div>
    </div>
  )
}
