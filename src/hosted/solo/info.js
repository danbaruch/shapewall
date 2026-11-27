// The solo engine's board /info (G16): the members' /info answers as on a
// team server, plus `solo: true` and `soloFeatures`, the local-only surfaces
// this engine serves (client/src/board/solo.js turns them on for the owner).
// A team server never mounts this, so its /info never carries either field.
//
// `features` is the object mountSolo fills as each surface mounts (for
// example appUpdates from update.js); it is read per request, so a surface
// mounted after this one still shows.
export function mountSoloInfo(deps, features) {
  if (!deps.boardApi) return
  deps.boardApi.get('/info', (req, res, next) => {
    const json = res.json.bind(res)
    res.json = (body) => {
      if (res.statusCode !== 200 || !body || typeof body !== 'object' || Array.isArray(body)) return json(body)
      return json({ ...body, solo: true, soloFeatures: { ...features } })
    }
    next()
  })
}
