// Configured query parameters can identify distinct UI states. Keep those
// routes working while excluding credential-bearing parameters on transfer.
export function portablePagePath(path) {
  const separator = path.indexOf('?')
  if (separator < 0) return path
  const params = new URLSearchParams(path.slice(separator + 1))
  const sensitive = /(?:token|password|secret|credential|signature|(?:^|[_-])(?:key|auth|code|session|jwt|sig)(?:$|[_-]))/i
  let changed = false
  for (const name of new Set(params.keys())) {
    if (sensitive.test(name)) {
      params.delete(name)
      changed = true
    }
  }
  return changed ? path.slice(0, separator) + (params.size ? '?' + params : '') : path
}
