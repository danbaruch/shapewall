// Small helpers for viewport names ("desktop", "phone", "phone-landscape") and
// the frame keys built from them.
import { Monitor, Smartphone, Tablet } from 'lucide-react'

const ICONS = { desktop: Monitor, tablet: Tablet, phone: Smartphone }

// A custom name ("phone-landscape") takes the icon of its prefix.
export const viewportIcon = (name, fallback = Monitor) => ICONS[name] || ICONS[String(name).split('-')[0]] || fallback

// "phone-landscape" reads "Phone landscape".
export const viewportLabel = (name) => name[0].toUpperCase() + name.slice(1).replace(/-/g, ' ')

// A frame's key is `${targetId}|${viewport}` (a target id may hold a "|"),
// and on one side of a compare card `${targetId}|${viewport}@${env}`
// (commentSide.js frameKey). `env` is null on every other frame.
export function splitFrameKey(key) {
  const at = key.lastIndexOf('|')
  const rest = key.slice(at + 1)
  const sep = rest.indexOf('@')
  return {
    targetId: key.slice(0, at),
    viewport: sep < 0 ? rest : rest.slice(0, sep),
    env: sep < 0 ? null : rest.slice(sep + 1),
  }
}
