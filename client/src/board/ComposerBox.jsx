import { cn } from '../lib/utils'

// One composer box, like a chat app's: a single rounded container with one
// border and one focus ring, the text on top (it grows with its text, then
// scrolls: lib/useAutoGrow.js) and a row of actions along the bottom inside
// the same container -- the tools (attach, draw) on the left, the microphone
// and the send button on the right, send rightmost. Used by the new-comment
// composer, the reply box and the edit box. While dictation listens the
// container takes the accent ring; toggling it never moves anything (the
// ring is a shadow, the row is always there). Nothing in the row ever
// covers or clips another control (comment-media.e2e checks the boxes).
export function ComposerBox({ touch, listening = false, children, tools = null, actions, toolsProps = {}, className, ...props }) {
  return (
    <div
      className={cn(
        'rounded-lg border border-line bg-surface transition-[border-color,box-shadow] duration-(--motion-base) ease-out focus-within:border-accent/60',
        listening && 'border-accent ring-3 ring-accent/15',
        className,
      )}
      data-sw-composer-box={listening ? 'listening' : 'idle'}
      {...props}
    >
      {children}
      {/* Desktop: the row wraps. When the tools (a full drawing row, a
          narrow card, wide fonts) leave no room for the microphone and the
          send button, those move to a line of their own, still rightmost,
          rather than sit over a tool. On a phone the row keeps one line:
          its tools are one button and a label that shortens. */}
      <div
        className={cn('flex items-center', touch ? 'gap-1 px-1.5 pb-1.5' : 'flex-wrap gap-x-0.5 gap-y-1 px-1 pb-1')}
        data-sw-composer-actions="true"
      >
        {/* flex-auto, not flex-1, on a desktop: the row breaks by the
            tools' whole width, so they keep one line where the card has it. */}
        <div className={cn('flex min-w-0 items-center gap-0.5', touch ? 'flex-1' : 'flex-auto')} {...toolsProps}>
          {tools}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>
      </div>
    </div>
  )
}

// The text area inside the box: no border of its own (the box has it), the
// same padding left and right as the row's first button, whole lines.
export const composerFieldClass = (touch) =>
  cn('resize-none rounded-none border-0 bg-transparent shadow-none', touch ? 'min-h-0 px-3' : 'px-2.5')
