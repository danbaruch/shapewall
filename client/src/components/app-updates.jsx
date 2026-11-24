import { lazy, Suspense, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Button } from './ui'
import { cn } from '../lib/utils'
import { BUILD, CONTACT_URL, VERSION } from '../lib/app-version'

const AppUpdateDialog = lazy(() => import('./app-update-dialog'))

// "About Shapewall and updates" opens from the profile menu (and the console's
// footer link) with this event; whichever AppUpdates is mounted answers it.
// detail.opener is the control that gets focus back when the dialog closes.
export const OPEN_ABOUT_EVENT = 'shapewall:open-about'
export function openAbout(opener = null) {
  window.dispatchEvent(new CustomEvent(OPEN_ABOUT_EVENT, { detail: { opener } }))
}

// The About and updates dialog; updater logic loads only on request.
// placement:
//   "menu" (default): nothing on screen; the profile menu's About item opens it
//   "link": a quiet "About Shapewall · v0.1.0" text button for a page footer, with a Contact link beside it
//   "footer": the older full-width credit band (kept for embedders)
export function AppUpdates({ transport, className, placement = 'menu', ref }) {
  const [open, setOpen] = useState(false)
  const [activated, setActivated] = useState(false)
  const trigger = useRef(null)
  const opener = useRef(null)
  const show = (from) => {
    opener.current = from || null
    setActivated(true)
    setOpen(true)
  }
  useImperativeHandle(ref, () => ({ open: () => show(document.activeElement) }), [])
  useEffect(() => {
    const onOpen = (event) => show(event.detail?.opener || null)
    window.addEventListener(OPEN_ABOUT_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_ABOUT_EVENT, onOpen)
  }, [])
  const close = () => setOpen(false)
  const restoreFocus = (event) => {
    event.preventDefault()
    const target = [opener.current, trigger.current, document.querySelector('[data-sw-profile-menu]')].find(
      (element) => element?.isConnected && element !== document.body,
    )
    target?.focus()
  }
  const label = `About Shapewall and updates, ${VERSION(BUILD)}, created by Dan Baruch`
  return (
    <>
      {placement === 'footer' ? (
        <footer
          className={cn('flex shrink-0 justify-center border-t border-line bg-surface text-muted', className)}
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        >
          <Button
            variant="ghost"
            size="touch"
            className="gap-2 rounded-none px-3 text-[10px] font-normal lg:h-6"
            onClick={() => show(trigger.current)}
            aria-label={label}
            data-sw-app-about="footer"
            ref={trigger}
          >
            <span>Created by Dan Baruch</span>
            <span aria-hidden="true">·</span>
            <span data-sw-app-version>{VERSION(BUILD)}</span>
          </Button>
        </footer>
      ) : placement === 'link' ? (
        <span className="inline-flex items-center">
          <Button
            asChild
            variant="ghost"
            size="touch"
            className="px-2 text-caption font-normal text-faint hover:text-fg lg:h-8"
            data-sw-app-contact="link"
          >
            <a href={CONTACT_URL} target="_blank" rel="noopener noreferrer">
              Contact
            </a>
          </Button>
          <Button
            variant="ghost"
            size="touch"
            className={cn('gap-1.5 px-2 text-caption font-normal text-faint hover:text-fg lg:h-8', className)}
            onClick={() => show(trigger.current)}
            aria-label={label}
            data-sw-app-about="link"
            ref={trigger}
          >
            <span>About Shapewall</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums" data-sw-app-version>
              v{BUILD.version}
            </span>
          </Button>
        </span>
      ) : null}
      {activated ? (
        <Suspense
          fallback={
            <span role="status" className="sr-only">
              Opening About & Updates…
            </span>
          }
        >
          <AppUpdateDialog open={open} onClose={close} onCloseAutoFocus={restoreFocus} transport={transport} />
        </Suspense>
      ) : null}
    </>
  )
}
