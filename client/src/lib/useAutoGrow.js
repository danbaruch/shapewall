import { useLayoutEffect } from 'react'

// A text field that grows with its text, like a chat composer: at least `min`
// lines, at most `max`, then it scrolls inside itself. Whole lines only (the
// field's line-height must be a length, so set a `leading-*`), with its own
// padding top and bottom, so no line is ever cut at an edge. It follows the
// text (typed, pasted or dictated, interim words included) and the field's
// width; it never reacts to anything else, so a placeholder change or a
// dictation state never moves it.
export function fieldHeight({ lineHeight, padding, border, scrollHeight, min, max }) {
  const low = lineHeight * min + padding + border
  const high = lineHeight * max + padding + border
  const need = scrollHeight + border
  return { height: Math.min(high, Math.max(low, need)), scrolls: need > high + 0.5 }
}

export function useAutoGrow(ref, value, grow) {
  const min = grow?.min ?? 1
  const max = grow?.max ?? 0
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !max) return undefined
    const fit = () => {
      const style = getComputedStyle(element)
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.25
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
      const low = lineHeight * min + padding + border
      const top = element.scrollTop
      // Measured at the smallest height, so deleting text shrinks it back.
      element.style.height = `${low}px`
      const { height, scrolls } = fieldHeight({ lineHeight, padding, border, scrollHeight: element.scrollHeight, min, max })
      element.style.height = `${height}px`
      element.style.overflowY = scrolls ? 'auto' : 'hidden'
      // Past the maximum: the caret stays in view (at the end, the last line).
      if (!scrolls) element.scrollTop = 0
      else if (element.selectionEnd >= element.value.length) element.scrollTop = element.scrollHeight
      else element.scrollTop = top
    }
    fit()
    let width = element.clientWidth
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return
      width = element.clientWidth
      fit()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, value, min, max])
}
