// The Usage and Activity pages keep their state in the address. This is how
// a change is written into a query string: plain functions with no imports,
// so they are tested on their own (test/usage-address.test.js).

// Filters whose values are never split on commas (whatever an agent called its model).
export const UNSPLIT = ['model']

// A list in a query string: the key repeated, and (ids only) comma lists.
export const readList = (params, key) =>
  params
    .getAll(key)
    .flatMap((value) => (UNSPLIT.includes(key) ? [value] : value.split(',')))
    .filter(Boolean)
// One change applied to a query string. A value may be a function of the
// key's values as the address holds them at that moment: a change that
// depends on what is there (tick one more option, remove one chip) is
// written that way, so two in a row both hold whatever was on screen when
// each was pressed.
export function applyChanges(search, changes) {
  const next = new URLSearchParams(search)
  for (const [key, given] of Object.entries(changes)) {
    const value = typeof given === 'function' ? given(readList(next, key)) : given
    next.delete(key)
    for (const item of Array.isArray(value) ? value : [value])
      if (item !== null && item !== undefined && item !== '' && item !== false) next.append(key, String(item))
  }
  return next.toString()
}
// Adds a value to a list, or removes it when it is there.
export const toggled = (value) => (current) => (current.includes(value) ? current.filter((item) => item !== value) : [...current, value])
