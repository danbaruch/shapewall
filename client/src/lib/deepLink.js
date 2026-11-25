// The deep link keys the board reads once, as it opens (src/board-links.js
// builds them): `p`, the page to fly to, and `follow`, an agent to follow.
// The other keys of a deep link (c, vp, cmp, hist, hv, filter) are the
// board's ordinary address state. Pure, tested in test/board-links.test.js.

const PAGE_RE = /^[A-Za-z0-9][\w:.-]{0,199}$/
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

// The page a link asks to open on, or null. A comment (`c`) or a camera
// (`v`) in the same link wins: the board opens on those instead.
export function linkedPage(params) {
  if (params.get('c') || params.get('v')) return null
  const page = params.get('p')
  return page && PAGE_RE.test(page) ? page : null
}

// The agent a link asks to follow, or null. Read and kept for the follow
// mode; nothing acts on it yet.
export function linkedFollow(params) {
  const id = params.get('follow')
  return id && AGENT_RE.test(id) ? id : null
}
