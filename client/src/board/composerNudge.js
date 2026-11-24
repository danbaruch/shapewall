import { reducedMotion } from '../lib/motion'

// The open new-comment composer shakes once and takes the keyboard back:
// "your comment is still here". Used whenever something would otherwise
// replace a comment that already has text, an image or a drawing in it (a
// click elsewhere on the page, another pin, a row in the comments list, C).
export function nudgeComposer() {
  const box = document.querySelector('[data-sw-composer-popover]')
  if (!box) return
  box.setAttribute('data-sw-composer-nudged', String(Date.now()))
  if (!reducedMotion()) {
    box.animate?.([{ translate: '0' }, { translate: '-6px' }, { translate: '5px' }, { translate: '-3px' }, { translate: '0' }], {
      duration: 280,
      easing: 'ease-out',
    })
  }
  box.querySelector('[data-sw-comment-input]')?.focus({ preventScroll: true })
}
