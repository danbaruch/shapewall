import { cn } from '../lib/utils'

// One composer box, like a chat app's: a single rounded container with one
// border and one focus ring, the text on top (it grows with its text, then
// scrolls: lib/useAutoGrow.js) and a row of actions along the bottom inside
// the same container -- the tools (attach, draw) on the left, the microphone
// and the send button on the right, send rightmost. Used by the new-comment
// composer, the reply box and the edit box. While dictation listens the
// container takes the accent ring; toggling it never moves anything (the
// ring is a shadow, the row is always there).
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
      <div className={cn('flex items-center', touch ? 'gap-1 px-1.5 pb-1.5' : 'gap-0.5 px-1 pb-1')} data-sw-composer-actions="true">
        <div className="flex min-w-0 flex-1 items-center gap-0.5" {...toolsProps}>
          {tools}
        </div>
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      </div>
    </div>
  )
}

// The text area inside the box: no border of its own (the box has it), the
// same padding left and right as the row's first button, whole lines.
export const composerFieldClass = (touch) =>
  cn('resize-none rounded-none border-0 bg-transparent shadow-none', touch ? 'min-h-0 px-3' : 'px-2.5')
