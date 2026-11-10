import { Kbd } from '../components/ui'

// A tooltip's text with its keyboard shortcut: "Fit the board  Shift 1".
export function KeyTip({ label, keys }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  )
}
