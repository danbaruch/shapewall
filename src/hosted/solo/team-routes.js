// Team mode's routes on the owner's app (src/hosted/solo/team.js has the
// listener): the console's Invite people, `serve --team` against a running
// engine, and the rules for invites on the engine.
//
//   GET  /solo/team          the owner, here: { on, origin, saved, problem, lines }
//   POST /solo/team          the owner, here: { on: true | false, httpsPort? }. Turning
//                            it on is the fixed core: the typed confirmation of the
//                            workspace's name (passkeys are off on the engine), as for
//                            the console's other always-asking actions. Off asks nothing
//                            (it only narrows who can reach the board).
//   POST /solo/team-switch   the command line in the folder (`serve --team [off]`
//                            while the engine runs): this start's key from
//                            solo-open.key, from this machine and this OS user, not
//                            from a page (signin.js keyAdmits), as /solo/open-link.
//
// "The owner, here": the session is the engine owner's, and the request is
// one the sign-in gate admits (this machine, this OS user on Linux, the
// engine's own host, no proxy headers). A member never reaches this app: the
// team listener is another port, and none of this is mounted there.
//
// Invites on the engine (before the console API's own route):
//   - only while team mode is on (nobody could take one otherwise);
//   - only by the owner, here, with the fixed core's check, whatever the role;
//   - never for the owner role, and nobody is made an owner: the engine keeps
//     its one owner (signin.js ensureSoloOwner refuses a folder with two).
// On the team listener every invite is refused (team.js teamFilter).
import express from 'express'
import { tenant } from '../tenancy.js'
import { DEFAULT_TEAM_PORT, SoloTeamError, teamPortProblem } from './team.js'

export function mountSoloTeamRoutes(
  app,
  { db, owner, localGate, keyAdmits, guardWrites, needSession, coreFreshOrThrow, fail, auditOf, log },
) {
  const json = express.json({ limit: '4kb' })
  const ownerHere = (req) => Boolean(req.user?.id && req.user.id === owner.userId && localGate?.admits(req))
  const team = (req) => req.app.locals.soloTeam || null
  const noStore = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  }
  const refuse = (res, error) => fail(res, error.statusCode, error.code, error.message, error.extra)
  const view = (controller) => ({ ...controller.status(), lines: controller.lines() })
  const notHere = (res) =>
    fail(res, 403, 'not_owner_here', 'Only the engine’s owner, on the machine that runs it, changes who can reach it.')
  const unavailable = (res) => fail(res, 404, 'team_unavailable', 'Team mode is not available on this engine.')

  // The switch from a body ({ on, httpsPort }); `confirm` runs before turning it on (throws a refusal).
  async function change(req, res, controller, confirm) {
    const on = req.body?.on
    if (typeof on !== 'boolean') return fail(res, 400, 'invalid_body', 'Send { "on": true } or { "on": false }.')
    const rawPort = req.body?.httpsPort ?? controller.status().httpsPort ?? DEFAULT_TEAM_PORT
    if (on && teamPortProblem(rawPort)) return fail(res, 400, 'invalid_port', teamPortProblem(rawPort))
    const httpsPort = Number(rawPort)
    const before = controller.status()
    const unchanged = on ? before.on && before.httpsPort === httpsPort : !before.on
    try {
      if (on && !unchanged) confirm?.()
      if (on) await controller.start({ httpsPort })
      else await controller.stop()
    } catch (error) {
      if (error instanceof SoloTeamError) return fail(res, 409, 'team_unavailable', error.message)
      if (error?.statusCode && error.code) return refuse(res, error)
      log(`team mode: ${error.message}`)
      return fail(res, 500, 'error', 'Something went wrong on the server.')
    }
    if (!unchanged) {
      const t = tenant(db, owner.workspaceId)
      auditOf(req, on ? 'team_mode_on' : 'team_mode_off', owner.projectId, on ? { origin: controller.status().origin } : {}, t)
      log(on ? `Team mode: on, at ${controller.status().origin}.` : 'Team mode: off. The board is on this machine only again.')
      if (on) for (const line of controller.lines()) log(line)
    }
    return res.json(view(controller))
  }

  app.get('/solo/team', noStore, needSession, (req, res) => {
    if (!ownerHere(req)) return notHere(res)
    const controller = team(req)
    if (!controller) return unavailable(res)
    res.json(view(controller))
  })
  app.post('/solo/team', noStore, guardWrites, json, needSession, async (req, res) => {
    if (!ownerHere(req)) return notHere(res)
    const controller = team(req)
    if (!controller) return unavailable(res)
    await change(req, res, controller, () => coreFreshOrThrow(req, owner.workspaceId))
  })
  app.post('/solo/team-switch', noStore, json, async (req, res) => {
    if (!keyAdmits(req)) return fail(res, 403, 'forbidden', 'Not from this machine.')
    const controller = team(req)
    if (!controller) return unavailable(res)
    await change(req, res, controller, null)
  })

  // ---- Invites and roles on the engine ----
  app.post('/api/workspaces/:ws/invites', noStore, guardWrites, json, needSession, (req, res, next) => {
    if (!team(req)?.status().on)
      return fail(
        res,
        409,
        'team_off',
        'Nobody but you can reach this board yet. Turn on team mode first: Invite people in the console, or shapewall serve --team.',
      )
    if (!ownerHere(req)) return fail(res, 403, 'owner_invites', 'Only the engine’s owner invites people, on the machine that runs it.')
    if (req.body?.role === 'owner')
      return fail(res, 403, 'one_owner', 'The engine keeps one owner, you. Invite people as admins, members or viewers.')
    // The owner's step-up: on the engine (passkeys off) the typed confirmation of the workspace's name.
    try {
      coreFreshOrThrow(req, String(req.params.ws || ''))
    } catch (error) {
      if (error?.statusCode && error.code) return refuse(res, error)
      throw error
    }
    next()
  })
  app.patch('/api/workspaces/:ws/members/:uid', noStore, guardWrites, json, (req, res, next) => {
    if (req.body?.role === 'owner') return fail(res, 403, 'one_owner', 'The engine keeps one owner. Make them an admin instead.')
    next()
  })
}
