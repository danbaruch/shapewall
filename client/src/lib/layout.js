import { useMediaQuery } from './hooks'

// Which layout the board and the console use: the desktop one (side panels,
// hover tips, compact controls) or the phone one (sheets, 44 px targets,
// touch copy). Width alone put a half-screen desktop window (960 px on a 1920
// screen) on the phone layout, so a mouse-driven window keeps the desktop
// layout down to 700 px, while a touch screen (a tablet, a phone) switches
// below 1024 px as before. Keep in step with the lg / max-lg variants in
// styles.css, which use the same query.
export const DESKTOP_LAYOUT_QUERY = '(min-width: 1024px) or ((min-width: 700px) and (hover: hover) and (pointer: fine))'

// Touch is the input, not the width: a narrow desktop window still gets
// "click" and "scroll" copy, a tablet gets "tap" and "pinch".
export const TOUCH_INPUT_QUERY = '(pointer: coarse), (hover: none)'

// True on a touch screen, for copy that says tap / pinch instead of click / scroll.
export function useTouchInput() {
  return useMediaQuery(TOUCH_INPUT_QUERY)
}
