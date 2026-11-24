// Small text helpers shared by the chat modules.

export function excerpt(text, max = 48) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
