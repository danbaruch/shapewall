import { useEffect } from 'react'
import { isIgnoredTypeahead } from '../../components/ui'
import { isEditable } from '../navigation'

// Journey keys: the arrows step through the journey, Esc leaves it.
export function useJourneyKeys({ journey, builder, goStep, step, closeJourney }) {
  useEffect(() => {
    if (!journey || builder) return undefined
    const onKey = (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || document.querySelector('[role="dialog"]')) return
      const target = event.target
      if (target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)) return
      // An open select or menu owns the arrow keys.
      if (target?.closest?.('[role="listbox"], [role="menu"]')) return
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault()
        goStep(step + (event.key === 'ArrowRight' ? 1 : -1))
      }
      // Esc leaves the journey (an open thread or composer closes first).
      if (event.key === 'Escape' && !document.querySelector('[data-sw-thread-popover], [data-sw-composer-popover]')) {
        event.preventDefault()
        closeJourney()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [builder, closeJourney, goStep, journey, step])
}

// Comment mode keys: C turns it on and off, Esc leaves it.
export function useCommentModeKeys({ commentMode, setCommentMode, canComment, comparePair, setDraft, keepDraft }) {
  useEffect(() => {
    if (!commentMode) return undefined
    // Escape leaves comment mode, unless it is closing something first (the
    // composer, a thread, a menu). Read in the capture phase, before those
    // close themselves and leave the page.
    // Not from a text field either (the comment search, the chat box): Escape
    // there is that field's.
    // The key is used up here (preventDefault), so the same Esc does not also
    // leave an open journey: one step at a time, back to Select first.
    const onKey = (event) => {
      if (event.key !== 'Escape' || isEditable(event.target)) return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      event.preventDefault()
      setCommentMode(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [commentMode, setCommentMode])

  // C turns comment mode on and off (not while typing or in a dialog).
  useEffect(() => {
    if (!canComment || comparePair) return undefined
    const onKey = (event) => {
      if ((event.defaultPrevented && !isIgnoredTypeahead(event)) || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return
      if (event.key !== 'c' && event.key !== 'C') return
      const target = event.target
      if (target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)) return
      if (document.querySelector('[role="dialog"]:not([data-sw-thread-popover]), [role="menu"], [role="listbox"]')) return
      event.preventDefault()
      // A comment with something in it is not dropped by a stray C.
      if (keepDraft?.()) return
      setDraft(null)
      setCommentMode((value) => !value)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canComment, comparePair, keepDraft, setCommentMode, setDraft])
}

// J opens the next journey, Shift+J the previous one; past either end the
// board shows all pages again (the Views menu's "None"). Not while typing,
// building a journey or with a dialog, menu or list open.
export function useJourneyCycleKey({ journeys, journey, builder, openJourney, closeJourney }) {
  useEffect(() => {
    if (!journeys.length || builder) return undefined
    const onKey = (event) => {
      if ((event.defaultPrevented && !isIgnoredTypeahead(event)) || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return
      if (event.key !== 'j' && event.key !== 'J') return
      if (isEditable(event.target)) return
      if (document.querySelector('[role="dialog"]:not([data-sw-thread-popover]), [role="menu"], [role="listbox"]')) return
      event.preventDefault()
      const at = journey ? journeys.findIndex((item) => item.id === journey.id) : -1
      // Positions -1 (none) to length - 1, wrapping through none.
      const span = journeys.length + 1
      const next = ((at + 1 + (event.shiftKey ? -1 : 1) + span) % span) - 1
      if (next < 0) closeJourney()
      else openJourney(journeys[next].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [builder, closeJourney, journey, journeys, openJourney])
}
