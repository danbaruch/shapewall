// Capturing from the board (src/hosted/board-routes.js), for every board
// router. A hosted board never captures: it is updated with shapewall push.
import { fail } from './http.js'

export function mountCaptureRoutes(router) {
  router.all('/boards/:bid/capture', (req, res) => fail(res, 403, 'capture_disabled', 'Hosted boards are updated with shapewall push.'))
}
