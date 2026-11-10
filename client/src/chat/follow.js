// Scrolling like the main chat apps: the list follows a reply as it grows
// while the reader is at the bottom, stops following the moment they scroll
// up (wheel, touch, keys or the scrollbar), and offers "Jump to latest"
// until they are back at the bottom.
import { useCallback, useEffect, useRef, useState } from 'react'

// Within this many px of the bottom counts as at the bottom.
const NEAR = 48
// "Jump to latest" shows once the newest content is this far below.
const JUMP_AFTER = 160
const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

export function useFollowScroll(listRef, resetKey) {
  const stick = useRef(true)
  // Where the list was last seen: only a move up stops following (content
  // that grew before the scroll event arrived is not the reader leaving).
  const lastTop = useRef(0)
  const touchY = useRef(null)
  const [showJump, setShowJump] = useState(false)

  const distance = () => {
    const list = listRef.current
    return list ? list.scrollHeight - list.scrollTop - list.clientHeight : 0
  }
  const follow = useCallback(() => {
    const list = listRef.current
    if (!list) return
    if (stick.current) {
      list.scrollTop = list.scrollHeight
      lastTop.current = list.scrollTop
    } else setShowJump(list.scrollHeight - list.scrollTop - list.clientHeight > JUMP_AFTER)
  }, [listRef])

  // Every size change of the content (streamed text, cards, images loading):
  // a callback ref for the element inside the scrolling list.
  const observer = useRef(null)
  const contentRef = useCallback(
    (node) => {
      observer.current?.disconnect()
      observer.current = null
      if (!node || typeof ResizeObserver === 'undefined') return
      observer.current = new ResizeObserver(follow)
      observer.current.observe(node)
    },
    [follow],
  )

  // Another thread: start at its bottom.
  useEffect(() => {
    stick.current = true
    setShowJump(false)
    follow()
  }, [resetKey, follow])

  // An upward wheel, swipe or key stops following only when the list can
  // actually move up: on a list that does not overflow yet (or is already at
  // its top) nothing scrolls, so the next reply should still be followed.
  const leave = () => {
    const list = listRef.current
    if (list && list.scrollHeight - list.clientHeight > 1 && list.scrollTop > 0) stick.current = false
  }
  const onScroll = () => {
    const list = listRef.current
    if (!list) return
    const away = distance()
    if (away < NEAR) stick.current = true
    else if (list.scrollTop < lastTop.current - 1) stick.current = false
    lastTop.current = list.scrollTop
    setShowJump(!stick.current && away > JUMP_AFTER)
    // Scrolled down: the top edge fades (see the list's className).
    list.dataset.swScrolled = String(list.scrollTop > 2)
  }
  const handlers = {
    onScroll,
    onWheel: (event) => {
      if (event.deltaY < 0) leave()
    },
    onTouchStart: (event) => {
      touchY.current = event.touches[0]?.clientY ?? null
    },
    onTouchMove: (event) => {
      const y = event.touches[0]?.clientY
      // The finger moves down: the content scrolls up, toward older messages.
      if (touchY.current !== null && y > touchY.current + 4) leave()
    },
    onKeyDown: (event) => {
      if (UP_KEYS.has(event.key)) leave()
    },
  }
  // Follow from now on (the person sent something, or asked to).
  const stickNow = useCallback(() => {
    stick.current = true
    setShowJump(false)
    follow()
  }, [follow])
  const jump = () => {
    const list = listRef.current
    if (!list) return
    stick.current = true
    setShowJump(false)
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    list.scrollTo({ top: list.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }
  return { contentRef, handlers, showJump, jump, stickNow, follow }
}
