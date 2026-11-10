// Diagnostic environment labels are independent of captured environments.
// They carry no URLs, paths or arbitrary presentation text.
export const CHECK_ENVIRONMENTS_MAX = 8
const id = /^[a-z0-9][a-z0-9-]{0,63}$/
export function validateCheckEnvironments(value) {
  if (!Array.isArray(value) || !value.length || value.length > CHECK_ENVIRONMENTS_MAX)
    throw new Error('Checks need one to eight diagnostic environments.')
  const seen = new Set()
  const environments = value.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      !id.test(item.id) ||
      typeof item.captured !== 'boolean' ||
      Object.keys(item).some((key) => !['id', 'captured'].includes(key)) ||
      seen.has(item.id)
    )
      throw new Error('Invalid diagnostic environment descriptor.')
    seen.add(item.id)
    return { id: item.id, captured: item.captured }
  })
  if (environments.filter((item) => item.captured).length > 1)
    throw new Error('Only one diagnostic environment can identify the hosted capture.')
  return environments
}
export function mergeCheckEnvironments(previous, incoming) {
  const selected = incoming?.find((item) => item.captured)?.id
  const merged = new Map(previous.map((item) => [item.id, { ...item, ...(selected ? { captured: item.id === selected } : {}) }]))
  for (const item of incoming || []) merged.set(item.id, { ...item })
  return validateCheckEnvironments([...merged.values()])
}
