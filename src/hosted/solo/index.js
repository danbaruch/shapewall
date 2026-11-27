// The solo profile's surfaces (shapewall serve --engine hosted, 1.5.0,
// experimental): the hosted engine run for one project, one owner, on
// loopback. createHostedApp({ solo }) calls mountSolo(app, deps) once, and
// only when `solo` is set; a team server never mounts anything from here.
//
// Every solo-only surface lives in its own file under src/hosted/solo/ and
// is mounted from this function, so a new one never needs src/hosted/app.js:
//
//   app        the Express app. mountSolo runs after the auth routes and the
//              board routes, before the device, token and console APIs and
//              the pages, so a route here answers before /api's session
//              check and the page fallback.
//   deps.boardApi  a router inside the members' board API
//              (/w/:ws/p/:pid/api, session and workspace role already
//              checked, req.t, req.project and req.role set) that answers
//              before that API's catch-all. Never on share or public routes.
//   deps       the rest of the shared state (db, dataDir, auth, events, ...).
//
// mountSolo returns { close() } (optional): app.locals.close() awaits it, so
// a surface that subscribes to the event bus or holds a lease lets go.
//
// Mounted so far: info.js (`solo` and `soloFeatures` on the board's /info,
// G16), events.js (events.jsonl and notifications, G8). A surface the board
// turns on (client/src/board/solo.js) sets its flag in `features`.
import { mountSoloEvents } from './events.js'
import { mountSoloInfo } from './info.js'

export function mountSolo(app, deps) {
  const closers = []
  const features = {}
  mountSoloInfo(deps, features)
  const events = mountSoloEvents(app, deps)
  if (events) closers.push(() => events.close())
  return {
    async close() {
      for (const close of closers.reverse()) await close()
    },
  }
}
