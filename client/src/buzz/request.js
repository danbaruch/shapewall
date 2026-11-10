export const REQUEST_MAX_BYTES = 12000
export const requestBytes = (text) => new TextEncoder().encode(text).length

// Only a first attempt rejected before gateway dispatch is safely editable.
// An earlier ambiguous attempt retains its UUID even if a later retry fails.
export function editableRejection(error, retrying) {
  return (
    !retrying &&
    error.status >= 400 &&
    error.status < 500 &&
    [
      'invalid_request',
      'json_required',
      'bad_origin',
      'not_found',
      'project_denied',
      'target_denied',
      'rate_limited',
      'bridge_busy',
      'bad_host',
    ].includes(error.code)
  )
}
